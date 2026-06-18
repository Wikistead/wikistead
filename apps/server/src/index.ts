import Fastify from 'fastify'
import cors from '@fastify/cors'
import type { Tenant } from '@kb/types'
import { resolveTenantFromHost, loadTenant } from './tenant.js'
import { acquireTenantDb } from './db/index.js'
import type { TenantDb } from './db/index.js'
import { fgaClient } from '@kb/authz'
import { makeMemberVerifier } from '@kb/auth'
import { spacesPlugin } from './routes/spaces.js'
import { pagesPlugin } from './routes/pages.js'
import { billingPlugin } from './routes/billing.js'

declare module 'fastify' {
  interface FastifyInstance {
    fga: typeof fgaClient
  }
  interface FastifyRequest {
    // Set in onRequest for all non-health routes. Any handler that executes
    // is guaranteed to have these; the 404/401 paths short-circuit first.
    tenant: Tenant
    db: TenantDb
    user: { sub: string; groups: string[] }
  }
}

const app = Fastify({ logger: true })
await app.register(cors, { origin: true })

// Expose fgaClient as a Fastify decorator so plugins can access it as app.fga.
app.decorate('fga', fgaClient)

// Lazy OIDC verifier (same pattern as collab: constructed on first use).
const verifyMember = makeMemberVerifier({
  issuer: process.env.OIDC_ISSUER!,
  jwksUri: process.env.OIDC_JWKS_URI!,
})

// Health endpoints bypass tenant resolution and auth.
app.get('/healthz', async () => ({ ok: true }))
app.get('/readyz', async () => ({ ok: true })) // TODO: probe pg/valkey/fga/meili

app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/healthz' || req.url === '/readyz' || req.url.startsWith('/webhooks/')) return

  // ── Tenant resolution ──────────────────────────────────────────────────
  const { slug, domain } = resolveTenantFromHost(req.headers.host ?? '')
  const tenant = await loadTenant(slug, domain)
  if (!tenant) {
    await reply.code(404).send({ error: 'tenant not found' })
    return
  }
  req.tenant = tenant
  req.db = await acquireTenantDb(tenant)

  // ── Member auth ────────────────────────────────────────────────────────
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

// --- Routes ---
await app.register(spacesPlugin)
await app.register(pagesPlugin)
await app.register(billingPlugin)

// --- Legacy / stubs ---
// POST /share-links            -> mint guest share token                   [phase: guest]
// DELETE /share-links/:id      -> revoke (delete share_link tuple)         [phase: guest]
// GET  /search?q=...           -> Meili + tenant token + viewer FGA gate   [phase: search]
// POST /attachments/presign    -> S3-compatible presigned PUT               [phase: storage]
// GET  /entitlements           -> resolve {guestAccess,...} from plan       [phase: billing]
app.get('/', async (req) => ({ service: 'kb-server', tenant: req.tenant?.slug }))

const port = Number(process.env.SERVER_PORT ?? 4000)
app.listen({ port, host: '0.0.0.0' }).catch((e) => {
  app.log.error(e)
  process.exit(1)
})
