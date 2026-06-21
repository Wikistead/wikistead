import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import type { Tenant } from '@wikistead/types'
import { resolveTenantFromHost, loadTenant } from './tenant.js'
import { acquireTenantDb } from './db/index.js'
import type { TenantDb } from './db/index.js'
import { fgaClient } from '@wikistead/authz'
import { makeMemberVerifier } from '@wikistead/auth'
import { verifyApiKey } from './api-key-auth.js'
import { getAuthProviders, getSearchDriver, getEmailDriver, type EmailDriver } from '@wikistead/hooks'
import { resolveEmailDriver } from './email/index.js'
import { emit } from '@wikistead/events'
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
import { signupPlugin } from './routes/signup.js'
import { membersPlugin } from './routes/members.js'
import { commentsPlugin } from './routes/comments.js'
import { exportPlugin } from './routes/export.js'

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
  }
}

// Build the Fastify app WITHOUT listening, so tests can drive it via app.inject
// (the auth hook — cookie sessions, cross-tenant rejection — is HTTP-level and
// must be exercised through real requests). The entry (index.ts) calls listen().
export async function buildApp(): Promise<FastifyInstance> {
  // Fail-closed at boot: refuse to start without a valid OIDC secret key (would
  // otherwise risk plaintext secret storage). See auth/secret-crypto.ts.
  assertSecretKey()

  const app = Fastify({ logger: true })
  await app.register(cors, { origin: true })
  await app.register(cookie)

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

  // Transactional email (P1.3). EE/Cloud may registerEmailDriver; CE uses SMTP
  // when configured, else a no-op (announced once — see email/index.ts).
  app.decorate('email', getEmailDriver(resolveEmailDriver((m) => app.log.info(m))))

  const verifyMember = makeMemberVerifier({
    issuer: process.env.OIDC_ISSUER!,
    jwksUri: process.env.OIDC_JWKS_URI!,
  })

  app.get('/healthz', async () => ({ ok: true }))
  app.get('/readyz', async () => ({ ok: true }))

  app.addHook('onRequest', async (req, reply) => {
    // Public / pre-session routes resolve their own tenant; no auth required.
    // /auth/login + /auth/callback (added in C3) establish the session, so they
    // must be reachable WITHOUT one.
    if (req.url === '/healthz' || req.url === '/readyz' ||
        req.url.startsWith('/webhooks/') || req.url.startsWith('/public/') ||
        req.url.startsWith('/auth/login') || req.url.startsWith('/auth/callback') ||
        req.url.startsWith('/signup/')) return

    const { slug, domain } = resolveTenantFromHost(req.headers.host ?? '')
    const tenant = await loadTenant(slug, domain)
    if (!tenant) {
      await reply.code(404).send({ error: 'tenant not found' })
      return
    }
    req.tenant = tenant
    req.db = await acquireTenantDb(tenant)

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
      req.user = { sub: apiUser.sub, groups: [] }
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
  await app.register(signupPlugin)
  await app.register(membersPlugin)
  await app.register(commentsPlugin)
  await app.register(exportPlugin)
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
