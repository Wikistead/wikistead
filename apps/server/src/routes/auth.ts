import type { FastifyInstance } from 'fastify'
import { resolveTenantFromHost, loadTenant } from '../tenant.js'
import { acquireTenantDb } from '../db/index.js'
import type { TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import { mintMemberCollabToken } from '@wikistead/auth'
import { SESSION_COOKIE, destroySession, establishMemberSession, sessionCookieOptions } from '../auth/session.js'
import { buildLogin, exchangeCode, type TenantOidcConfig } from '../auth/oidc.js'
import { saveState, consumeState } from '../auth/oidc-state.js'
import { safeReturnTo } from '../auth/return-to.js'

async function resolveTenant(host: string | undefined): Promise<Tenant | null> {
  const { slug, domain } = resolveTenantFromHost(host ?? '')
  return loadTenant(slug, domain)
}

// Read the tenant's OIDC config under its RLS context (one row per tenant).
async function loadTenantOidc(db: TenantDb): Promise<TenantOidcConfig | null> {
  const [row] = await db.sql<
    { issuer: string; client_id: string; client_secret_enc: string | null; scopes: string; redirect_uri: string; enabled: boolean }[]
  >`SELECT issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled FROM tenant_oidc LIMIT 1`
  if (!row || !row.enabled) return null
  return {
    issuer: row.issuer,
    clientId: row.client_id,
    clientSecretEnc: row.client_secret_enc,
    scopes: row.scopes,
    redirectUri: row.redirect_uri,
  }
}

// Session-backed auth endpoints (P1.1). /auth/login + /auth/callback are PUBLIC
// (skipped by the auth hook in app.ts) because they ESTABLISH the session; they
// resolve the tenant from the Host themselves. /auth/me + /auth/logout require an
// existing session and run through the normal hook.
export async function authPlugin(app: FastifyInstance) {
  // Start the OIDC flow: redirect to the tenant's IdP with state/nonce/PKCE.
  app.get<{ Querystring: { returnTo?: string } }>('/auth/login', async (req, reply) => {
    const tenant = await resolveTenant(req.headers.host)
    if (!tenant) return reply.code(404).send({ error: 'not found' })
    const db = await acquireTenantDb(tenant)
    try {
      const cfg = await loadTenantOidc(db)
      if (!cfg) return reply.code(404).send({ error: 'login not configured' })
      const { url, state, nonce, codeVerifier } = await buildLogin(cfg)
      const returnTo = safeReturnTo(req.query?.returnTo)
      await saveState(app.valkey, state, { nonce, codeVerifier, tenantId: tenant.id, returnTo })
      return reply.redirect(url)
    } finally {
      await db.release()
    }
  })

  // IdP redirect target: validate+consume state, exchange the code, enforce
  // membership, establish the session.
  app.get<{ Querystring: { state?: string; code?: string } }>('/auth/callback', async (req, reply) => {
    const tenant = await resolveTenant(req.headers.host)
    if (!tenant) return reply.code(404).send({ error: 'not found' })

    // Consume-once state (atomic). Unknown / replayed / cross-tenant state → reject
    // BEFORE any token exchange (CSRF + replay defense).
    const st = await consumeState(app.valkey, req.query?.state ?? '')
    if (!st || st.tenantId !== tenant.id) {
      return reply.code(400).send({ error: 'invalid login state' })
    }

    const db = await acquireTenantDb(tenant)
    try {
      const cfg = await loadTenantOidc(db)
      if (!cfg) return reply.code(404).send({ error: 'login not configured' })

      const currentUrl = `${req.protocol}://${req.headers.host}${req.url}`
      let claims
      try {
        claims = await exchangeCode(cfg, currentUrl, { state: req.query!.state!, nonce: st.nonce, codeVerifier: st.codeVerifier })
      } catch {
        return reply.redirect('/login?error=auth') // token/sig/nonce check failed
      }

      try {
        const sid = await establishMemberSession({ db, fga: app.fga, valkey: app.valkey }, tenant, claims)
        reply.setCookie(SESSION_COOKIE, sid, sessionCookieOptions())
        return reply.redirect(st.returnTo)
      } catch {
        // Not a member (or any post-auth failure). Deliberately VAGUE — telling the
        // caller "authenticated but not a member" would confirm the sub exists in
        // the IdP (enumeration). Membership is never created here.
        return reply.redirect('/login?error=access')
      }
    } finally {
      await db.release()
    }
  })

  // Who am I — lets the SPA know the current member (401 if unauthenticated).
  app.get('/auth/me', async (req) => ({ sub: req.user.sub, groups: req.user.groups }))

  // Mint a short-lived collab token from the (cookie) session: the collab
  // WebSocket is token-based, so the browser member exchanges its session for a
  // signed token to hand to HocuspocusProvider. Collab re-derives per-document
  // authority from OpenFGA (the token asserts identity, not authority).
  const COLLAB_TOKEN_TTL = 300
  app.post('/auth/collab-token', async (req) => {
    const token = await mintMemberCollabToken(
      { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: COLLAB_TOKEN_TTL },
      { tenantId: req.tenant.id, sub: req.user.sub, groups: req.user.groups },
    )
    return { token, expiresInSeconds: COLLAB_TOKEN_TTL }
  })

  // Logout = real revocation: DELETE the Valkey session (not just the cookie, or a
  // resent sid would still authenticate) AND clear the cookie.
  app.post('/auth/logout', async (req, reply) => {
    const sid = req.cookies?.[SESSION_COOKIE]
    if (sid) await destroySession(app.valkey, sid)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return reply.code(204).send()
  })
}
