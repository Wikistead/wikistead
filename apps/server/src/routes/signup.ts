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

// Cloud self-serve signup (P1.2 P2d). All routes are PUBLIC (no tenant — they
// CREATE one) and skipped by the auth hook. They use the SIGNUP session, which is
// strictly separate from the member session (see auth/signup-session.ts).
// Web page to choose a workspace name. NOT under /signup (that path is proxied to
// the API) — the SPA serves /join/*.
const WORKSPACE_PAGE = '/join/workspace'

export async function signupPlugin(app: FastifyInstance) {
  // Start signup: platform IdP login (CE has no platform IdP → 404).
  app.get<{ Querystring: { provider?: string } }>('/signup/login', async (req, reply) => {
    const cfg = loadPlatformOidc()
    if (!cfg) return reply.code(404).send({ error: 'signup not available' })
    const redirectUri = `${req.protocol}://${req.headers.host}/signup/callback`
    const { url, state, nonce, codeVerifier } = await buildLogin(cfg, redirectUri)
    await saveState(app.valkey, state, { nonce, codeVerifier, tenantId: '', returnTo: '', viaTenantOidc: false })
    return reply.redirect(url)
  })

  app.get<{ Querystring: { state?: string; code?: string } }>('/signup/callback', async (req, reply) => {
    const cfg = loadPlatformOidc()
    if (!cfg) return reply.code(404).send({ error: 'signup not available' })
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
    reply.setCookie(SIGNUP_COOKIE, sid, signupCookieOptions())
    return reply.redirect(WORKSPACE_PAGE)
  })

  // Create the tenant from the signup session, then CONSUME it. The creator then
  // SSO-logs-in at the tenant subdomain to get a real member session (the signup
  // session never persists past creation).
  app.post<{ Body: { slug?: string } }>('/signup/tenants', async (req, reply) => {
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

    await destroySignupSession(app.valkey, sid)
    reply.clearCookie(SIGNUP_COOKIE, { path: '/signup' })
    const base = process.env.PUBLIC_TENANT_BASE_HOST ?? req.headers.host
    const scheme = process.env.NODE_ENV === 'production' ? 'https' : 'http'
    return reply.code(201).send({ tenantUrl: `${scheme}://${slug}.${base}` })
  })
}
