import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, writeTuples, deleteObjectTuples } from '@wikistead/authz'
import { resolveEntitlements } from '@wikistead/entitlements'
import type { TenantDb } from '../db/index.js'
import { renderPlantuml } from '../plantuml-render.js' // #267template preview plantuml render (faithful mirror of the page endpoint)

// #241 / ADR-110: page templates — the SAVE path. A template is a SNAPSHOT of a page's published Markdown
// (frozen in the `templates` table, #247) whose audience is authorized by the `template` FGA type. Save is
// member-only (guests are rejected — a route without `config.guest` never receives a guest) and requires
// the saver to VIEW the source page. Scope decides which extra tuple is written (space / audience_all).

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode })

export type TemplateScope = 'personal' | 'space' | 'tenant'

export async function saveTemplate(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; userId: string; fromPageId: string; name: string; scope: TemplateScope; spaceId?: string | null; plan?: string },
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
    // #252 / ADR-110: maxTemplates entitlement seam. All plans are UNLIMITED for now, so `isFinite` is
    // false and this is INERT (no count, no `if (plan === ...)` branching — the entitlement is the only
    // place a cap would ever be decided). Enforced in-tx (like maxSpaces) so a future finite cap is
    // race-free. entitlement(ce) is the bastion; the UI is advisory.
    if (args.plan !== undefined) {
      const ent = resolveEntitlements(args.plan)
      if (isFinite(ent.maxTemplates)) {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`template:${args.tenantId}`}))`
        const [{ count }] = await tx<[{ count: string }]>`SELECT count(*)::text AS count FROM templates`
        if (Number(count) >= ent.maxTemplates) throw httpError(403, 'template limit reached')
      }
    }
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

// #249: template MANAGEMENT (list / preview / rename / delete). `view` and `manage` (owner or tenant
// admin) are the template FGA relations (#247). Existence-hiding: a non-viewer gets 404 (never 403, so they
// can't probe which templates exist); a viewer who is not a manager gets 403 on rename/delete.
const canView = (fga: OpenFgaClient, userId: string, id: string) =>
  fga.check({ user: `user:${userId}`, relation: 'view', object: `template:${id}` }).then((r) => r.allowed ?? false)
const canManage = (fga: OpenFgaClient, userId: string, id: string) =>
  fga.check({ user: `user:${userId}`, relation: 'manage', object: `template:${id}` }).then((r) => r.allowed ?? false)

export interface TemplateSummary { id: string; name: string; scope: TemplateScope; spaceId: string | null; createdBy: string; createdAt: string; canManage: boolean }

// The tenant's templates the user may VIEW (server FGA-filtered — scope containment is enforced here, not
// by reading the columns). RLS scopes `db` to the tenant, so cross-tenant rows never appear. `canManage`
// lets the UI hide rename/delete on templates the user can't manage (the server still re-checks — #249).
export async function listTemplates(db: TenantDb, fga: OpenFgaClient, args: { userId: string }): Promise<TemplateSummary[]> {
  const rows = await db.sql<{ id: string; name: string; scope: TemplateScope; space_id: string | null; created_by: string; created_at: Date }[]>`
    SELECT id, name, scope, space_id, created_by, created_at FROM templates ORDER BY created_at DESC`
  const out: TemplateSummary[] = []
  for (const r of rows) {
    if (await canView(fga, args.userId, r.id)) {
      out.push({ id: r.id, name: r.name, scope: r.scope, spaceId: r.space_id, createdBy: r.created_by, createdAt: r.created_at.toISOString(), canManage: await canManage(fga, args.userId, r.id) })
    }
  }
  return out
}

// The frozen body for a preview. null → 404 (not viewable / missing — existence-hidden).
export async function getTemplate(db: TenantDb, fga: OpenFgaClient, args: { userId: string; id: string }): Promise<{ id: string; name: string; scope: TemplateScope; body: string } | null> {
  if (!(await canView(fga, args.userId, args.id))) return null
  const [r] = await db.sql<{ id: string; name: string; scope: TemplateScope; body_md: string }[]>`SELECT id, name, scope, body_md FROM templates WHERE id = ${args.id}`
  return r ? { id: r.id, name: r.name, scope: r.scope, body: r.body_md } : null
}

export async function renameTemplate(db: TenantDb, fga: OpenFgaClient, args: { userId: string; id: string; name: string }): Promise<void> {
  if (!(await canView(fga, args.userId, args.id))) throw httpError(404, 'not found') // existence-hidden
  if (!(await canManage(fga, args.userId, args.id))) throw httpError(403, 'forbidden') // viewable, not a manager
  const name = (args.name ?? '').trim()
  if (!name) throw httpError(400, 'name is required')
  const res = await db.sql`UPDATE templates SET name = ${name}, updated_at = now() WHERE id = ${args.id}`
  if (res.count === 0) throw httpError(404, 'not found')
}

export async function deleteTemplate(db: TenantDb, fga: OpenFgaClient, args: { userId: string; id: string }): Promise<void> {
  if (!(await canView(fga, args.userId, args.id))) throw httpError(404, 'not found')
  if (!(await canManage(fga, args.userId, args.id))) throw httpError(403, 'forbidden')
  // Delete the row AND all its FGA tuples — no orphan tuple survives (so the id 404s afterwards and can't be
  // re-resolved). Row first inside the tx; the FGA delete last (a failure rolls the row back).
  await db.tx(async (tx) => {
    const res = await tx`DELETE FROM templates WHERE id = ${args.id}`
    if (res.count === 0) throw httpError(404, 'not found')
    await deleteObjectTuples(fga, `template:${args.id}`)
  })
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
        plan: req.tenant.plan, // #252: entitlement seam (inert while maxTemplates is Infinity)
      })
      return reply.code(201).send(t)
    },
  )

  // #249: management — all member-only (no config.guest → a guest token 401s). Server re-checks authz on
  // every op (the UI hiding non-manage actions is only the first layer).
  app.get('/templates', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' })
    return listTemplates(req.db, app.fga, { userId: req.user.sub })
  })

  app.get<{ Params: { id: string } }>('/templates/:id', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' })
    const t = await getTemplate(req.db, app.fga, { userId: req.user.sub, id: req.params.id })
    if (!t) return reply.code(404).send({ error: 'not found' })
    return t
  })

  // #267PlantUML render for the TEMPLATE preview — a faithful mirror of the page endpoint
  // (`POST /pages/:pageId/plantuml/render`, #140/ADR-074), but view-gated on the TEMPLATE instead of the
  // page. Member-only (no `config.guest` → a guest token 401s); a non-viewer gets 404 (existence-hidden,
  // never 403, uniform with getTemplate). The source is the plantuml body the viewer is ALREADY authorized
  // to see (its own template preview) — it is handed to the SAME `renderPlantuml` (operator Kroki/PlantUML,
  // existing SSRF/allowlist guard), so this adds NO new existence exposure and NO new external-fetch surface.
  // 200 image/png on success; 204 = degrade-to-source (unconfigured / endpoint failure), same as the page.
  app.post<{ Params: { id: string }; Body: { source?: string; theme?: string } }>('/templates/:id/plantuml/render', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' })
    if (!(await canView(app.fga, req.user.sub, req.params.id))) return reply.code(404).send({ error: 'not found' }) // existence-hidden
    const source = req.body?.source
    if (typeof source !== 'string' || !source.trim()) return reply.code(400).send({ error: 'source is required' })
    const png = await renderPlantuml(source, { dark: req.body?.theme === 'dark' }) // #342: dark → built-in !theme
    if (!png) return reply.code(204).send() // degrade: caller renders the source fence
    return reply.header('content-type', 'image/png').send(png)
  })

  app.patch<{ Params: { id: string }; Body: { name?: string } }>('/templates/:id', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' })
    await renameTemplate(req.db, app.fga, { userId: req.user.sub, id: req.params.id, name: req.body?.name ?? '' })
    return reply.code(204).send()
  })

  app.delete<{ Params: { id: string } }>('/templates/:id', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' })
    await deleteTemplate(req.db, app.fga, { userId: req.user.sub, id: req.params.id })
    return reply.code(204).send()
  })
}
