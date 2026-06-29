import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import formbody from '@fastify/formbody'
import type { Tenant, ResourceRef, Capability } from '@wikistead/types'
import { resolveTenantFromHost, loadTenant } from './tenant.js'
import { acquireTenantDb } from './db/index.js'
import type { TenantDb } from './db/index.js'
import { fgaClient } from '@wikistead/authz'
import { makeMemberVerifier, looksLikeGuestToken, verifyGuestToken } from '@wikistead/auth'
import { verifyApiKey } from './api-key-auth.js'
import { resolveEntitlements } from '@wikistead/entitlements'
import { bumpRateBucket, API_RATE_LIMIT_WINDOW_S } from './rate-limit.js'
import { getAuthProviders, getSearchDriver, getEmailDriver, type EmailDriver } from '@wikistead/hooks'
import { resolveEmailDriver } from './email/index.js'
import { emit, onDomainEvent } from '@wikistead/events'
import { publishRevoke } from './collab-revoke.js'
import { LogicalSearchDriver } from './search/index.js'
import type { SearchDriver } from './search/index.js'
import { LogicalStorageDriver } from './storage/index.js'
import type { StorageDriver } from './storage/index.js'
import IORedis from 'ioredis'
import { SESSION_COOKIE, readSession } from './auth/session.js'
import { assertSecretKey } from './auth/secret-crypto.js'
import { spacesPlugin } from './routes/spaces.js'
import { pagesPlugin } from './routes/pages.js'
import { billingPlugin } from './routes/billing.js'
import { searchPlugin } from './routes/search.js'
import { attachmentsPlugin } from './routes/attachments.js'
import { revisionsPlugin } from './routes/revisions.js'
import { publicPlugin } from './routes/public.js'
import { apiKeysPlugin } from './routes/api-keys.js'
import { shareLinksPlugin } from './routes/share-links.js'
import { authPlugin } from './routes/auth.js'
import { accountPlugin } from './routes/account.js'
import { signupPlugin } from './routes/signup.js'
import { membersPlugin } from './routes/members.js'
import { commentsPlugin } from './routes/comments.js'
import { exportPlugin } from './routes/export.js'
import { brandingPlugin } from './routes/branding.js'
import { tenantOidcPlugin } from './routes/tenant-oidc.js'
import { orphanDraftsPlugin } from './routes/orphan-drafts.js'
import { customDomainsPlugin } from './routes/custom-domains.js'
import { tenantSamlPlugin } from './routes/tenant-saml.js'
import { samlAuthPlugin } from './routes/saml-auth.js'

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
    guest?: { shareLinkId: string; resource: ResourceRef; capability: Capability }
    // Set when authenticated via an API key — the key's scope ceiling. 'read'
    // restricts to GET/HEAD (mutations 403); 'write' is the owner's full authority.
    apiScope?: 'read' | 'write'
  }
  interface FastifyContextConfig {
    // Marks a route as guest-accessible and the capability a guest token must assert
    // to use it (FGA re-checks the share_link's real authority regardless). 'comment'
    // (#100) gates guest commenting — a view-only token is rejected by the convenience
    // guard below; edit ⊃ comment, so an edit token also satisfies a comment route.
    guest?: 'view' | 'edit' | 'comment'
    // Marks a route as public-but-tenant-scoped: the tenant is resolved from the
    // Host, but no authentication is required (e.g. GET /branding). The handler
    // must only return intentionally-public data.
    public?: boolean
  }
}

// Build the Fastify app WITHOUT listening, so tests can drive it via app.inject
// (the auth hook — cookie sessions, cross-tenant rejection — is HTTP-level and
// must be exercised through real requests). The entry (index.ts) calls listen().
export async function buildApp(): Promise<FastifyInstance> {
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

  // Transactional email (P1.3). EE/Cloud may registerEmailDriver; CE uses SMTP
  // when configured, else a no-op (announced once — see email/index.ts).
  app.decorate('email', getEmailDriver(resolveEmailDriver((m) => app.log.info(m))))

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

  app.get('/healthz', async () => ({ ok: true }))
  app.get('/readyz', async () => ({ ok: true }))

  app.addHook('onRequest', async (req, reply) => {
    // Public / pre-session routes resolve their own tenant; no auth required.
    // /auth/login + /auth/callback (added in C3) establish the session, so they
    // must be reachable WITHOUT one.
    if (req.url === '/healthz' || req.url === '/readyz' ||
        req.url.startsWith('/webhooks/') || req.url.startsWith('/public/') ||
        req.url.startsWith('/auth/login') || req.url.startsWith('/auth/callback') ||
        req.url.startsWith('/auth/saml/') || // SAML SP-initiated login + ACS establish the session (#135)
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

    // ── Browser member path: host-only session cookie (BFF) ──────────────────
    // Three cases, kept distinct:
    //   (i)   no cookie            → fall through to Bearer (normal).
    //   (ii)  cookie, tenant match → member session.
    //   (iii) cookie, tenant MISMATCH → EXPLICIT reject + clear cookie. A
    //         cross-tenant cookie is an anomaly (host-only should prevent it), so
    //         we do NOT silently fall through — we reject so it is distinguishable
    //         from a plain "no credentials" 401, and we clear the offending cookie.
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
      // need-but-not-edit-token guard (convenience layer; FGA is the real gate).
      // Convenience guard (FGA is the real gate): an edit route needs an edit token; a
      // comment route needs comment-or-edit (a view-only token can't comment).
      const capInsufficient =
        (need === 'edit' && c?.capability !== 'edit') ||
        (need === 'comment' && c?.capability !== 'comment' && c?.capability !== 'edit')
      if (!need || !c || c.tenantId !== req.tenant.id || capInsufficient) {
        emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'guest', reason: 'guest token rejected' })
        await reply.code(401).send({ error: 'unauthorized' })
        return
      }
      req.guest = { shareLinkId: c.shareLinkId, resource: c.resource, capability: c.capability }
      emit({ type: 'auth.success', tenantId: req.tenant.id, actorId: `guest:${c.shareLinkId}`, method: 'guest' })
      return
    }

    // EE auth providers (SAML, LDAP, SCIM, ...) tried first; null = cannot handle.
    for (const provider of getAuthProviders()) {
      const result = await provider.verify(token, req.tenant.id)
      if (result) {
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
      // Scope ceiling (Phase 5f): a 'read' key may only GET/HEAD — any mutation is
      // 403. This only RESTRICTS; FGA still checks the owner's authority, so a key
      // can never exceed its owner. GET routes perform no business writes (audited),
      // so method is a safe read/write proxy.
      if (apiUser.scope === 'read' && req.method !== 'GET' && req.method !== 'HEAD') {
        emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'apikey', reason: 'read-only key on a write' })
        await reply.code(403).send({ error: 'read-only API key' })
        return
      }
      // Request rate limit (#175 / ADR-063): per-key (fairness) AND per-tenant (all-keys
      // ceiling), stricter trips first → 429. Limits resolve PER REQUEST so a downgrade takes
      // effect immediately; Infinity (self-host) short-circuits with no Valkey op.
      const rl = resolveEntitlements(req.tenant.plan).apiRateLimit
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
      req.user = { sub: m.sub, groups: m.groups }
      emit({ type: 'auth.success', tenantId: req.tenant.id, actorId: m.sub, method: 'oidc' })
    } catch {
      emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'oidc', reason: 'token verification failed' })
      await reply.code(401).send({ error: 'unauthorized' })
    }
  })

  app.addHook('onResponse', async (req) => { await req.db?.release() })
  app.addHook('onError',    async (req) => { await req.db?.release() })

  await app.register(authPlugin)
  await app.register(accountPlugin)
  await app.register(signupPlugin)
  await app.register(membersPlugin)
  await app.register(commentsPlugin)
  await app.register(exportPlugin)
  await app.register(brandingPlugin)
  await app.register(tenantOidcPlugin)
  await app.register(orphanDraftsPlugin)
  await app.register(customDomainsPlugin)
  await app.register(tenantSamlPlugin)
  await app.register(samlAuthPlugin)
  await app.register(spacesPlugin)
  await app.register(pagesPlugin)
  await app.register(billingPlugin)
  await app.register(searchPlugin)
  await app.register(attachmentsPlugin)
  await app.register(revisionsPlugin)
  await app.register(publicPlugin)
  await app.register(apiKeysPlugin)
  await app.register(shareLinksPlugin)

  app.get('/', async (req) => ({ service: 'kb-server', tenant: req.tenant?.slug }))

  return app
}
