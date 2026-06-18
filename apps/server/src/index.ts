import Fastify from 'fastify'
import cors from '@fastify/cors'
import type { Tenant } from '@wikistead/types'
import { resolveTenantFromHost, loadTenant } from './tenant.js'
import { acquireTenantDb } from './db/index.js'
import type { TenantDb } from './db/index.js'
import { fgaClient } from '@wikistead/authz'
import { makeMemberVerifier } from '@wikistead/auth'
import { verifyApiKey } from './api-key-auth.js'
import { getAuthProviders, getSearchDriver } from '@wikistead/hooks'
import { emit } from '@wikistead/events'
import { LogicalSearchDriver } from './search/index.js'
import type { SearchDriver } from './search/index.js'
import { LogicalStorageDriver } from './storage/index.js'
import type { StorageDriver } from './storage/index.js'
import IORedis from 'ioredis'
import { spacesPlugin } from './routes/spaces.js'
import { pagesPlugin } from './routes/pages.js'
import { billingPlugin } from './routes/billing.js'
import { searchPlugin } from './routes/search.js'
import { attachmentsPlugin } from './routes/attachments.js'
import { revisionsPlugin } from './routes/revisions.js'
import { publicPlugin } from './routes/public.js'
import { apiKeysPlugin } from './routes/api-keys.js'
import { shareLinksPlugin } from './routes/share-links.js'

declare module 'fastify' {
  interface FastifyInstance {
    fga: typeof fgaClient
    searchDriver: SearchDriver
    storageDriver: StorageDriver
    valkey: IORedis
  }
  interface FastifyRequest {
    tenant: Tenant
    db: TenantDb
    user: { sub: string; groups: string[] }
  }
}

const app = Fastify({ logger: true })
await app.register(cors, { origin: true })

app.decorate('fga', fgaClient)

// Initialize search driver and configure Meilisearch index settings (idempotent).
// EE may register an alternative SearchDriver via registerSearchDriver(@wikistead/hooks).
// Falls back to LogicalSearchDriver when no EE driver is registered.
const searchDriver = getSearchDriver(new LogicalSearchDriver())
await searchDriver.ensureIndex()
app.decorate('searchDriver', searchDriver)

const storageDriver = new LogicalStorageDriver()
await storageDriver.ensureBucket()
app.decorate('storageDriver', storageDriver)

const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
app.decorate('valkey', valkey)

const verifyMember = makeMemberVerifier({
  issuer: process.env.OIDC_ISSUER!,
  jwksUri: process.env.OIDC_JWKS_URI!,
})

app.get('/healthz', async () => ({ ok: true }))
app.get('/readyz', async () => ({ ok: true }))

app.addHook('onRequest', async (req, reply) => {
  // Public routes handle their own tenant resolution; no auth required.
  if (req.url === '/healthz' || req.url === '/readyz' ||
      req.url.startsWith('/webhooks/') || req.url.startsWith('/public/')) return

  const { slug, domain } = resolveTenantFromHost(req.headers.host ?? '')
  const tenant = await loadTenant(slug, domain)
  if (!tenant) {
    await reply.code(404).send({ error: 'tenant not found' })
    return
  }
  req.tenant = tenant
  req.db = await acquireTenantDb(tenant)

  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')

  // Dev bypass — guarded by NODE_ENV !== 'production'.
  // In production NODE_ENV is always 'production'; this branch is dead.
  if (process.env.NODE_ENV !== 'production' && token === 'dev-token') {
    req.user = { sub: 'dev-user', groups: [] }
    emit({ type: 'auth.success', tenantId: req.tenant.id, actorId: 'dev-user', method: 'dev' })
    return
  }

  // EE auth providers (SAML, LDAP, SCIM, etc.) are tried first.
  // They return null if they cannot handle the token; the next path is then tried.
  // Each provider is its own path — there is no fallback between providers.
  for (const provider of getAuthProviders()) {
    const result = await provider.verify(token, req.tenant.id)
    if (result) {
      req.user = result
      emit({ type: 'auth.success', tenantId: req.tenant.id, actorId: result.sub, method: provider.name })
      return
    }
  }

  // Authentication routing: the token prefix determines the path.
  // Failing one path does NOT fall through to the other.
  if (token.startsWith('wks_')) {
    // API key path. Failure → 401, no OIDC fallback.
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

  // OIDC member path. Failure → 401, no API key fallback.
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

await app.register(spacesPlugin)
await app.register(pagesPlugin)
await app.register(billingPlugin)
await app.register(searchPlugin)
await app.register(attachmentsPlugin)
await app.register(revisionsPlugin)
await app.register(publicPlugin)
await app.register(apiKeysPlugin)
await app.register(shareLinksPlugin)

// TODO stubs (see original comments):
// POST /attachments/presign    [phase: storage]
// GET  /entitlements           (registered in billingPlugin)
// share links (POST/GET/DELETE /share-links, POST /public/share-links/:id/token)
//   are implemented in shareLinksPlugin.
app.get('/', async (req) => ({ service: 'kb-server', tenant: req.tenant?.slug }))

const port = Number(process.env.SERVER_PORT ?? 4000)
app.listen({ port, host: '0.0.0.0' }).catch((e) => {
  app.log.error(e)
  process.exit(1)
})
