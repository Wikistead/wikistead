import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import {
  savePendingAuthorize, consumePendingAuthorize, saveAuthCode, redirectWithParams,
} from '../auth/mcp-oauth-store.js'
import { resolveClient, validateAuthorizeRequest, AuthorizeDirectError, AuthorizeRedirectError } from './mcp-oauth-authorize.js'

// #311 / ADR-131 slice 3b: the MCP OAuth authorization-code flow — the two redirect endpoints that turn a
// validated authorize request into a one-time code, delegating the actual LOGIN to the tenant's existing OIDC
// (/auth/login → /auth/callback). NO access token is minted here (slice 4 does that at /token). PKCE is carried
// (the code_challenge is stored on the auth code) and VERIFIED only at the token exchange (RFC 7636).
//
// Flow:
//   GET /mcp/oauth/authorize  (public: no session yet) → validate (slice 3a) → stash the validated request in
//     Valkey (consume-once) → redirect to /auth/login with returnTo=/mcp/oauth/complete. An unknown client /
//     unregistered redirect_uri is a DIRECT 400 (never redirected — open-redirect defense); any other invalid
//     param bounces to the CONFIRMED redirect_uri with ?error=...&state=... .
//   GET /mcp/oauth/complete   (MEMBER: the session cookie is set by /auth/callback) → consume the pending
//     request, mint a one-time code bound to (sub, tenant, client, redirect_uri, code_challenge), redirect to the
//     client's registered redirect_uri with ?code=...&state=... .

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

  // MEMBER route (NOT public): the session cookie set by /auth/callback authenticates req.user here. Mints the
  // one-time code and redirects to the client's registered redirect_uri.
  app.get<{ Querystring: { req?: string } }>('/mcp/oauth/complete', async (req, reply) => {
    const pending = await consumePendingAuthorize(app.valkey, req.query?.req ?? '')
    reply.clearCookie(FLOW_COOKIE, { path: '/' }) // one-shot: clear the flow cookie regardless of outcome
    // Expired/replayed/unknown pending request → generic 400 (no redirect target we trust here).
    if (!pending) return reply.code(400).type('text/plain').send('authorization request expired or already used')
    // FLOW BINDING (login-CSRF / auth-code-injection defense): the browser completing the flow MUST be the one
    // that started it — its cookie must equal the nonce stored on the pending request. A victim tricked into
    // hitting /complete?req=<attacker's reqId> has no matching cookie → 400, so no code is minted against their
    // sub for the attacker's client/redirect_uri.
    if (!req.cookies?.[FLOW_COOKIE] || req.cookies[FLOW_COOKIE] !== pending.flowNonce) {
      return reply.code(400).type('text/plain').send('authorization flow not started in this browser')
    }
    // The member must have logged into the SAME tenant the request was started under (no cross-tenant code).
    if (pending.tenantId !== req.tenant.id) return reply.code(400).type('text/plain').send('tenant mismatch')

    const code = randomToken()
    await saveAuthCode(app.valkey, code, {
      sub: req.user.sub, tenantId: pending.tenantId, clientId: pending.clientId,
      redirectUri: pending.redirectUri, codeChallenge: pending.codeChallenge, scopes: pending.scopes,
    })
    // redirect_uri came from the STORED (already-validated) request — never from tamperable current params.
    return reply.redirect(redirectWithParams(pending.redirectUri, { code, state: pending.state }))
  })
}
