import type { FastifyInstance } from 'fastify'
import { resolveTenantFromHost, loadTenant } from '../tenant.js'
import { acquireTenantDb } from '../db/index.js'
import type { TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import { mintMemberCollabToken } from '@wikistead/auth'
import { SESSION_COOKIE, destroySession, establishMemberSession, sessionCookieOptions } from '../auth/session.js'
import { buildLogin, exchangeCode, loadPlatformOidc, loadSocialLogin, type TenantOidcConfig } from '../auth/oidc.js'
import { saveState, consumeState } from '../auth/oidc-state.js'
import { safeReturnTo } from '../auth/return-to.js'
import { decryptSecret } from '../auth/secret-crypto.js'
import { bootstrapFirstAdmin } from '../auth/provisioning.js'
import { acceptInvite } from '../auth/invites.js'

async function resolveTenant(host: string | undefined): Promise<Tenant | null> {
  const { slug, domain } = resolveTenantFromHost(host ?? '')
  return loadTenant(slug, domain)
}

// The tenant's own IdP (RLS-scoped, one row per tenant); secret decrypted here.
async function loadTenantOidc(db: TenantDb): Promise<TenantOidcConfig | null> {
  const [row] = await db.sql<
    { issuer: string; client_id: string; client_secret_enc: string | null; scopes: string; redirect_uri: string; enabled: boolean; groups_claim: string | null }[]
  >`SELECT issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, groups_claim FROM tenant_oidc LIMIT 1`
  if (!row || !row.enabled) return null
  return {
    issuer: row.issuer,
    clientId: row.client_id,
    clientSecret: row.client_secret_enc ? decryptSecret(row.client_secret_enc) : null,
    scopes: row.scopes,
    redirectUri: row.redirect_uri,
    groupsClaim: row.groups_claim ?? undefined, // #102: per-tenant groups claim (default 'groups')
  }
}

// Resolution order (ADR-016): the tenant's own IdP overrides; else the platform
// IdP (Cloud); else none (CE without OIDC configured). viaTenantOidc gates the CE
// first-admin bootstrap — only the tenant's own IdP can bootstrap, never the
// platform IdP (Cloud admins come from signup).
async function resolveLoginConfig(db: TenantDb): Promise<{ cfg: TenantOidcConfig; viaTenantOidc: boolean } | null> {
  const tenantCfg = await loadTenantOidc(db)
  if (tenantCfg) return { cfg: tenantCfg, viaTenantOidc: true }
  const platform = loadPlatformOidc()
  if (platform) return { cfg: platform, viaTenantOidc: false }
  return null
}

// Session-backed auth endpoints (P1.1). /auth/login + /auth/callback are PUBLIC
// (skipped by the auth hook in app.ts) because they ESTABLISH the session; they
// resolve the tenant from the Host themselves. /auth/me + /auth/logout require an
// existing session and run through the normal hook.
export async function authPlugin(app: FastifyInstance) {
  // Start the OIDC flow: redirect to the tenant's IdP with state/nonce/PKCE.
  app.get<{ Querystring: { returnTo?: string; invite?: string; provider?: string } }>('/auth/login', async (req, reply) => {
    const tenant = await resolveTenant(req.headers.host)
    if (!tenant) return reply.code(404).send({ error: 'not found' })
    const db = await acquireTenantDb(tenant)
    try {
      const resolved = await resolveLoginConfig(db)
      if (!resolved) return reply.code(404).send({ error: 'login not configured' })
      const redirectUri = `${req.protocol}://${req.headers.host}/auth/callback`
      // #281 / ADR-121 §2: a social button passes ?provider=<slug>. Only ALLOWLISTED slugs
      // (PLATFORM_SOCIAL_PROVIDERS) become the broker's source-hint param, and only on the
      // PLATFORM issuer path (a tenant's own IdP gets no social hint). Unknown/absent → no
      // extra param (the broker shows its own picker) — never an error, never user-echoed.
      const social = loadSocialLogin()
      const provider = !resolved.viaTenantOidc && req.query?.provider && social.providers.includes(req.query.provider) ? req.query.provider : undefined
      const { url, state, nonce, codeVerifier } = await buildLogin(resolved.cfg, redirectUri, provider ? { [social.hintParam]: provider } : undefined)
      const returnTo = safeReturnTo(req.query?.returnTo)
      // An invite link starts login with ?invite=<token>; carry it (opaque) through
      // the round-trip so the callback can accept the invite after identity is proven.
      const inviteToken = req.query?.invite || undefined
      await saveState(app.valkey, state, { nonce, codeVerifier, tenantId: tenant.id, returnTo, viaTenantOidc: resolved.viaTenantOidc, inviteToken })
      return reply.redirect(url)
    } catch (e) {
      // #346: buildLogin does OIDC discovery against the issuer; if the IdP is unreachable /
      // misconfigured / mid-outage it throws. Match /auth/callback's graceful contract instead of letting
      // Fastify's default handler emit a raw 500 JSON (a broken-looking page): redirect to the login screen
      // with a VAGUE error (never echo which IdP or the discovery detail — existence-hiding is preserved),
      // and log the detail server-side so operators can trace the outage. authz/behaviour otherwise unchanged.
      req.log.error({ err: e, tenantId: tenant.id }, 'auth/login: IdP discovery / login build failed')
      return reply.redirect('/login?error=idp_unavailable')
    } finally {
      await db.release()
    }
  })

  // #281 / ADR-121 §2: what the sign-in screen should offer. PUBLIC (it renders before any
  // session; the /auth/login prefix is hook-skipped). Social buttons appear only when the
  // tenant logs in via the PLATFORM issuer (Cloud) AND providers are configured — a tenant
  // with its own OIDC (and all of CE) gets none. Slugs only; no secrets, no issuer URLs.
  app.get('/auth/login-options', async (req, reply) => {
    const tenant = await resolveTenant(req.headers.host)
    if (!tenant) return reply.code(404).send({ error: 'not found' })
    const db = await acquireTenantDb(tenant)
    try {
      const resolved = await resolveLoginConfig(db)
      const social = resolved && !resolved.viaTenantOidc ? loadSocialLogin().providers : []
      return reply.send({ social })
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
      const resolved = await resolveLoginConfig(db)
      if (!resolved) return reply.code(404).send({ error: 'login not configured' })

      const currentUrl = `${req.protocol}://${req.headers.host}${req.url}`
      let claims
      try {
        claims = await exchangeCode(resolved.cfg, currentUrl, { state: req.query!.state!, nonce: st.nonce, codeVerifier: st.codeVerifier })
      } catch {
        return reply.redirect('/login?error=auth') // token/sig/nonce check failed
      }

      const deps = { db, fga: app.fga, valkey: app.valkey }
      let sid: string | null = null
      try {
        sid = await establishMemberSession(deps, tenant, claims) // existing member → session
      } catch {
        // Not a member yet. Identity is proven but membership is NOT — login alone
        // never grants it (the identity≠membership invariant). Membership appears
        // here ONLY via one of the two explicit grants below; otherwise we reject.
      }

      // (1) Invite acceptance — the normal, open-ended membership grant (P1.4).
      // Accept the consume-once invite, then establish the session. A bad/expired/
      // revoked/cross-tenant invite returns false → no grant; a seat-cap hit throws
      // → no grant. Either way sid stays null and we fall through to the vague error.
      let seatFull = false
      if (!sid && st.inviteToken) {
        try {
          if (await acceptInvite({ db, fga: app.fga }, tenant, st.inviteToken, claims)) {
            sid = await establishMemberSession(deps, tenant, claims)
          }
        } catch (e) {
          // A seat-cap hit (402) is surfaced distinctly so the user learns the tenant is
          // full; any other failure stays vague. A bad/expired/revoked token returns false
          // (not throw) → it never reaches here, so token existence is not leaked.
          if ((e as { code?: string }).code === 'seat_limit') seatFull = true
          /* else FGA/other failure → no session, vague error */
        }
      }

      // (2) CE first-admin bootstrap — the bounded exception (tenant's own IdP +
      // member-less tenant). A 2nd login or the platform IdP (Cloud) never does.
      if (!sid && st.viaTenantOidc && (await bootstrapFirstAdmin({ db, fga: app.fga }, tenant, claims))) {
        sid = await establishMemberSession(deps, tenant, claims)
      }
      if (!sid) {
        // Seat-full is a billing state the user should see; everything else stays
        // deliberately VAGUE (no "authenticated but not a member" — that would confirm
        // the sub exists in the IdP = enumeration).
        return reply.redirect(seatFull ? '/login?error=seat_full' : '/login?error=access')
      }
      reply.setCookie(SESSION_COOKIE, sid, sessionCookieOptions())
      return reply.redirect(st.returnTo)
    } finally {
      await db.release()
    }
  })

  // Who am I — lets the SPA know the current member (401 if unauthenticated).
  // isAdmin is a UI-convenience signal only (drives menu visibility); it is NOT a
  // gate — every admin action re-checks tenant#admin server-side (requireTenantAdmin).
  app.get('/auth/me', async (req) => {
    const { allowed } = await req.server.fga.check({
      user: `user:${req.user.sub}`,
      relation: 'admin',
      object: `tenant:${req.tenant.id}`,
    })
    // Peer-visible identity for the avatar (#3): displayName + picture, NEVER email.
    // EFFECTIVE values (ADR-020): a user's override wins over the OIDC display_name, and an
    // uploaded avatar wins over the OIDC picture — so cursors / header / @mentions all
    // reflect the user's account settings (a read-path change only; no collab reconfigure).
    // editorKeymap rides along so the editor can reconcile its localStorage-hydrated pref.
    const [m] = await req.db.sql<[{ display_name: string | null; display_name_override: string | null; picture_url: string | null; avatar_image_key: string | null; editor_keymap: string | null }?]>`
      SELECT display_name, display_name_override, picture_url, avatar_image_key, editor_keymap
      FROM members WHERE sub = ${req.user.sub} LIMIT 1`
    return {
      sub: req.user.sub,
      groups: req.user.groups,
      isAdmin: Boolean(allowed),
      displayName: m?.display_name_override ?? m?.display_name ?? null,
      picture: m?.avatar_image_key ? `/members/${encodeURIComponent(req.user.sub)}/avatar-image` : (m?.picture_url ?? null),
      editorKeymap: m?.editor_keymap === 'vim' ? 'vim' : 'default',
    }
  })

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
