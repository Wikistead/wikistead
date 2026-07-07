import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, writeTuples } from '@wikistead/authz'
import type { TenantDb } from '../db/index.js'

// #241 / ADR-110: page templates — the SAVE path. A template is a SNAPSHOT of a page's published Markdown
// (frozen in the `templates` table, #247) whose audience is authorized by the `template` FGA type. Save is
// member-only (guests are rejected — a route without `config.guest` never receives a guest) and requires
// the saver to VIEW the source page. Scope decides which extra tuple is written (space / audience_all).

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode })

export type TemplateScope = 'personal' | 'space' | 'tenant'

export async function saveTemplate(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; userId: string; fromPageId: string; name: string; scope: TemplateScope; spaceId?: string | null },
): Promise<{ id: string }> {
  const subject = `user:${args.userId}`
  // The saver must be able to VIEW the source page — else 404 (existence-hidden, never 403, so a
  // non-viewer can't probe which pages exist). This also blocks cross-tenant sources (no view tuple).
  const canView = await check(fga, subject, 'view', { type: 'page', id: args.fromPageId })
  if (!canView) throw httpError(404, 'not found')
  // Snapshot the published version. RLS scopes `db` to the tenant, so a cross-tenant id returns no row
  // (defence-in-depth with the FGA check above). A page with no published version cannot be templated.
  const [src] = await db.sql<{ published_md: string | null }[]>`SELECT published_md FROM pages WHERE id = ${args.fromPageId}`
  if (!src) throw httpError(404, 'not found')
  if (src.published_md == null) throw httpError(400, 'page has no published version')
  const name = (args.name ?? '').trim()
  if (!name) throw httpError(400, 'name is required')
  // A space-scope template's audience is that space's viewers — the saver must be able to view the space
  // (else 404), so a template can't be aimed at a space the saver can't see.
  if (args.scope === 'space') {
    if (!args.spaceId) throw httpError(400, 'spaceId is required for a space-scope template')
    const canViewSpace = await check(fga, subject, 'view', { type: 'space', id: args.spaceId })
    if (!canViewSpace) throw httpError(404, 'not found')
  }
  const id = await db.tx(async (tx) => {
    const [row] = await tx<[{ id: string }]>`
      INSERT INTO templates (tenant_id, name, body_md, source_page_id, scope, space_id, created_by)
      VALUES (${args.tenantId}, ${name}, ${src.published_md}, ${args.fromPageId}, ${args.scope},
              ${args.scope === 'space' ? args.spaceId! : null}, ${args.userId})
      RETURNING id`
    const obj = `template:${row.id}`
    // owner + tenant always; the scope tuple decides the audience (see the model.fga template type).
    const tuples = [
      { user: `tenant:${args.tenantId}`, relation: 'tenant', object: obj },
      { user: subject, relation: 'owner', object: obj },
    ]
    if (args.scope === 'space') tuples.push({ user: `space:${args.spaceId}`, relation: 'space', object: obj })
    if (args.scope === 'tenant') tuples.push({ user: `tenant:${args.tenantId}`, relation: 'audience_all', object: obj })
    // FGA LAST inside the tx: a tuple-write failure throws → the row rolls back (no orphan row). Mirrors
    // grantPageAccess. (A DB rollback after a partial FGA write can orphan tuples — accepted, same as the
    // existing grant path; the row is the source of truth for cleanup.)
    await writeTuples(fga, tuples)
    return row.id
  })
  return { id }
}

export async function templatesPlugin(app: FastifyInstance) {
  // Save a template from a page. Member-only (no `config.guest` → a guest token never reaches here); the
  // explicit guard makes the "guests cannot save" boundary legible and defends against a misconfig.
  app.post<{ Body: { fromPageId?: string; name?: string; scope?: TemplateScope; spaceId?: string | null } }>(
    '/templates', async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'unauthorized' })
      const { fromPageId, name, scope, spaceId } = req.body ?? {}
      if (!fromPageId || (scope !== 'personal' && scope !== 'space' && scope !== 'tenant')) {
        return reply.code(400).send({ error: 'fromPageId and a valid scope are required' })
      }
      const t = await saveTemplate(req.db, app.fga, {
        tenantId: req.tenant.id,
        userId: req.user.sub,
        fromPageId,
        name: name ?? '',
        scope,
        spaceId: spaceId ?? null,
      })
      return reply.code(201).send(t)
    },
  )
}
