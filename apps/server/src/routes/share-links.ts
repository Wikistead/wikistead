import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, writeTuples, deleteTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { emit } from '@wikistead/events'
import type { Capability, ResourceRef } from '@wikistead/types'
import { pool } from '../db/pool.js'
import { resolveTenantFromHost, loadTenant } from '../tenant.js'
import type { TenantDb } from '../db/index.js'

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

// view -> FGA 'view' relation, edit -> 'edit'. Only these two are shareable.
function relationFor(capability: Capability): 'view' | 'edit' {
  if (capability !== 'view' && capability !== 'edit') {
    throw Object.assign(new Error('capability must be view or edit'), { statusCode: 400 })
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
    userId: string
    resource: ResourceRef
    capability: Capability
    expiresInSeconds: number | null
  },
): Promise<ShareLink> {
  if (args.resource.type !== 'page') {
    throw Object.assign(new Error('only page links are supported'), { statusCode: 400 })
  }
  const relation = relationFor(args.capability)

  const canManage = await check(fga, `user:${args.userId}`, 'manage', args.resource)
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  const expiresAt = args.expiresInSeconds != null ? new Date(Date.now() + args.expiresInSeconds * 1000) : null

  // INSERT (DB-generated v4 id) + FGA grant in one tx; FGA failure rolls back.
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
        object: `page:${args.resource.id}`,
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

export async function listShareLinks(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; userId: string },
): Promise<ShareLink[]> {
  const canManage = await check(fga, `user:${args.userId}`, 'manage', { type: 'page', id: args.pageId })
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  const rows = await db.sql<ShareLinkRow[]>`
    SELECT id, tenant_id, resource_type, resource_id, capability, expires_at, created_by, created_at, revoked_at
    FROM share_links
    WHERE resource_type = 'page' AND resource_id = ${args.pageId} AND revoked_at IS NULL
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
      { user: `share_link:${row.id}`, relation: relationFor(row.capability as Capability), object: `page:${row.resource_id}` },
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
  return { token, docName: `t:${tenantId}:p:${resource.id}`, capability, readOnly: capability === 'view' }
}

// ── Fastify plugin ─────────────────────────────────────────────────────────

export async function shareLinksPlugin(app: FastifyInstance) {
  app.post<{ Body: { resource: ResourceRef; capability: Capability; expiresInSeconds?: number | null } }>(
    '/share-links',
    async (req, reply) => {
      const link = await createShareLink(req.db, app.fga, {
        tenantId: req.tenant.id,
        userId: req.user.sub,
        resource: req.body.resource,
        capability: req.body.capability,
        expiresInSeconds: req.body.expiresInSeconds ?? null,
      })
      return reply.code(201).send(link)
    },
  )

  app.get<{ Params: { pageId: string } }>('/pages/:pageId/share-links', async (req) => {
    return listShareLinks(req.db, app.fga, { pageId: req.params.pageId, userId: req.user.sub })
  })

  app.delete<{ Params: { id: string } }>('/share-links/:id', async (req, reply) => {
    await revokeShareLink(req.db, app.fga, { id: req.params.id, userId: req.user.sub, tenantId: req.tenant.id })
    return reply.code(204).send()
  })

  // PUBLIC, unauthenticated (under /public/, skipped by the auth onRequest hook).
  // TODO(phase: guest): rate-limit this endpoint — it is the brute-force / DoS
  //   surface for guessing share link ids. Per-IP + per-id throttling.
  app.post<{ Params: { id: string } }>('/public/share-links/:id/token', async (req, reply) => {
    const { slug, domain } = resolveTenantFromHost(req.headers.host ?? '')
    const tenant = await loadTenant(slug, domain)
    // Uniform 404 for unknown tenant too — never reveal anything to an enumerator.
    if (!tenant) return reply.code(404).send({ error: 'not found' })

    const minted = await mintTokenForShareLink(app.fga, tenant.id, req.params.id)
    if (!minted) return reply.code(404).send({ error: 'not found' })
    return reply.send(minted)
  })
}
