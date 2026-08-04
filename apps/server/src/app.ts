import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import formbody from '@fastify/formbody'
import type { Tenant, ResourceRef, Capability } from '@wikistead/types'
import { resolveTenantFromHost, loadTenant } from './tenant.js'
import { acquireTenantDb } from './db/index.js'
import { pool } from './db/pool.js'
import { checkReadiness } from './readiness.js'
import type { TenantDb } from './db/index.js'
import { fgaClient, isTenantMember } from '@wikistead/authz'
import { makeMemberVerifier, looksLikeGuestToken, verifyGuestToken } from '@wikistead/auth'
import { verifyApiKey } from './api-key-auth.js'
import { resolveEntitlements } from '@wikistead/entitlements'
import { bumpRateBucket, API_RATE_LIMIT_WINDOW_S } from './rate-limit.js'
import { getAuthProviders, getSearchDriver, getEmailDriver, getEeFeatures, type EmailDriver } from '@wikistead/hooks'
import { resolveEmailDriver } from './email/index.js'
import { emit, onDomainEvent } from '@wikistead/events'
import { publishRevoke } from './collab-revoke.js'
import { LogicalSearchDriver } from './search/index.js'
import type { SearchDriver } from './search/index.js'
import { setDictInvalidatePublisher, DICT_CHANNEL_PREFIX } from './search/outbox.js'
import { LogicalStorageDriver } from './storage/index.js'
import type { StorageDriver } from './storage/index.js'
import IORedis from 'ioredis'
import { invalidateTitleDictCache } from './title-dict-cache.js' // #534
import { invalidateTreeConfirmCache } from './tree-confirm-cache.js' // #541
import { assertLoginCeilingValid } from './auth/login-methods.js' // #537
import { SESSION_COOKIE, readSession } from './auth/session.js'
import { assertSecretKey } from './auth/secret-crypto.js'
import { spacesPlugin } from './routes/spaces.js'
import { pagesPlugin } from './routes/pages.js'
import { templatesPlugin } from './routes/templates.js'
import { billingPlugin } from './routes/billing.js'
import { searchPlugin } from './routes/search.js'
import { attachmentsPlugin } from './routes/attachments.js'
import { revisionsPlugin } from './routes/revisions.js'
import { publicPlugin } from './routes/public.js'
import { publicShellPlugin, publicRobotsPlugin } from './routes/public-shell.js'
import { auditPlugin } from './routes/audit.js'
import { rolesPlugin } from './routes/roles.js'
import { apiKeysPlugin } from './routes/api-keys.js'
import { shareLinksPlugin } from './routes/share-links.js'
import { pinsPlugin } from './routes/pins.js'
import { notificationsPlugin } from './routes/notifications.js'
import { webhooksPlugin } from './routes/webhooks.js'
import { authPlugin } from './routes/auth.js'
import { authLocalPlugin } from './routes/auth-local.js'
import { accountPlugin } from './routes/account.js'
import { signupPlugin } from './routes/signup.js'
import { membersPlugin } from './routes/members.js'
import { commentsPlugin } from './routes/comments.js'
import { exportPlugin } from './routes/export.js'
import { brandingPlugin } from './routes/branding.js'
import { abuseConfigPlugin } from './routes/abuse-config.js' // #491
import { tenantOidcPlugin } from './routes/tenant-oidc.js'
import { adminLoginMethodsPlugin } from './routes/admin-login-methods.js' // #537 Slice 3
import { adminConnectionsPlugin } from './routes/admin-connections.js' // #554 S4
import { adminSurfacesPlugin } from './routes/admin-surfaces.js' // #604-B which admin surfaces the caller may enter
import { orphanDraftsPlugin } from './routes/orphan-drafts.js'
import { customDomainsPlugin } from './routes/custom-domains.js'
import { mcpOAuthMetadataPlugin } from './routes/mcp-oauth-metadata.js'
import { mcpOAuthRegisterPlugin } from './routes/mcp-oauth-register.js'
import { mcpOAuthFlowPlugin } from './routes/mcp-oauth-flow.js'
import { mcpOAuthTokenPlugin } from './routes/mcp-oauth-token.js'
import { mcpPlugin } from './routes/mcp.js'
import { enrollmentPlugin } from './auth/enroll-domains.js'
import { aiPlugin } from './routes/ai.js'
// #178 / ADR-084: SCIM (scim-tokens + scim router) is EE and now lives in @wikistead-ee/server; it is
// mounted via the getEeFeatures seam by the EE composition root, NOT imported here (CE stays EE-free).

declare module 'fastify' {
  interface FastifyInstance {
    fga: typeof fgaClient
    searchDriver: SearchDriver
    storageDriver: StorageDriver
    email: EmailDriver
    valkey: IORedis
  }
  interface FastifyRequest {
    tenant: Tenant
    db: TenantDb
    user: { sub: string; groups: string[] }
    // Set ONLY on routes that declare `config: { guest }` and only when an anonymous
    // share (guest) token is presented. Distinct from `user` so member-only routes
    // (which read `user`) are never reachable by a guest. Authority is still derived
    // from OpenFGA per request (the token asserts intent, not authority).
    // #331 / ADR-138 (C-6): anonId is the pseudonymous per-session id carried in the token claim. Used ONLY as
    // the recorded actor for attribution (revision/feed) — NOT for authority (authz stays on shareLinkId).
    guest?: { shareLinkId: string; resource: ResourceRef; capability: Capability; anonId?: string }
    // Set when authenticated via an API key — the key's scope ceiling. 'read'
    // restricts to GET/HEAD (mutations 403); 'write' is the owner's full authority.
    apiScope?: 'read' | 'write'
  }
  interface FastifyContextConfig {
    // Marks a route as guest-accessible and the capability a guest token must assert to use it (FGA
    // re-checks the share_link's real authority regardless). Links carry view/edit ONLY (#100/ADR-029
    // commenting is a resource setting, not a link capability) — a comment route is `guest: 'view'`
    // (a view token is admitted; the FGA `comment` check then gates on space#comment_open).
    guest?: 'view' | 'edit'
    // Marks a route as public-but-tenant-scoped: the tenant is resolved from the
    // Host, but no authentication is required (e.g. GET /branding). The handler
    // must only return intentionally-public data.
    public?: boolean
  }
}

// Build the Fastify app WITHOUT listening, so tests can drive it via app.inject
// (the auth hook — cookie sessions, cross-tenant rejection — is HTTP-level and
// must be exercised through real requests). The entry (index.ts) calls listen.
export async function buildApp(): Promise<FastifyInstance> {
  // #537 B8: a ceiling that names no valid method would 404 every login and lock everyone out
  // that is a configuration error, surfaced at boot, never as mysterious 404s.
  assertLoginCeilingValid()

  // Fail-closed at boot: refuse to start without a valid OIDC secret key (would
  // otherwise risk plaintext secret storage). See auth/secret-crypto.ts.
  assertSecretKey()

  // trustProxy: behind the prod reverse proxy (ADR-039) the client IP arrives via
  // X-Forwarded-For; without this req.ip would be the proxy's address, defeating the
  // per-IP rate limit on the public share-link exchange (#107). In dev (no proxy) there is
  // no XFF, so req.ip stays the socket address. Always deploy behind the trusted proxy.
  const app = Fastify({ logger: true, trustProxy: true })
  await app.register(cors, { origin: true })
  await app.register(cookie)
  await app.register(formbody) // SAML ACS uses the form-urlencoded POST binding (#135)

  app.decorate('fga', fgaClient)

  // EE may register an alternative SearchDriver via registerSearchDriver(@wikistead/hooks).
  const searchDriver = getSearchDriver(new LogicalSearchDriver())
  await searchDriver.ensureIndex()
  app.decorate('searchDriver', searchDriver)

  const storageDriver = new LogicalStorageDriver()
  await storageDriver.ensureBucket()
  app.decorate('storageDriver', storageDriver)

  const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
  app.decorate('valkey', valkey)

  // #224 / ADR-104 Finding B: the title-dictionary security-timing invalidation. The trusted outbox
  // path publishes wks:dict:<tenantId> {pageId} after each successful reindex; the collab server fans
  // it out to connected clients over the existing WS (stateless message), which drop the title from
  // their in-memory dictionary in-window. Liveness only — the dictionary endpoint stays the authority.
  setDictInvalidatePublisher((tenantId, pageId) => {
    // #534: the server forgets its own cached dictionaries for this tenant in the same breath it tells the
    // browsers to forget theirs, so the cache cannot outlive the signal that makes it wrong.
    invalidateTitleDictCache(tenantId)
    invalidateTreeConfirmCache(tenantId) // #541: the tree's confirm cache dies on the same signal
    void valkey.publish(`${DICT_CHANNEL_PREFIX}${tenantId}`, JSON.stringify({ pageId })).catch(() => { /* liveness only */ })
  })

  // Active guest disconnect on share-link revoke (#106 / ADR-028). revokeShareLink already
  // deletes the FGA tuple (the authority) and emits share_link.revoked; here we forward that
  // to the collab server over Valkey so connected guests on the link are severed at once.
  // Best-effort liveness: the guest TTL + the collab reconnect FGA check are the backstop, so
  // a failed publish never affects the (already-completed) revocation.
  onDomainEvent((e) => {
    if (e.type === 'share_link.revoked') {
      void publishRevoke(valkey, { tenantId: e.tenantId, pageId: e.pageId, shareLinkId: e.shareLinkId })
    }
  })

  // Metered usage alerts (#128 / ADR-082): the CE baseline logs that a soft-cap threshold was crossed
  // so the warning is at least visible in app logs ("no silent runaway bill"). EE/Cloud registers its
  // own subscriber to notify the admin (email/in-app); this CE sink is additive and never throws.
  onDomainEvent((e) => {
    if (e.type === 'usage.threshold_crossed') {
      app.log.warn(
        { tenantId: e.tenantId, resource: e.resource, threshold: e.threshold, period: e.period },
        'metered usage crossed an alert threshold (soft-cap approaching)',
      )
    }
  })

  // Transactional email (P1.3). EE/Cloud may registerEmailDriver; CE uses SMTP
  // when configured, else a no-op (announced once — see email/index.ts).
  app.decorate('email', getEmailDriver(resolveEmailDriver((m) => app.log.info(m))))
  // #547 S2: delivery-class builders register at app build so the drain (and drain-driving tests)
  // can resolve them; registration is idempotent (a Map set).
  await import('./email/mention-builder.js')
  await import('./email/digest.js') // #547 S4: the digest builder

  const verifyMember = makeMemberVerifier({
    issuer: process.env.OIDC_ISSUER!,
    jwksUri: process.env.OIDC_JWKS_URI!,
  })
  // Guest (anonymous share) tokens reuse the collab signing secret + verifier, so
  // the HTTP guest path and the collab join point validate identically.
  const guestCfg = {
    secret: process.env.GUEST_TOKEN_SECRET!,
    ttlSeconds: Number(process.env.GUEST_TOKEN_TTL_SECONDS ?? 3600),
  }

  // #400: liveness stays STATIC (a dependency outage must not make k8s kill/restart the pod — that
  // fixes nothing and loses the in-flight work); readiness pings every hard dependency so a pod with
  // a broken DB/FGA/Valkey/search link drops out of the Service until it recovers. The response is
  // booleans only (this is an unauthenticated endpoint — failure details go to the log, never the body).
  app.get('/healthz', async () => ({ ok: true }))
  app.get('/readyz', async (req, reply) => {
    const result = await checkReadiness({
      db: () => pool`SELECT 1`.then(() => undefined),
      fga: () => fgaClient.readAuthorizationModels({ pageSize: 1 }).then(() => undefined),
      valkey: () => valkey.ping().then(() => undefined),
      search: () => searchDriver.ensureIndex(), // idempotent; the Meili driver reaches the server, Logical no-ops
    }, (dep, err) => req.log.warn({ dep, err }, 'readyz: dependency ping failed'))
    if (!result.ok) reply.code(503)
    return result
  })

  // Defense-in-depth security headers on EVERY response (#148 deploy-gate / ADR-039). The prod proxy
  // is expected to set these too, but the SERVER is the fortress — it must not depend on a correctly
  // configured proxy (a proxy misconfig would otherwise silently drop them). nosniff + Referrer-Policy
  // are always safe; HSTS is sent ONLY over HTTPS (guarded by X-Forwarded-Proto/protocol) so dev HTTP
  // / localhost is never HSTS-pinned. Applies to API JSON, errors, and 404s alike.
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    const xfp = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim()
    if (xfp === 'https' || req.protocol === 'https') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    return payload
  })

  app.addHook('onRequest', async (req, reply) => {
    // Public / pre-session routes resolve their own tenant; no auth required.
    // /auth/login + /auth/callback (added in C3) establish the session, so they
    // must be reachable WITHOUT one.
    if (req.url === '/healthz' || req.url === '/readyz' ||
        req.url.startsWith('/webhooks/stripe') || req.url.startsWith('/public/') || // ONLY the Stripe inbound
        req.url.startsWith('/pub/') || // #409 / ADR-154: the crawler-facing HTML shell resolves its own tenant + anonymous gate
        req.url === '/robots.txt' || req.url === '/sitemap.xml' || // #408 / ADR-154 §2: crawler surface, self-gated
        // receiver is public here — NOT all of /webhooks/ (the outbound-webhook admin CRUD /webhooks/:id is
        // a member/admin route and must go through auth; #228 collided with the old broad /webhooks/ prefix).
        req.url.startsWith('/auth/login') || req.url.startsWith('/auth/callback') ||
        req.url.startsWith('/auth/saml/') || // SAML SP-initiated login + ACS establish the session (#135)
        req.url.startsWith('/scim/v2/') || // SCIM uses its own scm_ bearer scheme; authenticated in scimPlugin (#134)
        req.url.startsWith('/signup/')) return

    const { slug, domain } = resolveTenantFromHost(req.headers.host ?? '')
    const tenant = await loadTenant(slug, domain)
    if (!tenant) {
      await reply.code(404).send({ error: 'tenant not found' })
      return
    }
    req.tenant = tenant
    req.db = await acquireTenantDb(tenant)

    // Public-but-tenant-scoped routes (e.g. GET /branding) opt in via
    // `config: { public: true }`: the tenant is resolved from the Host (so the
    // response is per-tenant and no tenant id is ever in the URL), but NO auth is
    // required — the resource is intentionally public (visible to members, guests,
    // and unauthenticated visitors of the tenant's pages).
    if (req.routeOptions?.config?.public) return

    // #471 / ADR-176: every branch below resolves a PRINCIPAL; membership is settled once, after
    // them all, by the seam at the bottom of this hook. Branches therefore return from here rather
    // than from the hook itself — that is the whole point of the wrapper. A new provider added
    // inside it cannot forget the tenant binding, which is exactly how the OIDC branch came to be
    // missing it.
    let claimedTenant = ''
    const resolvePrincipal = async (): Promise<void> => {
      // ── Browser member path: host-only session cookie (BFF) ──────────────────
      // Three cases, kept distinct
      // (i) no cookie → fall through to Bearer (normal).
      // (ii) cookie, tenant match → member session.
      // (iii) cookie, tenant MISMATCH → EXPLICIT reject + clear cookie. A
      // cross-tenant cookie is an anomaly (host-only should prevent it), so
      // we do NOT silently fall through — we reject so it is distinguishable
      // from a plain "no credentials" 401, and we clear the offending cookie.
      const sid = req.cookies?.[SESSION_COOKIE]
      if (sid) {
        const sess = await readSession(valkey, sid)
        if (sess && sess.tenantId === req.tenant.id) {
          req.user = { sub: sess.sub, groups: sess.groups }
          return
        }
        reply.clearCookie(SESSION_COOKIE, { path: '/' })
        if (sess && sess.tenantId !== req.tenant.id) {
          emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'session', reason: 'tenant mismatch' })
          await reply.code(401).send({ error: 'session tenant mismatch' })
          return
        }
        // sess null (expired/unknown): stale cookie cleared; fall through to Bearer.
      }

      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')

      // Dev bypass — guarded by NODE_ENV !== 'production' (dead in production).
      if (process.env.NODE_ENV !== 'production' && token === 'dev-token') {
        req.user = { sub: 'dev-user', groups: [] }
        emit({ type: 'auth.success', tenantId: req.tenant.id, actorId: 'dev-user', method: 'dev' })
        return
      }

      // Guest (anonymous share) token. Accepted ONLY on routes that opt in via
      // `config: { guest }`; on any other route a guest token is rejected (member
      // routes stay member-only). Sets `req.guest`, NEVER `req.user`. The token
      // asserts intent (tenant/resource/capability); the route handler re-derives
      // authority from OpenFGA against `share_link:<id>` + binds to the URL resource.
      if (looksLikeGuestToken(token)) {
        const need = req.routeOptions?.config?.guest
        const c = need ? await verifyGuestToken(guestCfg, token).catch(() => null) : null
        // Convenience guard (FGA is the real gate): an edit route needs an edit token. Comment routes
        // are `guest: 'view'` (#100) — a view token is admitted here, then the FGA `comment` check gates
        // on the resource's comment_open setting (so a view guest 403s on comment when it's closed).
        const capInsufficient = need === 'edit' && c?.capability !== 'edit'
        if (!need || !c || c.tenantId !== req.tenant.id || capInsufficient) {
          emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'guest', reason: 'guest token rejected' })
          await reply.code(401).send({ error: 'unauthorized' })
          return
        }
        req.guest = { shareLinkId: c.shareLinkId, resource: c.resource, capability: c.capability, anonId: c.anonId }
        emit({ type: 'auth.success', tenantId: req.tenant.id, actorId: `guest:${c.shareLinkId}`, method: 'guest' })
        return
      }

      // EE auth providers (SAML, LDAP, SCIM, ...) tried first; null = cannot handle.
      for (const provider of getAuthProviders()) {
        const result = await provider.verify(token, req.tenant.id)
        if (result) {
          // #554 / ADR-197 §5 (S0): every provider on this extension point asserts an EXTERNAL
          // subject — one gate here covers all present and future providers (the same 401 as any
          // bad token, never an oracle).
          const { externalSubViolation } = await import('./auth/reserved-subs.js')
          if (externalSubViolation(result.sub)) {
            emit({ type: 'auth.failed', tenantId: req.tenant.id, method: provider.name, reason: 'invalid token' })
            await reply.code(401).send({ error: 'unauthorized' })
            return
          }
          req.user = result
          emit({ type: 'auth.success', tenantId: req.tenant.id, actorId: result.sub, method: provider.name })
          return
        }
      }

      // Token-prefix routing: failing one path does NOT fall through to the other.
      if (token.startsWith('wks_')) {
        const apiUser = await verifyApiKey(token, req.tenant.id)
        if (!apiUser) {
          emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'apikey', reason: 'invalid or revoked' })
          await reply.code(401).send({ error: 'invalid or revoked API key' })
          return
        }
        // #476 / ADR-178: the key is good but its owner is deactivated — a seat frozen by a downgrade,
        // which the tenant fixes by upgrading rather than by rotating credentials. Answered like the
        // login path (403 `member_deactivated`) so the integration's owner learns what actually happened;
        // it is only ever shown to someone already holding a valid key for this tenant.
        if (apiUser.deactivated) {
          emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'apikey', reason: 'owner deactivated' })
          await reply.code(403).send({ error: 'account deactivated by a plan change', code: 'member_deactivated' })
          return
        }
        // Scope ceiling (Phase 5f): a 'read' key may only GET/HEAD — any mutation is
        // 403. This only RESTRICTS; FGA still checks the owner's authority, so a key
        // can never exceed its owner. GET routes perform no business writes (audited),
        // so method is a safe read/write proxy.
        if (apiUser.scope === 'read' && req.method !== 'GET' && req.method !== 'HEAD') {
          emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'apikey', reason: 'read-only key on a write' })
          await reply.code(403).send({ error: 'read-only API key' })
          return
        }
        // apiAccess entitlement gate on the REQUEST path (#126 / ADR-063 2 / ADR-064 / ADR-072).
        // createApiKey is gated at issue time, but a plan downgrade that strips apiAccess must ALSO
        // stop already-issued keys — otherwise a downgraded tenant's old key keeps working (monotonic-
        // deny violation). Resolved PER REQUEST so the downgrade takes effect immediately; the key row
        // is NOT deleted (ADR-064 non-destructive — re-upgrade restores it). Evaluated BEFORE the rate
        // limit so an unentitled key gets 403, not 429. (401=invalid key / 403=apiAccess off or
        // read-only scope / 429=rate exceeded.)
        const ent = resolveEntitlements(req.tenant.plan)
        if (!ent.apiAccess) {
          emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'apikey', reason: 'api access not entitled' })
          await reply.code(403).send({ error: 'API access is not available on this plan' })
          return
        }
        // Request rate limit (#175 / ADR-063): per-key (fairness) AND per-tenant (all-keys
        // ceiling), stricter trips first → 429. Limits resolve PER REQUEST so a downgrade takes
        // effect immediately; Infinity (self-host) short-circuits with no Valkey op.
        const rl = ent.apiRateLimit
        if (rl.perKey !== Infinity || rl.perTenant !== Infinity) {
          const okKey = await bumpRateBucket(valkey, `apikey-rl:key:${apiUser.keyId}`, rl.perKey, API_RATE_LIMIT_WINDOW_S)
          const okTenant = await bumpRateBucket(valkey, `apikey-rl:tenant:${req.tenant.id}`, rl.perTenant, API_RATE_LIMIT_WINDOW_S)
          if (!okKey || !okTenant) {
            emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'apikey', reason: 'rate limited' })
            reply.header('Retry-After', String(API_RATE_LIMIT_WINDOW_S))
            await reply.code(429).send({ error: 'rate limit exceeded' })
            return
          }
        }
        req.user = { sub: apiUser.sub, groups: [] }
        req.apiScope = apiUser.scope
        emit({ type: 'auth.success', tenantId: req.tenant.id, actorId: apiUser.sub, method: 'apikey' })
        return
      }

      // OIDC bearer path (programmatic/legacy). Failure → 401, no API key fallback.
      try {
        const m = await verifyMember(token)
        // #554 / ADR-197 §5 (S0): the bearer path creates no row — the asserted sub simply BECOMES
        // the principal, so the reserved-space refusal must live here too (a reserved-prefix or
        // over-long sub answers the seam's own 401, indistinguishable from a bad token).
        const { externalSubViolation } = await import('./auth/reserved-subs.js')
        if (externalSubViolation(m.sub)) throw new Error('reserved subject')
        req.user = { sub: m.sub, groups: m.groups }
        // #471 / ADR-176: the token's own idea of its tenant, kept for the cross-check below. The
        // Host stays the authority (it already picks the RLS context and the FGA object ids); this
        // is only used to refuse a token that says out loud it was minted for somewhere else.
        claimedTenant = m.tenantId
        emit({ type: 'auth.success', tenantId: req.tenant.id, actorId: m.sub, method: 'oidc' })
      } catch {
        emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'oidc', reason: 'token verification failed' })
        await reply.code(401).send({ error: 'unauthorized' })
      }
    }
    await resolvePrincipal()
    if (reply.sent || !req.user) return

    // ── #471 / ADR-176: the tenant binding ────────────────────────────────────
    // Identity is proven above; MEMBERSHIP is settled here, for every principal, once. Until this
    // existed, only the login path asked the question (`establishMemberSession`) and no request path
    // did — so under a shared IdP a member of tenant A was accepted verbatim on tenant B's host, and
    // reached anything granted through a `user:*` wildcard: measurably, `POST /spaces` created a
    // space they then managed inside someone else's tenant (#471).
    //
    // The answer is resolved PER REQUEST, so a removed member is refused on their next call — through
    // an API key as much as through a cookie — rather than at token expiry.
    if (claimedTenant && claimedTenant !== req.tenant.id && claimedTenant !== req.tenant.slug) {
      emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'oidc', reason: 'token tenant claim mismatch' })
      await reply.code(401).send({ error: 'unauthorized' })
      return
    }
    if (!(await isTenantMember(fgaClient, req.user.sub, req.tenant.id))) {
      // A DEDICATED audit reason, so an operator can tell a cross-tenant presentation from a bad
      // token — but the RESPONSE is byte-identical to the generic unauthorized body above. Saying
      // "not a member of this tenant" would answer, for any sub an attacker can authenticate as,
      // which tenants they do belong to.
      // The subject is deliberately NOT recorded: this event reaches the tenant's own webhook
      // subscribers, and naming the foreign sub would tell tenant B who elsewhere holds a token.
      emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'membership', reason: 'not a member of this tenant' })
      await reply.code(401).send({ error: 'unauthorized' })
      return
    }
  })

  app.addHook('onResponse', async (req) => { await req.db?.release() })
  app.addHook('onError',    async (req) => { await req.db?.release() })

  await app.register(authPlugin)
  await app.register(authLocalPlugin) // #568: password sign-in (public route, host-resolved tenant)
  await app.register(accountPlugin)
  await app.register(signupPlugin)
  await app.register(membersPlugin)
  await app.register(commentsPlugin)
  await app.register((await import('./routes/email-unsubscribe.js')).emailUnsubscribePlugin) // #547 S3
  await app.register(exportPlugin)
  await app.register(brandingPlugin)
  await app.register(abuseConfigPlugin) // #491: tenant-admin abuse-filter config
  await app.register(tenantOidcPlugin)
  await app.register(adminLoginMethodsPlugin) // #537: the login-methods view + platform-login toggle
  await app.register(adminConnectionsPlugin) // #554 S4: N-connection management
  await app.register(adminSurfacesPlugin) // #604-B: the console's entry/nav answer (registry-driven)
  await app.register(orphanDraftsPlugin)
  await app.register(webhooksPlugin)
  await app.register(customDomainsPlugin)
  await app.register(mcpOAuthMetadataPlugin) // #311 / ADR-131: MCP OAuth 2.1 discovery metadata (public; no token/DCR yet)
  await app.register(mcpOAuthRegisterPlugin) // #311 / ADR-131 slice 2: RFC 7591 DCR (public client; no token mint yet)
  await app.register(mcpOAuthFlowPlugin) // #311 / ADR-131 slice 3b: authorize → login-delegate → code (no token yet)
  await app.register(mcpOAuthTokenPlugin) // #311 / ADR-131 slice 4: token endpoint (PKCE + tenant-bound access token)
  await app.register(mcpPlugin) // #311 / ADR-131 slice 5: the /mcp JSON-RPC endpoint (Bearer-auth'd read tools)
  await app.register(enrollmentPlugin)
  // #178: SAML (tenant-saml + saml-auth) is an EE feature — physically moved to packages/ee-server and
  // mounted via the getEeFeatures seam by the EE composition root. A CE build registers no SAML here.
  await app.register(aiPlugin)
  await app.register(spacesPlugin)
  await app.register(pagesPlugin)
  await app.register(templatesPlugin)
  await app.register(billingPlugin)
  await app.register(searchPlugin)
  await app.register(attachmentsPlugin)
  await app.register(revisionsPlugin)
  await app.register(publicPlugin)
  await app.register(publicShellPlugin) // #409 / ADR-154: /pub HTML shell (no-op unless PUBLIC_SHELL_INDEX is set)
  await app.register(publicRobotsPlugin) // #408 / ADR-154 §2: robots.txt + sitemap.xml (parent-switch gated)
  await app.register(auditPlugin) // #401 / ADR-155: audit-log viewer (tenant-admin + auditLog entitlement)
  await app.register(rolesPlugin) // #420 / ADR-164: custom-role definitions (tenant-admin + customRoles entitlement)
  await app.register(apiKeysPlugin)
  await app.register(shareLinksPlugin)
  await app.register(pinsPlugin) // #284: member pins (member-only — no guest opt-in)
  await app.register(notificationsPlugin) // #320 / ADR-126: watch / notifications / feed (member-only)

  // #178 / ADR-084: EE feature mount seam. A CE / self-host build registers nothing → no-op. The EE
  // composition root (packages/ee-server/src/main.ts — the entrypoint that may import @wikistead-ee/*)
  // calls registerEeFeatures before buildApp, and its mount receives the app as the host to register EE
  // plugins on. SCIM now mounts HERE (moved into @wikistead-ee/server this slice); SAML / EE-audit /
  // operator-ledger migrate onto this seam in later #178 slices. getEeFeatures is null on a CE build.
  await getEeFeatures()?.(app)

  app.get('/', async (req) => ({ service: 'kb-server', tenant: req.tenant?.slug }))

  return app
}
