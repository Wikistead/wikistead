import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, writeTuples, deleteTuples, deleteObjectTuples } from '@kb/authz'
import { resolveEntitlements } from '@kb/entitlements'
import type { TenantDb } from '../db/index.js'

interface SpaceRow { id: string; tenant_id: string; name: string; created_at: Date }
export interface Space { id: string; tenantId: string; name: string; createdAt: Date }
function toSpace(r: SpaceRow): Space {
  return { id: r.id, tenantId: r.tenant_id, name: r.name, createdAt: r.created_at }
}

// ── Service functions (exported for direct use in tests) ──────────────────

// Create a space.
//
// Write order: DB inside transaction → FGA inside same transaction callback.
// If FGA write throws, postgres.js automatically rolls back the DB transaction,
// preventing ghost spaces (DB row without FGA tuples).
// Accepting the tradeoff of holding a DB connection open during the FGA HTTP call;
// acceptable at Phase 0 scale.
export async function createSpace(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; userId: string; name: string; plan: string },
): Promise<Space> {
  const ent = resolveEntitlements(args.plan)
  if (isFinite(ent.maxSpaces)) {
    // RLS scopes this count to the current tenant automatically.
    // TODO(phase: billing): this count + insert is not atomic; two concurrent
    // requests can both read count < limit and both succeed, briefly exceeding
    // the cap. Acceptable at Phase 0 scale; fix with advisory lock or a DB
    // constraint when strict enforcement is required.
    const [{ count }] = await db.sql<[{ count: string }]>`
      SELECT count(*)::text AS count FROM spaces
    `
    if (Number(count) >= ent.maxSpaces) {
      throw Object.assign(new Error('space limit reached'), { statusCode: 403 })
    }
  }

  const row = await db.tx(async (tx) => {
    const [r] = await tx<SpaceRow[]>`
      INSERT INTO spaces (tenant_id, name)
      VALUES (${args.tenantId}, ${args.name})
      RETURNING id, tenant_id, name, created_at
    `
    // FGA inside the DB transaction: failure here rolls back the INSERT.
    await writeTuples(fga, [
      { user: `tenant:${args.tenantId}`, relation: 'tenant',  object: `space:${r.id}` },
      { user: `user:${args.userId}`,    relation: 'manager', object: `space:${r.id}` },
    ])
    return r
  })
  return toSpace(row as SpaceRow)
}

// List spaces for the current tenant (RLS filters automatically).
export async function listSpaces(db: TenantDb): Promise<Space[]> {
  const rows = await db.sql<SpaceRow[]>`
    SELECT id, tenant_id, name, created_at FROM spaces ORDER BY created_at
  `
  return rows.map(toSpace)
}

// Delete a space and all its pages.
//
// Delete order: FGA first → DB second.
//   FGA fails:  DB is untouched. Retry from the top is clean.
//   DB fails after FGA:  FGA tuples are already gone (no ghost auth).
//                        Retry the DB delete (idempotent: row may not exist).
// Page FGA tuples (including any share_link grants) are removed via
// deleteObjectTuples to prevent ghost authorization after page deletion.
export async function deleteSpace(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; spaceId: string; userId: string },
): Promise<void> {
  // FGA: user must manage this space
  const canManage = await check(fga, `user:${args.userId}`, 'manage', { type: 'space', id: args.spaceId })
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  // FGA cleanup: pages first (sweep all object tuples), then space
  const pages = await db.sql<{ id: string }[]>`
    SELECT id FROM pages WHERE space_id = ${args.spaceId}
  `
  for (const { id } of pages) {
    await deleteObjectTuples(fga, `page:${id}`)
  }
  await deleteObjectTuples(fga, `space:${args.spaceId}`)

  // DB: ON DELETE CASCADE removes pages automatically
  await db.sql`DELETE FROM spaces WHERE id = ${args.spaceId}`
}

// ── Fastify plugin ────────────────────────────────────────────────────────

export async function spacesPlugin(app: FastifyInstance) {
  app.post<{ Body: { name: string } }>('/spaces', async (req, reply) => {
    const { fga } = app
    const space = await createSpace(req.db, fga, {
      tenantId: req.tenant.id,
      userId: req.user.sub,
      name: req.body.name,
      plan: req.tenant.plan,
    })
    return reply.code(201).send(space)
  })

  app.get('/spaces', async (req) => {
    return listSpaces(req.db)
  })

  app.delete<{ Params: { spaceId: string } }>('/spaces/:spaceId', async (req, reply) => {
    const { fga } = app
    await deleteSpace(req.db, fga, {
      tenantId: req.tenant.id,
      spaceId: req.params.spaceId,
      userId: req.user.sub,
    })
    return reply.code(204).send()
  })
}
