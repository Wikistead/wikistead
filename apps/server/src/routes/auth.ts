import type { FastifyInstance } from 'fastify'
import { resolveTenantFromHost, loadTenant } from '../tenant.js'
import { acquireTenantDb } from '../db/index.js'
import type { TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import { mintMemberCollabToken } from '@wikistead/auth'
import { SESSION_COOKIE, destroySession, establishMemberSession, sessionCookieOptions } from '../auth/session.js'
import { buildLogin, exchangeCode, loadSocialLogin, loadPlatformOidc, type TenantOidcConfig } from '../auth/oidc.js'
import { saveState, consumeState } from '../auth/oidc-state.js'
import { safeReturnTo } from '../auth/return-to.js'
import { decryptSecret } from '../auth/secret-crypto.js'
import { bootstrapFirstAdmin } from '../auth/provisioning.js'
import { acceptInvite } from '../auth/invites.js'
import { resolveAvailableLogin, resolveLoginConnections, socialProvidersFor } from '../auth/login-methods.js'

async function resolveTenant(host: string | undefined): Promise<Tenant | null> {
  const { slug, domain } = resolveTenantFromHost(host ?? '')
  return loadTenant(slug, domain)
}

// The tenant's own IdP (RLS-scoped; the tenant's first ENABLED connection — S2 review N6: picking
// the first row regardless of enabled diverged from the connection list once N≥2, and the
// divergence was fail-open on the SSO-enforcement side). Secret decrypted here.
async function loadTenantOidc(db: TenantDb): Promise<TenantOidcConfig | null> {
  const row = await firstEnabledTenantOidc(db)
  return row ? toOidcCfg(row) : null
}

type TenantOidcRow = { id: string; issuer: string; client_id: string; client_secret_enc: string | null; scopes: string; redirect_uri: string; enabled: boolean; groups_claim: string | null; bootstrap_eligible: boolean }

async function firstEnabledTenantOidc(db: TenantDb): Promise<TenantOidcRow | null> {
  const [row] = await db.sql<TenantOidcRow[]>`
    SELECT id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, groups_claim, bootstrap_eligible
    FROM tenant_oidc WHERE enabled ORDER BY sort, id LIMIT 1`
  return row ?? null
}

// #554 S2: ONE connection by its minted id (RLS-scoped, enabled only). The resolver's list is the
// existence/effectiveness authority; this loads the secret-bearing config for the chosen row.
async function loadTenantOidcById(db: TenantDb, id: string): Promise<TenantOidcConfig | null> {
  const [row] = await db.sql<
    { issuer: string; client_id: string; client_secret_enc: string | null; scopes: string; redirect_uri: string; enabled: boolean; groups_claim: string | null }[]
  >`SELECT issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, groups_claim FROM tenant_oidc WHERE id = ${id}`
  if (!row || !row.enabled) return null
  return toOidcCfg(row)
}

function toOidcCfg(row: { issuer: string; client_id: string; client_secret_enc: string | null; scopes: string; redirect_uri: string; groups_claim: string | null }): TenantOidcConfig {
  return {
    issuer: row.issuer,
    clientId: row.client_id,
    clientSecret: row.client_secret_enc ? decryptSecret(row.client_secret_enc) : null,
    scopes: row.scopes,
    redirectUri: row.redirect_uri,
    groupsClaim: row.groups_claim ?? undefined, // #102: per-tenant groups claim (default 'groups')
  }
}

// #537 / ADR-195: resolution moved into the single login-methods resolver (ceiling ∩ tenant selection;
// ADR-016's order — tenant IdP over platform — is preserved inside it, as is the `viaTenantOidc`
// distinction the CE first-admin bootstrap keys on). This wrapper keeps secret decryption here.
export async function resolveLogin(db: TenantDb, tenant: Tenant) {
  return resolveAvailableLogin(db, tenant, loadTenantOidc)
}

// Session-backed auth endpoints (P1.1). /auth/login + /auth/callback are PUBLIC
// (skipped by the auth hook in app.ts) because they ESTABLISH the session; they
// resolve the tenant from the Host themselves. /auth/me + /auth/logout require an
// existing session and run through the normal hook.
export async function authPlugin(app: FastifyInstance) {
  // Start the OIDC flow: redirect to the tenant's IdP with state/nonce/PKCE.
  app.get<{ Querystring: { returnTo?: string; invite?: string; provider?: string; connection?: string } }>('/auth/login', async (req, reply) => {
    const tenant = await resolveTenant(req.headers.host)
    if (!tenant) return reply.code(404).send({ error: 'not found' })
    const db = await acquireTenantDb(tenant)
    try {
      // #537 §7: the unified body — a method outside the effective set and a tenant that does not
      // exist answer identically ('not found'; the old 'login not configured' was a distinguisher).
      //
      // #554 S2 / ADR-197 §2: ?connection=<id> starts ONE named connection. Absent / disabled /
      // ceiling-excluded / unentitled / non-OIDC-family ids all answer the SAME unified 404 —
      // connection ids stay unguessable uuids until S3 publishes the list. Without the param the
      // legacy pick (tenant IdP over platform, ADR-016) is byte-identical to before.
      let resolved: { cfg: TenantOidcConfig; viaTenantOidc: boolean } | null = null
      let connectionId: string | undefined
      if (req.query?.connection !== undefined) {
        // S2 review N7: an EXPLICIT but empty/unknown connection is a refusal, never a silent fall
        // back to the default pick — once S3's buttons pass ids, "started the wrong connection
        // quietly" would be the worst failure shape.
        const conn = (await resolveLoginConnections(db, tenant)).find((c) => c.id === req.query!.connection)
        if (!conn || conn.kind === 'saml') return reply.code(404).send({ error: 'not found' })
        const cfg = conn.kind === 'platform' ? loadPlatformOidc() : await loadTenantOidcById(db, conn.id)
        if (!cfg) return reply.code(404).send({ error: 'not found' })
        resolved = { cfg, viaTenantOidc: conn.kind === 'oidc' }
        connectionId = conn.id
      } else {
        const available = await resolveLogin(db, tenant)
        resolved = available.oidc
        // S2 review N2: the legacy pick BINDS too — every state carries the connection it was
        // minted under, so the product paths (login screen, invite links, MCP OAuth — all
        // connection-less today) get the same mid-flight guarantee as a named start. The id is
        // the first ENABLED row (the exact row loadTenantOidc picked) or the platform pseudo-id.
        if (resolved && resolved.viaTenantOidc) {
          // ONE read is the authority for BOTH the config and the bound id (a row shifting between
          // two separate reads would bind a state to a different config than its authorize URL).
          const row = await firstEnabledTenantOidc(db)
          if (!row) return reply.code(404).send({ error: 'not found' })
          resolved = { cfg: toOidcCfg(row), viaTenantOidc: true }
          connectionId = row.id
        } else if (resolved) {
          connectionId = 'platform'
        }
      }
      if (!resolved) return reply.code(404).send({ error: 'not found' })
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
      await saveState(app.valkey, state, { nonce, codeVerifier, tenantId: tenant.id, returnTo, viaTenantOidc: resolved.viaTenantOidc, inviteToken, ...(connectionId ? { connectionId } : {}) })
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
      const available = await resolveLogin(db, tenant)
      // #537 §6/§7: the login screen lists what is OPEN, so the method KINDS are published facts
      // (approved secrecy line: what stays hidden is WHY something is absent — off, unconfigured
      // and unentitled are indistinguishable). `oidc` does not name tenant-vs-platform, though a
      // non-empty `social` implies the platform path (ADR-121's pre-existing disclosure) — the field
      // avoids ADDING a distinguisher rather than hiding that one.
      const methods: string[] = []
      if (available.oidc) methods.push('oidc')
      if (available.methods.has('saml')) methods.push('saml')
      return reply.send({ social: socialProvidersFor(available), methods })
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
      // #537 B3: the callback is an entry too. The state lives 300s, so gating only the START leaves a
      // five-minute completion window after a method is switched off; and when the tenant IdP is
      // disabled mid-flight the old resolver FELL BACK to the platform config — exchanging the code
      // against a different IdP than the one that issued it. The flow completes only if the method the
      // state was minted under is STILL the effective one; otherwise the same unified 404.
      //
      // #554 S2 (the B3 generalization, per-connection): a state minted under a NAMED connection
      // completes only against that exact connection — still effective, same kind, its own config.
      // Disabling the connection (or the ceiling/entitlement dropping it) closes the 300s window.
      // The bootstrap gate below stays keyed on viaTenantOidc — wiring it to bootstrap_eligible
      // awaits the #572 ruling (grandfathered legacy surface vs explicit flip).
      let resolved: { cfg: TenantOidcConfig; viaTenantOidc: boolean } | null = null
      // S2 review N1: bootstrap eligibility is read HERE, at completion time, from the connection
      // the state is bound to — the ADR-197 §2 rev2 pinned rule (a default-flag connection never
      // bootstraps) wired at last. The platform pseudo-connection and SAML are structurally false.
      let bootstrapEligible = false
      try {
        if (st.connectionId) {
          const conn = (await resolveLoginConnections(db, tenant)).find((c) => c.id === st.connectionId && c.kind !== 'saml')
          const cfg = conn ? (conn.kind === 'platform' ? loadPlatformOidc() : await loadTenantOidcById(db, conn.id)) : null
          if (!conn || !cfg) return reply.code(404).send({ error: 'not found' })
          resolved = { cfg, viaTenantOidc: conn.kind === 'oidc' }
          bootstrapEligible = conn.bootstrapEligible
        } else {
          // legacy states minted before connection binding shipped (a ≤300s window at deploy)
          const available = await resolveLogin(db, tenant)
          resolved = available.oidc
          if (resolved?.viaTenantOidc) {
            bootstrapEligible = (await firstEnabledTenantOidc(db))?.bootstrap_eligible ?? false
          }
        }
      } catch (e) {
        // S2 review N4: a listed-but-broken connection (undecryptable secret) used to escape as a
        // raw 500 here while the START answered gracefully — match the #346 contract: vague
        // user-facing error, detail server-side only (never the secret, issuer or id).
        req.log.error({ err: e, tenantId: tenant.id }, 'auth/callback: connection config load failed')
        return reply.redirect('/login?error=idp_unavailable')
      }
      if (!resolved || resolved.viaTenantOidc !== st.viaTenantOidc) return reply.code(404).send({ error: 'not found' })

      const currentUrl = `${req.protocol}://${req.headers.host}${req.url}`
      let claims
      try {
        claims = await exchangeCode(resolved.cfg, currentUrl, { state: req.query!.state!, nonce: st.nonce, codeVerifier: st.codeVerifier })
      } catch (e) {
        // #377: the token/sig/nonce exchange failure used to be swallowed silently — an operator saw only the
        // user's vague `/login?error=auth` with nothing server-side to diagnose (clock skew, wrong client
        // secret, IdP outage). Log it (the redirect + vagueness to the user are unchanged — no enumeration).
        req.log.error({ err: e, tenantId: tenant.id }, 'auth/callback: OIDC code exchange failed')
        return reply.redirect('/login?error=auth')
      }

      const deps = { db, fga: app.fga, valkey: app.valkey, searchDriver: app.searchDriver }
      let sid: string | null = null
      try {
        sid = await establishMemberSession(deps, tenant, claims) // existing member → session
      } catch (e) {
        // Not a member yet. Identity is proven but membership is NOT — login alone
        // never grants it (the identity≠membership invariant). Membership appears
        // here ONLY via one of the two explicit grants below; otherwise we reject.
        // #377: this is the EXPECTED non-member path, so log at debug — but it also swallows a genuine DB/FGA
        // error indistinguishably, and debug keeps that diagnosable without erroring on every new login.
        req.log.debug({ err: e, tenantId: tenant.id }, 'auth/callback: no existing member session (identity proven, membership pending)')
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
          // #377: a non-seat-cap failure here (FGA write, DB) previously vanished silently — log it (the user
          // still gets the vague error; only the operator gains a diagnosable trail).
          else req.log.error({ err: e, tenantId: tenant.id }, 'auth/callback: invite acceptance / session establish failed')
        }
      }

      // (2) CE first-admin bootstrap — the bounded exception (tenant's own IdP +
      // member-less tenant). A 2nd login or the platform IdP (Cloud) never does.
      // #554 S2 review N1: AND the connection must be bootstrap_eligible (ADR-197 §2 rev2) — a
      // named non-first connection is reachable now, and a default-flag one never bootstraps.
      if (!sid && st.viaTenantOidc && bootstrapEligible && (await bootstrapFirstAdmin({ db, fga: app.fga }, tenant, claims))) {
        sid = await establishMemberSession(deps, tenant, claims)
      }
      if (!sid) {
        // Seat-full is a billing state the user should see; everything else stays
        // deliberately VAGUE (no "authenticated but not a member" — that would confirm
        // the sub exists in the IdP = enumeration).
        // #377: log the rejection server-side (the user-facing message stays vague — no enumeration leak).
        req.log.info({ tenantId: tenant.id, seatFull }, 'auth/callback: login rejected (identity proven but no membership grant)')
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
