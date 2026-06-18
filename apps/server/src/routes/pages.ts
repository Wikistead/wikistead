import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, writeTuples, deleteObjectTuples } from '@kb/authz'
import type { TenantDb } from '../db/index.js'

interface PageRow { id: string; tenant_id: string; space_id: string; parent_id: string | null; title: string; created_at: Date; updated_at: Date }
export interface Page { id: string; tenantId: string; spaceId: string; parentId: string | null; title: string; createdAt: Date; updatedAt: Date }
function toPage(r: PageRow): Page {
  return { id: r.id, tenantId: r.tenant_id, spaceId: r.space_id, parentId: r.parent_id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }
}

// ── Service functions ─────────────────────────────────────────────────────

// Create a page inside a space.
// Write order: DB inside transaction → FGA inside same transaction callback.
// FGA failure rolls back the DB INSERT (no ghost pages).
export async function createPage(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; spaceId: string; userId: string; title?: string },
): Promise<Page> {
  // Must have edit (or higher) on the space to create a page.
  const canEdit = await check(fga, `user:${args.userId}`, 'edit', { type: 'space', id: args.spaceId })
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  const row = await db.tx(async (tx) => {
    const [r] = await tx<PageRow[]>`
      INSERT INTO pages (tenant_id, space_id, title)
      VALUES (${args.tenantId}, ${args.spaceId}, ${args.title ?? ''})
      RETURNING id, tenant_id, space_id, parent_id, title, created_at, updated_at
    `
    await writeTuples(fga, [
      { user: `space:${args.spaceId}`, relation: 'space', object: `page:${r.id}` },
    ])
    return r
  })
  return toPage(row as PageRow)
}

export async function listPages(db: TenantDb, spaceId: string): Promise<Page[]> {
  const rows = await db.sql<PageRow[]>`
    SELECT id, tenant_id, space_id, parent_id, title, created_at, updated_at
    FROM pages WHERE space_id = ${spaceId} ORDER BY created_at
  `
  return rows.map(toPage)
}

export async function getPage(db: TenantDb, fga: OpenFgaClient, args: { pageId: string; userId: string }): Promise<Page> {
  const canView = await check(fga, `user:${args.userId}`, 'view', { type: 'page', id: args.pageId })
  if (!canView) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  const [row] = await db.sql<PageRow[]>`
    SELECT id, tenant_id, space_id, parent_id, title, created_at, updated_at
    FROM pages WHERE id = ${args.pageId}
  `
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
  return toPage(row)
}

export async function updatePage(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; userId: string; title: string },
): Promise<Page> {
  const canEdit = await check(fga, `user:${args.userId}`, 'edit', { type: 'page', id: args.pageId })
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  const [row] = await db.sql<PageRow[]>`
    UPDATE pages SET title = ${args.title}, updated_at = now()
    WHERE id = ${args.pageId}
    RETURNING id, tenant_id, space_id, parent_id, title, created_at, updated_at
  `
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
  return toPage(row)
}

// Delete order: FGA first → DB second (see spaces.ts deleteSpace for rationale).
export async function deletePage(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; userId: string },
): Promise<void> {
  const canManage = await check(fga, `user:${args.userId}`, 'manage', { type: 'page', id: args.pageId })
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  await deleteObjectTuples(fga, `page:${args.pageId}`)
  await db.sql`DELETE FROM pages WHERE id = ${args.pageId}`
}

// ── Fastify plugin ────────────────────────────────────────────────────────

export async function pagesPlugin(app: FastifyInstance) {
  app.post<{ Params: { spaceId: string }; Body: { title?: string } }>(
    '/spaces/:spaceId/pages', async (req, reply) => {
      const page = await createPage(req.db, app.fga, {
        tenantId: req.tenant.id,
        spaceId: req.params.spaceId,
        userId: req.user.sub,
        title: req.body.title,
      })
      return reply.code(201).send(page)
    },
  )

  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/pages', async (req) => {
    return listPages(req.db, req.params.spaceId)
  })

  app.get<{ Params: { pageId: string } }>('/pages/:pageId', async (req) => {
    return getPage(req.db, app.fga, { pageId: req.params.pageId, userId: req.user.sub })
  })

  app.patch<{ Params: { pageId: string }; Body: { title: string } }>(
    '/pages/:pageId', async (req) => {
      return updatePage(req.db, app.fga, {
        pageId: req.params.pageId,
        userId: req.user.sub,
        title: req.body.title,
      })
    },
  )

  app.delete<{ Params: { pageId: string } }>('/pages/:pageId', async (req, reply) => {
    await deletePage(req.db, app.fga, { pageId: req.params.pageId, userId: req.user.sub })
    return reply.code(204).send()
  })
}
