import Fastify from 'fastify'
import cors from '@fastify/cors'
import type { Tenant } from '@kb/types'
import { resolveTenantFromHost, loadTenant } from './tenant.js'
import { acquireTenantDb } from './db/index.js'
import type { TenantDb } from './db/index.js'

declare module 'fastify' {
  interface FastifyRequest {
    // Set in onRequest before any handler runs. Routes are guaranteed to have
    // both fields; the 404 path short-circuits before any handler executes.
    tenant: Tenant
    db: TenantDb
  }
}

const app = Fastify({ logger: true })
await app.register(cors, { origin: true })

app.get('/healthz', async () => ({ ok: true }))
app.get('/readyz', async () => ({ ok: true })) // TODO: probe pg/valkey/fga/meili

app.addHook('onRequest', async (req, reply) => {
  const { slug, domain } = resolveTenantFromHost(req.headers.host ?? '')
  const tenant = await loadTenant(slug, domain)
  if (!tenant) {
    await reply.code(404).send({ error: 'tenant not found' })
    return
  }
  req.tenant = tenant
  req.db = await acquireTenantDb(tenant)
})

// Release the reserved connection regardless of success or error.
app.addHook('onResponse', async (req) => { await req.db?.release() })
app.addHook('onError',    async (req) => { await req.db?.release() })

// --- Stubs wired to the locked architecture; flesh out per phase plan ---
// POST /share-links            -> mint guest share token (period/no-period)   [phase: guest]
// DELETE /share-links/:id      -> revoke (delete share_link tuple in OpenFGA)  [phase: guest]
// GET  /search?q=...           -> Meili (tenant token + viewer filter) + FGA   [phase: search]
// POST /attachments/presign    -> S3-compatible presigned PUT                  [phase: storage]
// GET  /entitlements           -> resolve {guestAccess,...} from plan          [phase: billing]
app.get('/', async (req) => ({ service: 'kb-server', tenant: req.tenant?.slug }))

const port = Number(process.env.SERVER_PORT ?? 4000)
app.listen({ port, host: '0.0.0.0' }).catch((e) => {
  app.log.error(e)
  process.exit(1)
})
