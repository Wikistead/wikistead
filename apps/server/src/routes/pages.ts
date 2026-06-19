import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, filterAuthorized, writeTuples, deleteObjectTuples } from '@wikistead/authz'
import { emit } from '@wikistead/events'
import { enqueueOutbox, processOutboxAsync } from '../search/index.js'
import type { SearchDriver } from '../search/index.js'
import type { TenantDb } from '../db/index.js'

interface PageRow { id: string; tenant_id: string; space_id: string; parent_id: string | null; title: string; position: number; created_at: Date; updated_at: Date }
export interface Page { id: string; tenantId: string; spaceId: string; parentId: string | null; title: string; position: number; createdAt: Date; updatedAt: Date }
function toPage(r: PageRow): Page {
  return { id: r.id, tenantId: r.tenant_id, spaceId: r.space_id, parentId: r.parent_id, title: r.title, position: r.position, createdAt: r.created_at, updatedAt: r.updated_at }
}

// Fractional sibling ordering: a new value between two neighbours, no renumber.
// front = min-1, end = max+1, between = midpoint, empty = 0.
//
// v1 uses a float midpoint (chosen over a LexoRank-style string rank to avoid the
// string min-boundary edge; both satisfy the no-renumber / single-row-UPDATE
// concurrency property). KNOWN LIMITATION: ~53 consecutive inserts into the SAME
// gap make two positions compare equal (float precision exhaustion) and the order
// becomes ambiguous.
// TODO(phase: tree-rebalance): detect a collapsed/duplicate gap and re-spread the
//   affected siblings' positions (or switch to a LexoRank string key). Until then
//   listPages tie-breaks equal positions by created_at so order stays stable.
function positionBetween(before: number | null, after: number | null): number {
  if (before == null && after == null) return 0
  if (before == null) return (after as number) - 1
  if (after == null) return before + 1
  return (before + after) / 2
}

// ── Service functions ─────────────────────────────────────────────────────

// Create a page. Outbox entry is written in the same DB transaction as the
// INSERT + FGA write. Meili indexing fires asynchronously after tx commits
// (non-blocking: API success is independent of Meili availability).
export async function createPage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { tenantId: string; spaceId: string; userId: string; title?: string; parentId?: string | null },
): Promise<Page> {
  const canEdit = await check(fga, `user:${args.userId}`, 'edit', { type: 'space', id: args.spaceId })
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  const parentId = args.parentId ?? null
  if (parentId) {
    // Nesting is structural only and stays within one space; the parent must be
    // a page in the SAME space (the composite FK already blocks cross-tenant).
    const [p] = await db.sql<{ space_id: string }[]>`SELECT space_id FROM pages WHERE id = ${parentId}`
    if (!p || p.space_id !== args.spaceId) throw Object.assign(new Error('parent not in space'), { statusCode: 400 })
  }
  // Append to the end of its sibling list (max position + 1).
  const [{ pos }] = await db.sql<[{ pos: number | null }]>`
    SELECT MAX(position) AS pos FROM pages
    WHERE space_id = ${args.spaceId} AND parent_id IS NOT DISTINCT FROM ${parentId}
  `
  const position = positionBetween(pos, null)

  let outboxId!: string
  const row = await db.tx(async (tx) => {
    const [r] = await tx<PageRow[]>`
      INSERT INTO pages (tenant_id, space_id, parent_id, title, position)
      VALUES (${args.tenantId}, ${args.spaceId}, ${parentId}, ${args.title ?? ''}, ${position})
      RETURNING id, tenant_id, space_id, parent_id, title, position, created_at, updated_at
    `
    await writeTuples(fga, [
      { user: `space:${args.spaceId}`, relation: 'space', object: `page:${r.id}` },
    ])
    outboxId = await enqueueOutbox(tx, { tenantId: args.tenantId, pageId: r.id, operation: 'upsert' })
    return r
  })
  const page = toPage(row as PageRow)
  processOutboxAsync(driver, outboxId, { tenantId: args.tenantId, pageId: page.id, operation: 'upsert' })
  emit({ type: 'page.created', tenantId: args.tenantId, pageId: page.id, spaceId: args.spaceId, actorId: args.userId })
  return page
}

// List the pages in a space the user is allowed to VIEW. RLS gives only tenant
// isolation; per-page view authorization is enforced here so the page tree never
// lists (or leaks the title of) a page the user cannot open — the same
// "confirm via OpenFGA before display" rule the search two-stage guard follows
// (the project design notes). A page the user lacks `view` on is excluded.
export async function listPages(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { spaceId: string; userId: string },
): Promise<Page[]> {
  const rows = await db.sql<PageRow[]>`
    SELECT id, tenant_id, space_id, parent_id, title, position, created_at, updated_at
    FROM pages WHERE space_id = ${args.spaceId} ORDER BY position, created_at
  `
  const allowed = await filterAuthorized(fga, `user:${args.userId}`, 'view', rows.map((r) => r.id))
  return rows.filter((r) => allowed.has(r.id)).map(toPage)
}

export async function getPage(db: TenantDb, fga: OpenFgaClient, args: { pageId: string; userId: string }): Promise<Page> {
  const canView = await check(fga, `user:${args.userId}`, 'view', { type: 'page', id: args.pageId })
  if (!canView) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  const [row] = await db.sql<PageRow[]>`
    SELECT id, tenant_id, space_id, parent_id, title, position, created_at, updated_at
    FROM pages WHERE id = ${args.pageId}
  `
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
  return toPage(row)
}

// Update title. Outbox entry written in the same tx as the UPDATE.
export async function updatePage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; userId: string; title: string },
): Promise<Page> {
  const canEdit = await check(fga, `user:${args.userId}`, 'edit', { type: 'page', id: args.pageId })
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  let outboxId!: string
  const row = await db.tx(async (tx) => {
    const [r] = await tx<PageRow[]>`
      UPDATE pages SET title = ${args.title}, updated_at = now()
      WHERE id = ${args.pageId}
      RETURNING id, tenant_id, space_id, parent_id, title, position, created_at, updated_at
    `
    if (!r) throw Object.assign(new Error('not found'), { statusCode: 404 })
    outboxId = await enqueueOutbox(tx, { tenantId: r.tenant_id, pageId: args.pageId, operation: 'upsert' })
    return r
  })
  const page = toPage(row as PageRow)
  processOutboxAsync(driver, outboxId, { tenantId: page.tenantId, pageId: page.id, operation: 'upsert' })
  emit({ type: 'page.updated', tenantId: page.tenantId, pageId: page.id, actorId: args.userId })
  return page
}

// All descendant page ids of root (RLS-scoped to the tenant), via the parent_id tree.
async function descendantIds(db: TenantDb, rootId: string): Promise<string[]> {
  const rows = await db.sql<{ id: string }[]>`
    WITH RECURSIVE d AS (
      SELECT id FROM pages WHERE parent_id = ${rootId}
      UNION ALL
      SELECT p.id FROM pages p JOIN d ON p.parent_id = d.id
    )
    SELECT id FROM d
  `
  return rows.map((r) => r.id)
}

// Move/reorder a page WITHIN its space: change parent_id and/or position.
// Intra-space only (cross-space move is a later step). Permissions derive from
// the space and don't change here, so this needs `edit` on the page. The move is
// a single-row UPDATE of a fractional position between the new neighbours (no
// sibling renumber → concurrent moves of different pages don't conflict).
export async function movePage(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; userId: string; parentId: string | null; afterId: string | null },
): Promise<Page> {
  const canEdit = await check(fga, `user:${args.userId}`, 'edit', { type: 'page', id: args.pageId })
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  const [page] = await db.sql<PageRow[]>`
    SELECT id, tenant_id, space_id, parent_id, title, position, created_at, updated_at
    FROM pages WHERE id = ${args.pageId}
  `
  if (!page) throw Object.assign(new Error('not found'), { statusCode: 404 })

  const newParent = args.parentId ?? null
  if (newParent) {
    const [p] = await db.sql<{ space_id: string }[]>`SELECT space_id FROM pages WHERE id = ${newParent}`
    if (!p || p.space_id !== page.space_id) throw Object.assign(new Error('parent not in space'), { statusCode: 400 })
    // No cycles: a page cannot be nested under itself or its own descendant.
    if (newParent === args.pageId) throw Object.assign(new Error('cannot nest under itself'), { statusCode: 400 })
    if ((await descendantIds(db, args.pageId)).includes(newParent)) {
      throw Object.assign(new Error('cannot nest under own descendant'), { statusCode: 400 })
    }
  }

  // Position between afterId and the next sibling (afterId null = first child).
  const sibs = await db.sql<{ id: string; position: number }[]>`
    SELECT id, position FROM pages
    WHERE space_id = ${page.space_id} AND parent_id IS NOT DISTINCT FROM ${newParent} AND id <> ${args.pageId}
    ORDER BY position, created_at
  `
  let before: number | null = null
  let after: number | null = null
  if (args.afterId == null) {
    after = sibs[0]?.position ?? null
  } else {
    const idx = sibs.findIndex((s) => s.id === args.afterId)
    if (idx === -1) throw Object.assign(new Error('afterId is not a sibling'), { statusCode: 400 })
    before = sibs[idx].position
    after = sibs[idx + 1]?.position ?? null
  }
  const position = positionBetween(before, after)

  const [r] = await db.sql<PageRow[]>`
    UPDATE pages SET parent_id = ${newParent}, position = ${position}, updated_at = now()
    WHERE id = ${args.pageId}
    RETURNING id, tenant_id, space_id, parent_id, title, position, created_at, updated_at
  `
  emit({ type: 'page.updated', tenantId: page.tenant_id, pageId: page.id, actorId: args.userId })
  return toPage(r)
}

// Delete order: FGA first → outbox + DB in same tx.
// Outbox 'delete' entry ensures Meili doc is removed even if Meili is temporarily down.
export async function deletePage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; userId: string },
): Promise<void> {
  const canManage = await check(fga, `user:${args.userId}`, 'manage', { type: 'page', id: args.pageId })
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  const [meta] = await db.sql<[{ tenant_id: string }]>`SELECT tenant_id FROM pages WHERE id = ${args.pageId}`
  const tenantId = meta?.tenant_id ?? ''

  // ON DELETE CASCADE removes the subtree in the DB, but FGA grants + search docs
  // for descendants must be cleaned too (else ghost auth / stale search). Sweep
  // the page AND all descendants. FGA-first (ADR-003): if a tuple sweep fails the
  // DB row is untouched and the op is retryable.
  const ids = [args.pageId, ...(await descendantIds(db, args.pageId))]
  for (const id of ids) await deleteObjectTuples(fga, `page:${id}`)

  const outboxIds: { id: string; pageId: string }[] = []
  await db.tx(async (tx) => {
    for (const id of ids) {
      outboxIds.push({ id: await enqueueOutbox(tx, { tenantId, pageId: id, operation: 'delete' }), pageId: id })
    }
    await tx`DELETE FROM pages WHERE id = ${args.pageId}` // cascade deletes descendants
  })
  for (const o of outboxIds) processOutboxAsync(driver, o.id, { tenantId, pageId: o.pageId, operation: 'delete' })
  emit({ type: 'page.deleted', tenantId, pageId: args.pageId, actorId: args.userId })
}

// ── Fastify plugin ────────────────────────────────────────────────────────

export async function pagesPlugin(app: FastifyInstance) {
  app.post<{ Params: { spaceId: string }; Body: { title?: string; parentId?: string | null } }>(
    '/spaces/:spaceId/pages', async (req, reply) => {
      const page = await createPage(req.db, app.fga, app.searchDriver, {
        tenantId: req.tenant.id,
        spaceId: req.params.spaceId,
        userId: req.user.sub,
        title: req.body.title,
        parentId: req.body.parentId ?? null,
      })
      return reply.code(201).send(page)
    },
  )

  // Move/reorder within the space (intra-space). parentId null = top level;
  // afterId null = first child of the target parent.
  app.patch<{ Params: { pageId: string }; Body: { parentId?: string | null; afterId?: string | null } }>(
    '/pages/:pageId/move', async (req) => {
      return movePage(req.db, app.fga, {
        pageId: req.params.pageId,
        userId: req.user.sub,
        parentId: req.body.parentId ?? null,
        afterId: req.body.afterId ?? null,
      })
    },
  )

  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/pages', async (req) => {
    return listPages(req.db, app.fga, { spaceId: req.params.spaceId, userId: req.user.sub })
  })

  app.get<{ Params: { pageId: string } }>('/pages/:pageId', async (req) => {
    return getPage(req.db, app.fga, { pageId: req.params.pageId, userId: req.user.sub })
  })

  app.patch<{ Params: { pageId: string }; Body: { title: string } }>(
    '/pages/:pageId', async (req) => {
      return updatePage(req.db, app.fga, app.searchDriver, {
        pageId: req.params.pageId,
        userId: req.user.sub,
        title: req.body.title,
      })
    },
  )

  app.delete<{ Params: { pageId: string } }>('/pages/:pageId', async (req, reply) => {
    await deletePage(req.db, app.fga, app.searchDriver, { pageId: req.params.pageId, userId: req.user.sub })
    return reply.code(204).send()
  })
}
