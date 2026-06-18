import Fastify from 'fastify'
import cors from '@fastify/cors'
import type { Tenant } from '@kb/types'
import { resolveTenantFromHost, loadTenant } from './tenant.js'
import { acquireTenantDb } from './db/index.js'
import type { TenantDb } from './db/index.js'
import { fgaClient } from '@kb/authz'
import { makeMemberVerifier } from '@kb/auth'
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
  if (req.url === '/healthz' || req.url === '/readyz' || req.url.startsWith('/webhooks/')) return

  const { slug, domain } = resolveTenantFromHost(req.headers.host ?? '')
  const tenant = await loadTenant(slug, domain)
  if (!tenant) {
    await reply.code(404).send({ error: 'tenant not found' })
    return
  }
  req.tenant = tenant
  req.db = await acquireTenantDb(tenant)

  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  if (process.env.NODE_ENV !== 'production' && token === 'dev-token') {
    req.user = { sub: 'dev-user', groups: [] }
    return
  }
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
