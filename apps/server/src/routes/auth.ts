import type { FastifyInstance } from 'fastify'
import { resolveTenantFromHost, loadTenant } from '../tenant.js'
import { acquireTenantDb } from '../db/index.js'
import type { TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import { mintMemberCollabToken } from '@wikistead/auth'
import { SESSION_COOKIE, destroySession, establishMemberSession, readSession, sessionCookieOptions } from '../auth/session.js'
import { buildLogin, exchangeCode, loadPlatformOidc, type TenantOidcConfig } from '../auth/oidc.js'
import { saveState, consumeState } from '../auth/oidc-state.js'
import { safeReturnTo } from '../auth/return-to.js'
import { decryptSecret } from '../auth/secret-crypto.js'
import { acceptInvite } from '../auth/invites.js'
import { resolveAvailableLogin, resolveLoginConnections } from '../auth/login-methods.js'
import { findMemberIdentityLink, linkMemberIdentity, listLinkedConnectionIds } from '../auth/member-identities.js'
import { reauthenticated, locked, countFailure } from './second-factor.js'

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

type TenantOidcRow = { id: string; issuer: string; client_id: string; client_secret_enc: string | null; scopes: string; redirect_uri: string; enabled: boolean; groups_claim: string | null; trust_groups: boolean; subject_prefix: string | null }

async function firstEnabledTenantOidc(db: TenantDb): Promise<TenantOidcRow | null> {
  const [row] = await db.sql<TenantOidcRow[]>`
    SELECT id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, groups_claim, trust_groups, subject_prefix
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
      // #602 / ADR-206 §3 (user ruling): the `?provider=` source hint is GONE with the social path it
      // served. Choosing Google is choosing a preset CONNECTION now — one mechanism, named by id in the
      // URL — instead of a second one that reached the same broker with a hint the tenant-IdP path
      // silently dropped.
      const { url, state, nonce, codeVerifier } = await buildLogin(resolved.cfg, redirectUri)
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
      // #554 S3 / ADR-197 §3: the CONNECTION list is the screen's truth — ordered, minted opaque
      // ids, {id, kind, label, brand}. Two rules bite here:
      //   - S1 drift (b), resolved: an oidc connection whose config cannot LOAD (undecryptable
      //     secret) is dropped from the list — the screen must never render a button the start
      //     route cannot honor. The failure is logged server-side, never surfaced (no oracle).
      //   - labels: the preset-less custom-OIDC label SHIPPED (S4, migration 094 + the sanitiser in
      //     admin-connections.ts, which trims to 64 and strips the characters that lie precisely
      //     BECAUSE this surface is unauthenticated). So an admin-authored string does reach here,
      //     by design, and #798 made it required at creation. A preset never carries one: the brand
      //     is fixed first-party wording, not an admin string. (The old note said the opposite and
      //     was believed twice by people reading this file.)
      const connections: { id: string; kind: string; label: string | null; brand: string | null }[] = []
      for (const c of await resolveLoginConnections(db, tenant)) {
        if (c.kind === 'oidc') {
          try {
            if (!(await loadTenantOidcById(db, c.id))) continue
          } catch (e) {
            req.log.error({ err: e, tenantId: tenant.id }, 'login-options: connection config load failed — dropped from the list')
            continue
          }
        }
        connections.push({ id: c.id, kind: c.kind, label: c.label, brand: c.brand })
      }
      // #537 §6/§7 legacy fields (kept for byte-compat during the N-up transition): the method
      // KINDS are published facts (approved secrecy line: what stays hidden is WHY something is
      // absent). Derived from the same connection list. #602 retired the `social` field itself: a
      // provider is a preset CONNECTION in this list, so the screen has one thing to read (ADR-197 §3
      // had already retired socialProvidersFor's "tenant OIDC wins → hide social" rule: the platform
      // slugs render whenever platform is effective, not only when it is the default pick).
      const methods: string[] = []
      if (connections.some((c) => c.kind === 'oidc' || c.kind === 'platform')) methods.push('oidc')
      if (connections.some((c) => c.kind === 'saml')) methods.push('saml')
      return reply.send({ methods, connections })
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
      let resolved: { cfg: TenantOidcConfig; viaTenantOidc: boolean } | null = null
      // #554 S6 / ADR-197 §6: whether the state's connection trusts the asserted groups claim —
      // read alongside eligibility, from the same connection the state is bound to. The platform
      // connection is trusted (the operator's own IdP, today's behavior).
      let trustGroups = true
      // #554 S4 / ADR-197 §5: the connection's sub namespace — non-null means THIS login mints
      // wc<conn8>_<externalSub> member identities (the legacy connection stays raw).
      let subjectPrefix: string | null = null
      // #858 / ADR-259 §3.9: the connection this login came through, in the domain the link table
      // keys on (a tenant_oidc id, or the literal 'platform') — SAML is excluded above, and 'local'
      // never reaches this handler (password sign-in has no callback).
      let connectionId: string | undefined = st.connectionId
      try {
        if (st.connectionId) {
          const conn = (await resolveLoginConnections(db, tenant)).find((c) => c.id === st.connectionId && c.kind !== 'saml')
          const cfg = conn ? (conn.kind === 'platform' ? loadPlatformOidc() : await loadTenantOidcById(db, conn.id)) : null
          if (!conn || !cfg) return reply.code(404).send({ error: 'not found' })
          resolved = { cfg, viaTenantOidc: conn.kind === 'oidc' }
          trustGroups = conn.trustGroups
          subjectPrefix = conn.subjectPrefix
        } else {
          // legacy states minted before connection binding shipped (a ≤300s window at deploy)
          const available = await resolveLogin(db, tenant)
          resolved = available.oidc
          if (resolved?.viaTenantOidc) {
            const first = await firstEnabledTenantOidc(db)
            trustGroups = first?.trust_groups ?? false
            subjectPrefix = first?.subject_prefix ?? null
            connectionId = first?.id
          } else if (resolved) {
            connectionId = 'platform'
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

      // #554 S6 / ADR-197 §6: an untrusted connection asserts NOTHING about groups — the claim is
      // DROPPED before anything persists (the member upsert, the #111 FGA sync, default-role and
      // admin-mapping evaluation, and the drift sweep all read what the upsert wrote, so cutting
      // it HERE covers every sink). Dropping = the same semantics as an IdP that sent no groups
      // claim. Logged once per login, no claim content in the log.
      if (!trustGroups && claims.groups !== undefined) {
        req.log.info({ tenantId: tenant.id }, 'auth/callback: groups claim dropped — the connection does not trust groups (ADR-197 §6)')
        claims = { ...claims, groups: [] }
      }

      // #858 / ADR-259 §3.1: a stored link wins over the deterministic mint below — read BEFORE any
      // prefix is applied, against the RAW external subject, and preferred UNCONDITIONALLY. §5's
      // #807 case is exactly the reason for "unconditionally": the subject this connection would
      // otherwise mint may already belong to a different, live member, and the link still wins — an
      // implementation that only prefers the link when the minted subject has no member row
      // reproduces that defect while passing every other link case.
      const linkedSub = connectionId ? await findMemberIdentityLink(db, tenant.id, connectionId, claims.sub) : null

      // #554 S4 / ADR-197 §5 + rev3 gate flip: on a namespacing connection, the RAW external sub is
      // validated FIRST (the same refusal shape as a non-member — no oracle), then the namespaced
      // identity is minted and the downstream seams are told the mint is OURS. The S0 gates keep
      // refusing every externally-asserted reserved prefix; only this validated mint passes.
      let subMintedInternally = false
      if (linkedSub) {
        claims = { ...claims, sub: linkedSub }
        subMintedInternally = true
      } else if (subjectPrefix) {
        const { externalSubViolation } = await import('../auth/reserved-subs.js')
        if (externalSubViolation(claims.sub)) {
          req.log.info({ tenantId: tenant.id }, 'auth/callback: raw subject refused before namespacing (reserved/oversize)')
          return reply.redirect('/login?error=access')
        }
        claims = { ...claims, sub: subjectPrefix + claims.sub }
        subMintedInternally = true
      }

      const deps = { db, fga: app.fga, valkey: app.valkey, searchDriver: app.searchDriver }
      let sid: string | null = null
      // ADR-259 §3.2/§3.4: set only when auto-enrolment (the FEDERATED door, not an invite token) hit
      // the address collision — this is the one door that gets an explanation rather than the vague
      // refusal, because the person has just authenticated to an IdP that itself asserts this address.
      let addressTaken = false
      try {
        sid = await establishMemberSession(deps, tenant, claims, { subMintedInternally, door: 'federated', connectionId }) // existing member → session
      } catch (e) {
        if ((e as { code?: string }).code === 'address_taken') {
          addressTaken = true
          req.log.info({ tenantId: tenant.id }, 'auth/callback: auto-enrolment refused — address already belongs to a member')
        } else {
          // Not a member yet. Identity is proven but membership is NOT — login alone
          // never grants it (the identity≠membership invariant). Membership appears
          // here ONLY via one of the two explicit grants below; otherwise we reject.
          // #377: this is the EXPECTED non-member path, so log at debug — but it also swallows a genuine DB/FGA
          // error indistinguishably, and debug keeps that diagnosable without erroring on every new login.
          req.log.debug({ err: e, tenantId: tenant.id }, 'auth/callback: no existing member session (identity proven, membership pending)')
        }
      }

      // (1) Invite acceptance — the normal, open-ended membership grant (P1.4).
      // Accept the consume-once invite, then establish the session. A bad/expired/
      // revoked/cross-tenant invite returns false → no grant; a seat-cap hit throws
      // → no grant. Either way sid stays null and we fall through to the vague error.
      let seatFull = false
      if (!sid && st.inviteToken) {
        try {
          if (await acceptInvite({ db, fga: app.fga }, tenant, st.inviteToken, claims, { subMintedInternally })) {
            sid = await establishMemberSession(deps, tenant, claims, { subMintedInternally, door: 'federated', connectionId })
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

      // (2) There is no step (2) any more. #616 / ADR-212 (user ruling 2026-08-05): the first person
      // to complete a login into a member-less tenant used to become its administrator. ADR-198 had
      // already decided that a tenant is never created without an admin, which removed the situation
      // this answered; what remained was a THIRD way to become an administrator, reachable by whoever
      // logged in first. The entrances are signup and `pnpm tenant:local-admin` (slice 1) — the
      // open-core shape, where the first admin is made deliberately rather than raced for.
      if (!sid) {
        // Seat-full is a billing state the user should see; an address collision (ADR-259 §3.2) is a
        // FEDERATED-door-only explanation (§3.4) — sign in the way you already can, then add this
        // provider from account settings; everything else stays deliberately VAGUE (no "authenticated
        // but not a member" — that would confirm the sub exists in the IdP = enumeration).
        // #377: log the rejection server-side (the user-facing message stays vague — no enumeration leak).
        req.log.info({ tenantId: tenant.id, seatFull, addressTaken }, 'auth/callback: login rejected (identity proven but no membership grant)')
        const errorParam = addressTaken ? 'address_taken' : seatFull ? 'seat_full' : 'access'
        return reply.redirect(`/login?error=${errorParam}`)
      }
      reply.setCookie(SESSION_COOKIE, sid, sessionCookieOptions())
      return reply.redirect(st.returnTo)
    } finally {
      await db.release()
    }
  })

  // #947 / ADR-259 §3.3: the tenant's OIDC/platform connections (SAML and password excluded — this
  // flow is OIDC-only), each marked with whether THIS member already holds a link through it. Member-
  // gated (the default hook), self-scoped like the rest of /me — the subject is req.user.sub, never a
  // parameter.
  app.get('/me/connections', async (req) => {
    const [connections, linkedIds] = await Promise.all([
      resolveLoginConnections(req.db, req.tenant),
      listLinkedConnectionIds(req.db, req.tenant.id, req.user.sub),
    ])
    const linked = new Set(linkedIds)
    return {
      connections: connections
        .filter((c) => c.kind === 'oidc' || c.kind === 'platform')
        .map((c) => ({ id: c.id, kind: c.kind, label: c.label, brand: c.brand, linked: linked.has(c.id) })),
    }
  })

  // Where an account-settings link round trip lands (#947): fixed and server-chosen, never a
  // client-supplied returnTo — there is exactly one sensible destination for "you finished linking".
  const LINK_RETURN_PATH = '/settings/account/security'

  // #947 / ADR-259 §3.3: re-authenticate, then mint an OIDC round trip bound to THIS session's
  // member. Re-authentication is asked HERE, before any state exists — the callback below trusts the
  // session the state names precisely because getting a state at all already cost a proof.
  app.post<{ Params: { connectionId: string }; Body: { password?: unknown; code?: unknown; passkey?: unknown } }>(
    '/me/connections/:connectionId/link/start',
    async (req, reply) => {
      if (await locked(app.valkey, req.tenant.id, req.user.sub)) {
        return reply.code(429).send({ error: 'too many attempts — try again later', code: 'factor_locked' })
      }
      if (!(await reauthenticated(app, req as never, req.body ?? {}))) {
        await countFailure(app.valkey, req.tenant.id, req.user.sub)
        return reply.code(401).send({ error: 're-authenticate to link a sign-in method', code: 'reauth_required' })
      }
      const conn = (await resolveLoginConnections(req.db, req.tenant))
        .find((c) => c.id === req.params.connectionId && (c.kind === 'oidc' || c.kind === 'platform'))
      const cfg = conn ? (conn.kind === 'platform' ? loadPlatformOidc() : await loadTenantOidcById(req.db, conn.id)) : null
      // Same unified 404 discipline as /auth/login: an unknown/disabled/wrong-kind connection id
      // answers identically to a missing one — no oracle for which ids exist.
      if (!conn || !cfg) return reply.code(404).send({ error: 'not found' })
      const redirectUri = `${req.protocol}://${req.headers.host}/auth/link-callback`
      const { url, state, nonce, codeVerifier } = await buildLogin(cfg, redirectUri)
      await saveState(app.valkey, state, {
        nonce, codeVerifier, tenantId: req.tenant.id, returnTo: LINK_RETURN_PATH,
        viaTenantOidc: conn.kind === 'oidc', connectionId: conn.id, linkMemberSub: req.user.sub,
      })
      return reply.send({ url })
    },
  )

  // Where the IdP redirects back to complete a link (#947 / ADR-259 §3.3). PUBLIC in app.ts's hook
  // (skips the ordinary session resolution) because this handler must resolve the session ITSELF and
  // refuse unless it is the SAME member who started the link — the linking-CSRF defence a shared hook
  // cannot express (it would happily accept ANY valid session, which is exactly the attack: start a
  // link as the attacker, hand the URL to a victim, let the victim's own session complete it).
  app.get<{ Querystring: { state?: string; code?: string } }>('/auth/link-callback', async (req, reply) => {
    const tenant = await resolveTenant(req.headers.host)
    if (!tenant) return reply.code(404).send({ error: 'not found' })

    // Consume-once BEFORE anything else (CSRF + replay defense, same as /auth/callback).
    const st = await consumeState(app.valkey, req.query?.state ?? '')
    if (!st || st.tenantId !== tenant.id || !st.linkMemberSub) {
      return reply.redirect(`${LINK_RETURN_PATH}?linkError=1`)
    }

    // The session check: the subject is taken from the STATE, and the session is checked against it —
    // never the other way around (ADR-259 §3.3). Neither value is client-supplied.
    const sid = req.cookies?.[SESSION_COOKIE]
    const sess = sid ? await readSession(app.valkey, sid) : null
    if (!sess || sess.tenantId !== tenant.id || sess.sub !== st.linkMemberSub) {
      return reply.redirect(`${LINK_RETURN_PATH}?linkError=1`)
    }

    const db = await acquireTenantDb(tenant)
    try {
      const conn = st.connectionId
        ? (await resolveLoginConnections(db, tenant)).find((c) => c.id === st.connectionId && (c.kind === 'oidc' || c.kind === 'platform'))
        : null
      const cfg = conn ? (conn.kind === 'platform' ? loadPlatformOidc() : await loadTenantOidcById(db, conn.id)) : null
      if (!conn || !cfg || (conn.kind === 'oidc') !== st.viaTenantOidc) {
        return reply.redirect(`${LINK_RETURN_PATH}?linkError=1`)
      }

      const currentUrl = `${req.protocol}://${req.headers.host}${req.url}`
      let claims
      try {
        claims = await exchangeCode(cfg, currentUrl, { state: req.query!.state!, nonce: st.nonce, codeVerifier: st.codeVerifier })
      } catch (e) {
        req.log.error({ err: e, tenantId: tenant.id }, 'auth/link-callback: OIDC code exchange failed')
        return reply.redirect(`${LINK_RETURN_PATH}?linkError=1`)
      }

      // The upstream subject comes from THIS server-verified exchange, never from anything the client
      // supplied — and the member comes from the state, not from any header or body on this request.
      try {
        await linkMemberIdentity(db, tenant.id, conn.id, claims.sub, st.linkMemberSub)
      } catch (e) {
        if ((e as { code?: string }).code === 'identity_taken') {
          req.log.info({ tenantId: tenant.id }, 'auth/link-callback: refused — identity already linked to a different member')
          return reply.redirect(`${LINK_RETURN_PATH}?linkError=taken`)
        }
        throw e
      }
      return reply.redirect(`${LINK_RETURN_PATH}?linked=1`)
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
      // #905: the tenant the server resolved from the Host. The web composes the collaboration
      // room name from this; a build-time constant ('tenant_dev') made collab refuse every
      // member of every other tenant with 'tenant mismatch', and publish then shipped the
      // empty persisted draft as a success.
      tenantId: req.tenant.id,
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
