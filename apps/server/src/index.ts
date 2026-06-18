import Fastify from 'fastify'
import cors from '@fastify/cors'
import type { Tenant } from '@kb/types'
import { resolveTenantFromHost, loadTenant } from './tenant.js'
import { acquireTenantDb } from './db/index.js'
import type { TenantDb } from './db/index.js'
import { fgaClient } from '@kb/authz'
import { makeMemberVerifier } from '@kb/auth'
import { verifyApiKey } from './api-key-auth.js'
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
const searchDriver = new LogicalSearchDriver()
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
    return
  }

  // Authentication routing: the token prefix determines the path.
  // Failing one path does NOT fall through to the other — this prevents
  // an attacker from using a partially valid API key to probe the OIDC path
  // (or vice versa).
  if (token.startsWith('kb_')) {
    // API key path. Failure → 401, no OIDC fallback.
    const apiUser = await verifyApiKey(token, req.tenant.id)
    if (!apiUser) {
      await reply.code(401).send({ error: 'invalid or revoked API key' })
      return
    }
    // API key acts as user:{ownerUserId} — same FGA principal as a member.
    // Per-page authorisation (check / filterAuthorized) is unchanged.
    req.user = { sub: apiUser.sub, groups: [] }
    return
  }

  // OIDC member path. Failure → 401, no API key fallback.
  try {
    const m = await verifyMember(token)
    req.user = { sub: m.sub, groups: m.groups }
  } catch {
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

// TODO stubs (see original comments):
// POST /share-links            [phase: guest]
// DELETE /share-links/:id      [phase: guest]
// POST /attachments/presign    [phase: storage]
// GET  /entitlements           (registered in billingPlugin)
app.get('/', async (req) => ({ service: 'kb-server', tenant: req.tenant?.slug }))

const port = Number(process.env.SERVER_PORT ?? 4000)
app.listen({ port, host: '0.0.0.0' }).catch((e) => {
  app.log.error(e)
  process.exit(1)
})
