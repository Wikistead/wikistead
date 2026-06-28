import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, writeTuples, deleteTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { resolveEntitlements } from '@wikistead/entitlements'
import { emit } from '@wikistead/events'
import type { Capability, ResourceRef } from '@wikistead/types'
import { pool } from '../db/pool.js'
import { resolveTenantFromHost, loadTenant } from '../tenant.js'
import type { TenantDb } from '../db/index.js'
import type IORedis from 'ioredis'

// Rate-limit windows for the public share-link exchange (#107 / ADR-026). Starting points —
// tune from real traffic. The per-IP bucket is the brute-force/DoS guard; the per-link bucket
// caps hammering one id. Both are fixed-window counters in the shared Valkey (cross-replica).
// Env-overridable (ADR-026: the numbers are tuned from real traffic; e2e raises them so the
// whole suite hitting the endpoint from one localhost IP doesn't trip the per-IP bucket).
const EXCHANGE_RL_WINDOW_S = 60
const EXCHANGE_RL_IP_MAX = Number(process.env.EXCHANGE_RL_IP_MAX ?? 30)
const EXCHANGE_RL_LINK_MAX = Number(process.env.EXCHANGE_RL_LINK_MAX ?? 10)

// Fixed-window counter: INCR the key, set the TTL on the first hit, return whether still within
// `max`. One round-trip + an occasional EXPIRE; idempotent under concurrency (INCR is atomic).
async function bumpRateBucket(valkey: IORedis, key: string, max: number): Promise<boolean> {
  const n = await valkey.incr(key)
  if (n === 1) await valkey.expire(key, EXCHANGE_RL_WINDOW_S)
  return n <= max
}

interface ShareLinkRow {
  id: string
  tenant_id: string
  resource_type: string
  resource_id: string
  capability: string
  expires_at: Date | null
  created_by: string
  created_at: Date
  revoked_at: Date | null
}
export interface ShareLink {
  id: string
  resource: ResourceRef
  capability: Capability
  expiresAt: string | null
  createdAt: string
}
function toShareLink(r: ShareLinkRow): ShareLink {
  return {
    id: r.id,
    resource: { type: r.resource_type as ResourceRef['type'], id: r.resource_id },
    capability: r.capability as Capability,
    expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  }
}

// The FGA relation a share link writes, by resource kind + capability:
//  - page: view -> 'view', edit -> 'edit' (both shareable).
//  - space: view-only -> 'viewer' (ADR-038: a space link opens the whole space READ-only;
//    space#editor has no share_link, so guests never edit via a space link). An edit space
//    link is rejected.
function relationForResource(type: ResourceRef['type'], capability: Capability): 'view' | 'comment' | 'edit' | 'viewer' {
  if (type === 'space') {
    if (capability !== 'view') throw Object.assign(new Error('space links are view-only'), { statusCode: 400 })
    return 'viewer'
  }
  // page: view / comment (#100) / edit are shareable; manage is not.
  if (capability !== 'view' && capability !== 'comment' && capability !== 'edit') {
    throw Object.assign(new Error('capability must be view, comment, or edit'), { statusCode: 400 })
  }
  return capability
}

const guestCfg = {
  secret: process.env.GUEST_TOKEN_SECRET!,
  ttlSeconds: Number(process.env.GUEST_TOKEN_TTL_SECONDS ?? 300),
}

// ── Service functions ──────────────────────────────────────────────────────

// Create a share link for a page. Requires `manage` on the page — issuing an
// anonymous edit link is an administrative act, so we gate on the strongest
// page capability rather than `edit`.
export async function createShareLink(
  db: TenantDb,
  fga: OpenFgaClient,
  args: {
    tenantId: string
    plan: string
    userId: string
    resource: ResourceRef
    capability: Capability
    expiresInSeconds: number | null
  },
): Promise<ShareLink> {
  if (args.resource.type !== 'page' && args.resource.type !== 'space') {
    throw Object.assign(new Error('only page or space links are supported'), { statusCode: 400 })
  }
  // Entitlement gate (issuance only): blocked plans cannot mint new links, but
  // already-issued links keep working. Free includes guest access (the hook).
  if (!resolveEntitlements(args.plan).guestAccess) {
    throw Object.assign(new Error('share links not available on this plan'), { statusCode: 402 })
  }
  // Relation by kind (space = view-only 'viewer'; page = view/edit). Throws 400 on an
  // unshareable combo (e.g. an edit space link).
  const relation = relationForResource(args.resource.type, args.capability)

  // `manage` on the resource — issuing an anonymous link is administrative. For a space link
  // this is space `manage` (exposing the WHOLE space is a bigger act than a page link).
  const canManage = await check(fga, `user:${args.userId}`, 'manage', args.resource)
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  const expiresAt = args.expiresInSeconds != null ? new Date(Date.now() + args.expiresInSeconds * 1000) : null

  // INSERT (DB-generated v4 id) + FGA grant in one tx; FGA failure rolls back. resource_type
  // is stored verbatim so revoke deletes exactly the right tuple (1 link = 1 resource).
  const row = await db.tx(async (tx) => {
    const [r] = await tx<ShareLinkRow[]>`
      INSERT INTO share_links (tenant_id, resource_type, resource_id, capability, expires_at, created_by)
      VALUES (${args.tenantId}, ${args.resource.type}, ${args.resource.id}, ${args.capability},
              ${expiresAt}, ${`user:${args.userId}`})
      RETURNING id, tenant_id, resource_type, resource_id, capability, expires_at, created_by, created_at, revoked_at
    `
    await writeTuples(fga, [
      {
        user: `share_link:${r.id}`,
        relation,
        object: `${args.resource.type}:${args.resource.id}`, // page:<id> | space:<id>
        // Time-bounded link -> non_expired condition; permanent -> no condition.
        ...(expiresAt
          ? { condition: { name: 'non_expired', context: { expires_at: expiresAt.toISOString() } } }
          : {}),
      },
    ])
    return r
  })
  return toShareLink(row as ShareLinkRow)
}

// List a resource's active share links (page or space). `manage` on the resource is required
// (only someone who can administer it may see/curate its links).
export async function listShareLinks(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { resource: ResourceRef; userId: string },
): Promise<ShareLink[]> {
  const canManage = await check(fga, `user:${args.userId}`, 'manage', args.resource)
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  const rows = await db.sql<ShareLinkRow[]>`
    SELECT id, tenant_id, resource_type, resource_id, capability, expires_at, created_by, created_at, revoked_at
    FROM share_links
    WHERE resource_type = ${args.resource.type} AND resource_id = ${args.resource.id} AND revoked_at IS NULL
    ORDER BY created_at DESC
  `
  return rows.map(toShareLink)
}

// Revoke = delete the FGA tuple (instant; the authority) + stamp revoked_at.
export async function revokeShareLink(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { id: string; userId: string; tenantId: string },
): Promise<void> {
  const [row] = await db.sql<ShareLinkRow[]>`
    SELECT id, tenant_id, resource_type, resource_id, capability, expires_at, created_by, created_at, revoked_at
    FROM share_links WHERE id = ${args.id}
  `
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })

  const resource: ResourceRef = { type: row.resource_type as ResourceRef['type'], id: row.resource_id }
  const canManage = await check(fga, `user:${args.userId}`, 'manage', resource)
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  // Idempotent: the grant may already be gone (double-revoke, or DB/FGA drift).
  // Either way the desired end state is "tuple absent + revoked_at set", so a
  // missing tuple is success, not an error.
  try {
    await deleteTuples(fga, [
      {
        user: `share_link:${row.id}`,
        relation: relationForResource(resource.type, row.capability as Capability),
        object: `${resource.type}:${row.resource_id}`, // page:<id> | space:<id>
      },
    ])
  } catch (err) {
    if (!String((err as Error)?.message ?? '').includes('did not exist')) throw err
  }
  await db.sql`UPDATE share_links SET revoked_at = now() WHERE id = ${args.id}`
  emit({ type: 'share_link.revoked', tenantId: args.tenantId, shareLinkId: row.id, pageId: row.resource_id, actorId: args.userId })
}

export interface MintedGuestToken {
  token: string
  docName: string
  capability: Capability
  readOnly: boolean
}

// Public landing: mint a short-lived guest token for a link id. No auth — the
// link id is the capability. Tenant comes from the request Host (RLS stays on;
// no bypass). Returns null for EVERY failure mode so the caller can answer 404
// uniformly and leak nothing about a link's existence/state to an enumerator.
export async function mintTokenForShareLink(
  fga: OpenFgaClient,
  tenantId: string,
  id: string,
): Promise<MintedGuestToken | null> {
  // Fast first-pass under RLS (NOT the security gate): cheaply reject obviously
  // dead links before touching FGA.
  const row = (await pool.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    const [r] = await tx<ShareLinkRow[]>`
      SELECT id, tenant_id, resource_type, resource_id, capability, expires_at, created_by, created_at, revoked_at
      FROM share_links WHERE id = ${id}
    `
    return r ?? null
  })) as ShareLinkRow | null

  if (!row) return null
  if (row.revoked_at) return null
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) return null

  const resource: ResourceRef = { type: row.resource_type as ResourceRef['type'], id: row.resource_id }
  const capability = row.capability as Capability

  // AUTHORITATIVE gate: the FGA grant must still be live (and, for time-bounded
  // links, the non_expired condition must pass at current_time). This is what
  // makes revocation correct even if the DB row and FGA tuple diverge — e.g. the
  // tuple was deleted but the revoked_at UPDATE failed: FGA says no -> no token.
  // check() maps the capability to the per-type FGA relation (space view → 'viewer'), so we
  // pass the capability. The minted token carries the resource so the collab join point
  // authorizes the right pages (a space token → any published page in the space).
  const allowed = await check(fga, `share_link:${row.id}`, capability, resource, {
    current_time: new Date().toISOString(),
  })
  if (!allowed) return null

  // Token TTL is the SHORT of the configured guest TTL and the link's remaining
  // life. Short TTL is what bounds how long an already-connected guest keeps
  // access after revocation (the project design notes: connected guests hold the JWT until exp).
  let ttl = guestCfg.ttlSeconds
  if (row.expires_at) {
    const remaining = Math.floor((row.expires_at.getTime() - Date.now()) / 1000)
    ttl = Math.max(1, Math.min(ttl, remaining))
  }

  const token = await mintGuestToken(
    { secret: guestCfg.secret, ttlSeconds: ttl },
    { tenantId, shareLinkId: row.id, resource, capability },
  )
  // A page link points at one collab doc; a space link has no single doc — the client uses
  // the space marker to show the space's pages and connects per-page (t:<tenant>:p:<pageId>).
  const docName = resource.type === 'space' ? `t:${tenantId}:s:${resource.id}` : `t:${tenantId}:p:${resource.id}`
  return { token, docName, capability, readOnly: capability === 'view' }
}

// ── Fastify plugin ─────────────────────────────────────────────────────────

export async function shareLinksPlugin(app: FastifyInstance) {
  app.post<{ Body: { resource: ResourceRef; capability: Capability; expiresInSeconds?: number | null } }>(
    '/share-links',
    async (req, reply) => {
      const link = await createShareLink(req.db, app.fga, {
        tenantId: req.tenant.id,
        plan: req.tenant.plan,
        userId: req.user.sub,
        resource: req.body.resource,
        capability: req.body.capability,
        expiresInSeconds: req.body.expiresInSeconds ?? null,
      })
      return reply.code(201).send(link)
    },
  )

  app.get<{ Params: { pageId: string } }>('/pages/:pageId/share-links', async (req) => {
    return listShareLinks(req.db, app.fga, { resource: { type: 'page', id: req.params.pageId }, userId: req.user.sub })
  })

  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/share-links', async (req) => {
    return listShareLinks(req.db, app.fga, { resource: { type: 'space', id: req.params.spaceId }, userId: req.user.sub })
  })

  app.delete<{ Params: { id: string } }>('/share-links/:id', async (req, reply) => {
    await revokeShareLink(req.db, app.fga, { id: req.params.id, userId: req.user.sub, tenantId: req.tenant.id })
    return reply.code(204).send()
  })

  // PUBLIC, unauthenticated (under /public/, skipped by the auth onRequest hook). Rate-limited
  // (#107 / ADR-026): two INDEPENDENT fixed-window buckets in Valkey — per client IP and per
  // link id — checked in a preHandler BEFORE the lookup, so a 429 is emitted for a valid OR an
  // unknown id alike (outcome-agnostic: the limiter never becomes an existence oracle; 404 stays
  // the only existence signal). Valkey is the shared store so the limit holds across replicas
  // (prod runs >1). NB: implemented directly on the existing ioredis (app.valkey) rather than
  // pulling in @fastify/rate-limit (ADR-026's suggestion) — the confirmed mechanism is two
  // ORDERED buckets, which the plugin can't express cleanly, and this adds no new dependency.
  app.post<{ Params: { id: string } }>(
    '/public/share-links/:id/token',
    {
      preHandler: async (req, reply) => {
        const ip = req.ip
        const id = req.params.id
        // Bump BOTH buckets regardless of outcome (the per-link bucket must not depend on the
        // lookup succeeding — no success/existence oracle). 429 if EITHER is over its window.
        const okIp = await bumpRateBucket(app.valkey, `rl:slx:ip:${ip}`, EXCHANGE_RL_IP_MAX)
        const okLink = await bumpRateBucket(app.valkey, `rl:slx:link:${id}`, EXCHANGE_RL_LINK_MAX)
        if (!okIp || !okLink) {
          const ttl = await app.valkey.ttl(okIp ? `rl:slx:link:${id}` : `rl:slx:ip:${ip}`)
          reply.header('Retry-After', String(Math.max(1, ttl)))
          return reply.code(429).send({ error: 'too many requests' })
        }
      },
    },
    async (req, reply) => {
      const { slug, domain } = resolveTenantFromHost(req.headers.host ?? '')
      const tenant = await loadTenant(slug, domain)
      // Uniform 404 for unknown tenant too — never reveal anything to an enumerator.
      if (!tenant) return reply.code(404).send({ error: 'not found' })

      const minted = await mintTokenForShareLink(app.fga, tenant.id, req.params.id)
      if (!minted) return reply.code(404).send({ error: 'not found' })
      return reply.send(minted)
    },
  )
}
