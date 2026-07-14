import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { escapeHtml } from '@wikistead/macro-render'
import {
  savePendingAuthorize, consumePendingAuthorize, peekPendingAuthorize, saveAuthCode, redirectWithParams,
} from '../auth/mcp-oauth-store.js'
import { resolveClient, validateAuthorizeRequest, AuthorizeDirectError, AuthorizeRedirectError } from './mcp-oauth-authorize.js'

// #311 / ADR-131 slice 3b + #391 / ADR-148: the MCP OAuth authorization-code flow — the endpoints that turn a
// validated authorize request into a one-time code, delegating the actual LOGIN to the tenant's existing OIDC
// (/auth/login → /auth/callback). NO access token is minted here (slice 4 does that at /token). PKCE is carried
// (the code_challenge is stored on the auth code) and VERIFIED only at the token exchange (RFC 7636).
//
// Flow:
//   GET /mcp/oauth/authorize  (public: no session yet) → validate (slice 3a) → stash the validated request in
//     Valkey (consume-once) → redirect to /auth/login with returnTo=/mcp/oauth/complete. An unknown client /
//     unregistered redirect_uri is a DIRECT 400 (never redirected — open-redirect defense); any other invalid
//     param bounces to the CONFIRMED redirect_uri with ?error=...&state=... .
//   GET /mcp/oauth/complete   (MEMBER: the session cookie is set by /auth/callback) → PEEK the pending request
//     (non-destructive — ADR-148) and render the CONSENT page (client name, redirect host, requested scopes,
//     Approve/Deny). Mints NOTHING; login is no longer implicit approval (#391).
//   POST /mcp/oauth/consent   (MEMBER) → re-run every /complete check, GETDEL-consume the pending, then either
//     mint the one-time code bound to (sub, tenant, client, redirect_uri, code_challenge) and redirect with
//     ?code=...&state=..., or (Deny) redirect with ?error=access_denied&state=... (RFC 6749 §4.1.2.1).

const randomToken = () => randomBytes(32).toString('base64url')

// The flow-binding cookie (login-CSRF / auth-code-injection defense). httpOnly + SameSite=Lax so it rides the
// top-level GET redirect chain (authorize → /auth/login → /auth/callback → /complete) but is not readable by JS
// nor sent on a cross-site sub-request. Path is broad enough to survive the /auth round-trip and return to
// /mcp/oauth/complete. Short-lived (matches the pending TTL).
const FLOW_COOKIE = 'mcp_flow'
const flowCookieOptions = () => ({ httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', maxAge: 600 })

interface AuthorizeQuery {
  client_id?: string; redirect_uri?: string; response_type?: string
  code_challenge?: string; code_challenge_method?: string; scope?: string; state?: string
}

export async function mcpOAuthFlowPlugin(app: FastifyInstance) {
  // PUBLIC: the user is not logged in yet; the tenant is resolved from Host (unknown Host → 404).
  app.get<{ Querystring: AuthorizeQuery }>('/mcp/oauth/authorize', { config: { public: true } }, async (req, reply) => {
    const q = req.query
    const client = await resolveClient(req.db, q.client_id ?? '')
    let validated
    try {
      validated = validateAuthorizeRequest(client, {
        clientId: q.client_id, redirectUri: q.redirect_uri, responseType: q.response_type,
        codeChallenge: q.code_challenge, codeChallengeMethod: q.code_challenge_method, scope: q.scope, state: q.state,
      })
    } catch (e) {
      if (e instanceof AuthorizeDirectError) {
        // Unknown client / unregistered redirect_uri → show the user; NEVER redirect (open-redirect defense).
        return reply.code(400).type('text/plain').send(`invalid authorization request: ${e.code}`)
      }
      if (e instanceof AuthorizeRedirectError) {
        // redirect_uri is confirmed-registered → safe to bounce the error back to it with the state.
        return reply.redirect(redirectWithParams(e.redirectUri, { error: e.code, error_description: e.message, state: e.state }))
      }
      throw e
    }
    // Stash the validated request across the login round-trip, then delegate login to the tenant's OIDC. A
    // flow-binding nonce is stored on the pending request AND set as an httpOnly cookie, so /complete can require
    // the completing browser to be the one that started here (login-CSRF / auth-code-injection defense).
    const reqId = randomToken()
    const flowNonce = randomToken()
    await savePendingAuthorize(app.valkey, reqId, {
      clientId: validated.client.clientId, redirectUri: validated.redirectUri, codeChallenge: validated.codeChallenge,
      scopes: validated.scopes, state: validated.state, tenantId: req.tenant.id, flowNonce,
    })
    reply.setCookie(FLOW_COOKIE, flowNonce, flowCookieOptions())
    const returnTo = `/mcp/oauth/complete?req=${encodeURIComponent(reqId)}`
    return reply.redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`)
  })

  // MEMBER route (NOT public): the session cookie set by /auth/callback authenticates req.user here. #391 /
  // ADR-148: renders the CONSENT page — it PEEKS the pending request (non-destructive; only the POST consumes)
  // and mints NOTHING. The flow cookie is deliberately NOT cleared here: it must survive to the POST so the
  // double-submit check can run (it is cleared, one-shot, by the POST).
  app.get<{ Querystring: { req?: string } }>('/mcp/oauth/complete', async (req, reply) => {
    const reqId = req.query?.req ?? ''
    const pending = await peekPendingAuthorize(app.valkey, reqId)
    // Expired/replayed/unknown pending request → generic 400 (no redirect target we trust here).
    if (!pending) return reply.code(400).type('text/plain').send('authorization request expired or already used')
    // FLOW BINDING (login-CSRF / auth-code-injection defense): the browser completing the flow MUST be the one
    // that started it — its cookie must equal the nonce stored on the pending request. A victim tricked into
    // hitting /complete?req=<attacker's reqId> has no matching cookie → 400, so no consent page is even shown
    // (and no code can be minted against their sub for the attacker's client/redirect_uri).
    if (!req.cookies?.[FLOW_COOKIE] || req.cookies[FLOW_COOKIE] !== pending.flowNonce) {
      return reply.code(400).type('text/plain').send('authorization flow not started in this browser')
    }
    // The member must have logged into the SAME tenant the request was started under (no cross-tenant code).
    if (pending.tenantId !== req.tenant.id) return reply.code(400).type('text/plain').send('tenant mismatch')
    // Display data comes from the STORED validated request + the client REGISTRATION — never from tamperable
    // current query params. client_name is UNTRUSTED DCR free text → escapeHtml (ADR-148: an XSS here would
    // exfiltrate the nonce/reqId and defeat the CSRF defense itself). The redirect host is escaped likewise.
    const client = await resolveClient(req.db, pending.clientId)
    const name = escapeHtml(client?.clientName || pending.clientId)
    const redirectHost = escapeHtml(new URL(pending.redirectUri).host)
    const scopeLine = (s: string) =>
      s === 'write' ? 'Create and edit pages (write)' : s === 'read' ? 'Read your pages (read)' : escapeHtml(s)
    const scopeItems = pending.scopes.map((s) => `<li>${scopeLine(s)}</li>`).join('')
    // Clickjacking: the consent page refuses to be framed (XFO + CSP frame-ancestors) — the double-submit
    // token does not stop an overlay from click-steering a legitimately-rendered form (ADR-148).
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Content-Security-Policy', "frame-ancestors 'none'")
    reply.header('Cache-Control', 'no-store')
    return reply.type('text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:26rem;margin:8vh auto;padding:0 1rem;color:#1f2328}
  ul{padding-left:1.2rem} .host{color:#656d76;font-size:.9rem;word-break:break-all}
  form{display:flex;gap:.75rem;margin-top:1.5rem}
  button{flex:1;padding:.6rem 1rem;border-radius:6px;border:1px solid #d0d7de;background:#f6f8fa;font-size:1rem;cursor:pointer}
  button[value=approve]{background:#2563eb;border-color:#2563eb;color:#fff}
</style></head><body>
<h1>Authorize ${name}?</h1>
<p><strong>${name}</strong> is requesting access to your Wikistead content. If you approve, an authorization
code is sent to:</p>
<p class="host">${redirectHost}</p>
<p>Requested permissions:</p>
<ul>${scopeItems}</ul>
<form method="post" action="/mcp/oauth/consent">
  <input type="hidden" name="req" value="${escapeHtml(reqId)}">
  <input type="hidden" name="nonce" value="${escapeHtml(pending.flowNonce)}">
  <button type="submit" name="decision" value="deny">Deny</button>
  <button type="submit" name="decision" value="approve">Approve</button>
</form>
</body></html>`)
  })

  // MEMBER route (NOT public) — #391 / ADR-148: the explicit approval. Re-runs EVERY check the GET ran
  // (session auth via the non-public route, pending existence, flow binding, tenant match) PLUS the
  // double-submit CSRF equality (cookie === form nonce === pending.flowNonce), consumes the pending
  // atomically (GETDEL — a double-approve finds nothing → 400, no replay), and only THEN mints the code,
  // bound to the POSTING member's sub. Deny is first-class: ?error=access_denied&state=… to the
  // (stored, already-validated) redirect_uri; no code is minted.
  app.post<{ Body: { req?: string; nonce?: string; decision?: string } }>('/mcp/oauth/consent', async (req, reply) => {
    const pending = await consumePendingAuthorize(app.valkey, req.body?.req ?? '')
    reply.clearCookie(FLOW_COOKIE, { path: '/' }) // one-shot: the flow ends here, approve or deny
    if (!pending) return reply.code(400).type('text/plain').send('authorization request expired or already used')
    // Double-submit flow binding: the httpOnly cookie (unreadable cross-site, not sent on cross-site POSTs —
    // SameSite=Lax) AND the form field must BOTH equal the stored nonce. A cross-site auto-submitted form has
    // no cookie; a leaked reqId alone has neither.
    const cookieNonce = req.cookies?.[FLOW_COOKIE]
    if (!cookieNonce || cookieNonce !== pending.flowNonce || req.body?.nonce !== pending.flowNonce) {
      return reply.code(400).type('text/plain').send('authorization flow not started in this browser')
    }
    // Same-tenant binding, re-checked on the POST (no cross-tenant code).
    if (pending.tenantId !== req.tenant.id) return reply.code(400).type('text/plain').send('tenant mismatch')

    if (req.body?.decision === 'deny') {
      // RFC 6749 §4.1.2.1 — the resource owner denied the request. The redirect_uri is the stored, validated one.
      return reply.redirect(redirectWithParams(pending.redirectUri, { error: 'access_denied', state: pending.state }))
    }
    if (req.body?.decision !== 'approve') return reply.code(400).type('text/plain').send('invalid consent decision')

    const code = randomToken()
    await saveAuthCode(app.valkey, code, {
      sub: req.user.sub, tenantId: pending.tenantId, clientId: pending.clientId,
      redirectUri: pending.redirectUri, codeChallenge: pending.codeChallenge, scopes: pending.scopes,
      groups: req.user.groups ?? [], // the logged-in member's groups → carried into the token
    })
    // redirect_uri came from the STORED (already-validated) request — never from tamperable current params.
    return reply.redirect(redirectWithParams(pending.redirectUri, { code, state: pending.state }))
  })
}
