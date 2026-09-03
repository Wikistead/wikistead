import type { FastifyInstance } from 'fastify'
import { buildLogin, exchangeCode, loadPlatformOidc } from '../auth/oidc.js'
import { saveState, consumeState } from '../auth/oidc-state.js'
import {
  SIGNUP_COOKIE,
  createSignupSession,
  readSignupSession,
  destroySignupSession,
  signupCookieOptions,
} from '../auth/signup-session.js'
import { provisionTenant, isValidSlug } from '../auth/provisioning.js'
import { loginMethodCeiling } from '../auth/login-methods.js'
import { readTenantUrlTemplate } from '../auth/tenant-url-template.js'
import { reportWorkspaceCreated } from '../funnel/sink.js'

// Cloud self-serve signup (P1.2 P2d). All routes are PUBLIC (no tenant — they
// CREATE one) and skipped by the auth hook. They use the SIGNUP session, which is
// strictly separate from the member session (see auth/signup-session.ts).
// Web page to choose a workspace name. NOT under /signup (that path is proxied to
// the API) — the SPA serves /join/*.
const WORKSPACE_PAGE = '/join/workspace'

/**
 * #806: is there an address to send a new workspace's creator to?
 *
 * The create step re-reads the template because it needs the renderer; the entry points only need
 * the yes/no, and they ask so that nobody is walked through an identity flow that cannot finish.
 */
function workspaceAddressDeclared(): boolean {
  return readTenantUrlTemplate().ok
}

export async function signupPlugin(app: FastifyInstance) {
  // Start signup: platform IdP login (CE has no platform IdP → 404).
  app.get<{ Querystring: { provider?: string } }>('/signup/login', async (req, reply) => {
    // #537 B4: signup called loadPlatformOidc() directly and never consulted the resolver — a ceiling
    // that drops platform-oidc must drop Cloud signup with it (signup IS a platform-OIDC login).
    const cfg = loginMethodCeiling().has('platform-oidc') ? loadPlatformOidc() : null
    if (!cfg || !workspaceAddressDeclared()) return reply.code(404).send({ error: 'signup not available' })
    const redirectUri = `${req.protocol}://${req.headers.host}/signup/callback`
    const { url, state, nonce, codeVerifier } = await buildLogin(cfg, redirectUri)
    await saveState(app.valkey, state, { nonce, codeVerifier, tenantId: '', returnTo: '', viaTenantOidc: false })
    return reply.redirect(url)
  })

  app.get<{ Querystring: { state?: string; code?: string } }>('/signup/callback', async (req, reply) => {
    // #537 B3/B4: the callback gates too — the state's 300s TTL must not out-live the ceiling.
    const cfg = loginMethodCeiling().has('platform-oidc') ? loadPlatformOidc() : null
    if (!cfg || !workspaceAddressDeclared()) return reply.code(404).send({ error: 'signup not available' })
    const st = await consumeState(app.valkey, req.query?.state ?? '')
    if (!st) return reply.code(400).send({ error: 'invalid signup state' })

    const currentUrl = `${req.protocol}://${req.headers.host}${req.url}`
    let claims
    try {
      claims = await exchangeCode(cfg, currentUrl, { state: req.query!.state!, nonce: st.nonce, codeVerifier: st.codeVerifier })
    } catch {
      return reply.redirect('/signup?error=auth')
    }
    // Verified identity but NO tenant yet → a one-time, create-only signup session
    // (NOT a member session). The browser carries it only on /signup/* (Path).
    const sid = await createSignupSession(app.valkey, { sub: claims.sub, email: claims.email, name: claims.name })
    reply.setCookie(SIGNUP_COOKIE, sid, signupCookieOptions(req))
    return reply.redirect(WORKSPACE_PAGE)
  })

  // Create the tenant from the signup session, then CONSUME it. The creator then
  // SSO-logs-in at the tenant subdomain to get a real member session (the signup
  // session never persists past creation).
  app.post<{ Body: { slug?: string } }>('/signup/tenants', async (req, reply) => {
    // #537 (review finding F): the create step gates too — a signup session minted before a ceiling
    // change must not complete into a tenant nobody can ever sign in to.
    if (!loginMethodCeiling().has('platform-oidc')) return reply.code(404).send({ error: 'signup not available' })
    // #806 / ADR-249 Decision 3+4: a deployment that cannot say where a new workspace would LIVE
    // does not create one. The refusal sits here, beside the ceiling check and AHEAD of
    // `provisionTenant` below — a refusal after the provision would reproduce the reported symptom
    // exactly: the workspace exists, and the person who made it is told nothing useful.
    const address = readTenantUrlTemplate()
    if (!address.ok) {
      req.log.warn({ fault: address.fault }, `self-serve workspace creation is closed: ${address.why}`)
      return reply.code(404).send({ error: 'signup not available' })
    }
    const sid = req.cookies?.[SIGNUP_COOKIE]
    const su = await readSignupSession(app.valkey, sid)
    if (!su) return reply.code(401).send({ error: 'no signup session' })

    const slug = (req.body?.slug ?? '').toLowerCase()
    if (!isValidSlug(slug)) return reply.code(400).send({ error: 'invalid workspace name' })

    try {
      await provisionTenant(app.fga, { slug, admin: { sub: su.sub, email: su.email, name: su.name } })
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode ?? 500
      return reply.code(code).send({ error: code === 409 ? 'workspace name taken' : 'could not create workspace' })
    }

    // #715 / ADR-229: the funnel's NUMERATOR — a workspace exists that did not before. After the
    // provision succeeded, so a failed attempt never counts.
    reportWorkspaceCreated()

    await destroySignupSession(app.valkey, sid)
    reply.clearCookie(SIGNUP_COOKIE, { path: '/signup' })
    // The declared shape, rendered — not the request's own Host with a slug glued on, and not a
    // scheme guessed from NODE_ENV (which says nothing about where TLS terminates).
    return reply.code(201).send({ tenantUrl: address.render(slug) })
  })
}
