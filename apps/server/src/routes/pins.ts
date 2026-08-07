import type { FastifyInstance } from 'fastify'
import type { Sql } from 'postgres'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, filterAuthorized } from '@wikistead/authz'
import type { TenantDb } from '../db/index.js'

// #284 / ADR-119: per-member pins (spaces + pages). A pin is "my view", never shared
// state: RLS scopes rows to the tenant, and MEMBER isolation is the app-level
// `member_sub = <caller>` predicate on every query (the api_keys.owner_user_id
// pattern) — RLS alone would let tenant members touch each other's pins.
//
// authz (the ADR-119 rules):
//   Write  — view-gated: pinning needs FGA `view` on the resource; non-viewable and
//            non-existent both return the SAME uniform 404 (no existence oracle).
//   Display — a stored pin is untrusted; the gate is a DOUBLE condition, both
//            required: (1) the resource row still exists under the tenant RLS
//            (JOIN member_pins → spaces/pages; missing = deleted or cross-tenant
//            → drop) AND (2) FGA `view` = true for the caller. A pin failing either
//            is silently dropped — a title-less pin is never rendered, so a stale
//            pin can't leak a title or a "this used to exist" signal.
//   Guests — no `config: { guest }` opt-in on any pin route, so a share-link token
//            is rejected before the handler runs (member-only, structurally).

export type PinResourceType = 'space' | 'page'

export interface Pin {
  id: string
  resourceType: PinResourceType
  resourceId: string
  title: string
  position: number
  // #284for a PAGE pin, which space it lives in (so the sidebar can show a space icon + name —
  // a deep page's pin is ambiguous without it). Absent for space pins. No new authz surface: the page is
  // already view-confirmed and its owning space is structurally viewable (view_base_from_space), so
  // surfacing that space's name/icon leaks nothing.
  space?: { id: string; name: string; iconImageUrl: string | null }
}

interface PinRow {
  id: string
  resource_type: string
  resource_id: string
  position: number
  // Joined live-resource columns — NULL when the resource row is gone (display gate 1).
  space_name: string | null
  page_title: string | null
  // #284a PAGE pin's owning space (joined via pages.space_id). NULL for space pins / missing pages.
  page_space_id: string | null
  page_space_name: string | null
  page_space_icon_key: string | null
}

// The view-confirmed pin list. Order: per type by position (the member's own order).
export async function listPins(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { memberSub: string },
): Promise<Pin[]> {
  const rows = await db.sql<PinRow[]>`
    SELECT mp.id, mp.resource_type, mp.resource_id, mp.position,
           s.name  AS space_name,
           p.title AS page_title,
           s2.id              AS page_space_id,
           s2.name            AS page_space_name,
           ss2.icon_image_key AS page_space_icon_key
    FROM member_pins mp
    LEFT JOIN spaces s ON mp.resource_type = 'space' AND s.id = mp.resource_id
    LEFT JOIN pages  p ON mp.resource_type = 'page'  AND p.id = mp.resource_id
    LEFT JOIN spaces s2 ON mp.resource_type = 'page' AND s2.id = p.space_id
    LEFT JOIN space_settings ss2 ON ss2.space_id = s2.id
    WHERE mp.member_sub = ${args.memberSub}
    ORDER BY mp.resource_type, mp.position, mp.created_at
  `
  // Display gate 1: the resource row must still exist under the tenant RLS.
  const live = rows.filter((r) => (r.resource_type === 'space' ? r.space_name !== null : r.page_title !== null))

  // Display gate 2: FGA view. Pages batch through filterAuthorized (it hardcodes
  // {type:'page'}); spaces use the per-id check (the getBacklinks shape).
  const subject = `user:${args.memberSub}`
  const pageIds = live.filter((r) => r.resource_type === 'page').map((r) => r.resource_id)
  const viewablePages = await filterAuthorized(fga, subject, 'view', pageIds)

  const out: Pin[] = []
  for (const r of live) {
    if (r.resource_type === 'page') {
      if (!viewablePages.has(r.resource_id)) continue
      // #284attach the owning space (name + icon) for the sidebar. iconImageUrl mirrors the spaces
      // list shape (`/spaces/<id>/icon-image` when a key is set) so the pin's icon renders identically.
      const space = r.page_space_id
        ? { id: r.page_space_id, name: r.page_space_name ?? '', iconImageUrl: r.page_space_icon_key ? `/spaces/${r.page_space_id}/icon-image` : null }
        : undefined
      out.push({ id: r.id, resourceType: 'page', resourceId: r.resource_id, title: r.page_title ?? '', position: r.position, space })
    } else {
      const ok = await check(fga, subject, 'view', { type: 'space', id: r.resource_id })
      if (!ok) continue
      out.push({ id: r.id, resourceType: 'space', resourceId: r.resource_id, title: r.space_name ?? '', position: r.position })
    }
  }
  return out
}

// View-gated create. Existence (under RLS) and FGA view BOTH required — failing
// either returns the same uniform 404 so the write is not an existence oracle.
// Idempotent: re-pinning an already-pinned resource returns the existing pin.
/**
 * #623: how many pins one member may hold, per resource type.
 *
 * Generous on purpose — this is a bound on the list, not a product restriction. Nobody curating a
 * sidebar reaches it; a script or a runaway client does.
 */
export const MAX_PINS_PER_TYPE = 200

export async function createPin(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; memberSub: string; resourceType: PinResourceType; resourceId: string },
): Promise<Pin> {
  if (args.resourceType !== 'space' && args.resourceType !== 'page') {
    throw Object.assign(new Error('invalid resource type'), { statusCode: 400 })
  }
  const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 })

  // Existence under the tenant RLS (a cross-tenant id yields no row → the same 404).
  const [resource] =
    args.resourceType === 'space'
      ? await db.sql<{ title: string }[]>`SELECT name AS title FROM spaces WHERE id = ${args.resourceId}`
      : await db.sql<{ title: string }[]>`SELECT title FROM pages WHERE id = ${args.resourceId}`
  if (!resource) throw notFound()

  const canView = await check(fga, `user:${args.memberSub}`, 'view', { type: args.resourceType, id: args.resourceId })
  if (!canView) throw notFound()

  // #623: pins are a list the member curates, and nothing prunes them. The bound is a CAP rather than a
  // page, for the reason the ledger already states for authenticators: reorder persists the whole
  // ordered id list, and the sidebar shows the set — paging would let somebody hold more pins than they
  // can see or reorder.
  //
  // Counted per (member, resource type) because that is the unit the sidebar draws and `position`
  // sequences. Re-pinning something ALREADY pinned stays allowed at the cap: it is idempotent, adds no
  // row, and refusing it would make the control at the cap answer an error for a no-op.
  const [{ n: pinned }] = await db.sql<[{ n: number }]>`
    SELECT count(*)::int AS n FROM member_pins
     WHERE tenant_id = ${args.tenantId} AND member_sub = ${args.memberSub} AND resource_type = ${args.resourceType}`
  if (pinned >= MAX_PINS_PER_TYPE) {
    const [already] = await db.sql<[{ id: string }?]>`
      SELECT id FROM member_pins
       WHERE tenant_id = ${args.tenantId} AND member_sub = ${args.memberSub}
         AND resource_type = ${args.resourceType} AND resource_id = ${args.resourceId}`
    if (!already) {
      throw Object.assign(new Error('too many pins'), { statusCode: 409, code: 'pin_limit' })
    }
  }

  const [row] = await db.sql<{ id: string; position: number }[]>`
    INSERT INTO member_pins (tenant_id, member_sub, resource_type, resource_id, position)
    VALUES (
      ${args.tenantId}, ${args.memberSub}, ${args.resourceType}, ${args.resourceId},
      (SELECT COALESCE(MAX(position) + 1, 0) FROM member_pins
       WHERE tenant_id = ${args.tenantId} AND member_sub = ${args.memberSub} AND resource_type = ${args.resourceType})
    )
    ON CONFLICT (tenant_id, member_sub, resource_type, resource_id) DO NOTHING
    RETURNING id, position
  `
  if (row) return { id: row.id, resourceType: args.resourceType, resourceId: args.resourceId, title: resource.title, position: row.position }
  // Conflict = already pinned; return the existing row (idempotent).
  const [existing] = await db.sql<{ id: string; position: number }[]>`
    SELECT id, position FROM member_pins
    WHERE tenant_id = ${args.tenantId} AND member_sub = ${args.memberSub}
      AND resource_type = ${args.resourceType} AND resource_id = ${args.resourceId}
  `
  return { id: existing.id, resourceType: args.resourceType, resourceId: args.resourceId, title: resource.title, position: existing.position }
}

// Unpin. The member_sub predicate is the member-isolation boundary: another
// member's pin id yields count 0 → the same 404 as a nonexistent id.
export async function deletePin(db: TenantDb, args: { id: string; memberSub: string }): Promise<boolean> {
  const result = await db.sql`
    DELETE FROM member_pins WHERE id = ${args.id} AND member_sub = ${args.memberSub}
  `
  return result.count > 0
}

// Persist a new order for the member's pins of one type (v1: up/down buttons on the
// client, but the API takes the full ordered id list). Ids not owned by the caller
// (or of the other type) simply match no row — the member_sub predicate again.
export async function reorderPins(
  db: TenantDb,
  args: { memberSub: string; resourceType: PinResourceType; orderedIds: string[] },
): Promise<void> {
  if (args.resourceType !== 'space' && args.resourceType !== 'page') {
    throw Object.assign(new Error('invalid resource type'), { statusCode: 400 })
  }
  if (!Array.isArray(args.orderedIds) || args.orderedIds.some((id) => typeof id !== 'string')) {
    throw Object.assign(new Error('orderedIds must be a string array'), { statusCode: 400 })
  }
  await db.tx(async (tx) => {
    for (let i = 0; i < args.orderedIds.length; i++) {
      await tx`
        UPDATE member_pins SET position = ${i}
        WHERE id = ${args.orderedIds[i]} AND member_sub = ${args.memberSub} AND resource_type = ${args.resourceType}
      `
    }
  })
}

// Best-effort cleanup for resource deletion paths (deletePage/deleteSpace call this
// inside their tx). Correctness does NOT depend on it — the display gate drops
// orphans regardless — this is hygiene so rows don't accumulate.
export async function deletePinsForResources(sql: Sql, resourceIds: string[]): Promise<void> {
  if (resourceIds.length === 0) return
  await sql`DELETE FROM member_pins WHERE resource_id = ANY(${resourceIds})`
}

// ── Fastify plugin ────────────────────────────────────────────────────────
// Member-only: no route opts into `config: { guest }`, so guest tokens are 401'd
// by the auth hook before any handler runs.

export async function pinsPlugin(app: FastifyInstance) {
  app.get('/pins', async (req) => listPins(req.db, app.fga, { memberSub: req.user.sub }))

  app.post<{ Body: { resourceType: PinResourceType; resourceId: string } }>('/pins', async (req, reply) => {
    const pin = await createPin(req.db, app.fga, {
      tenantId: req.tenant.id,
      memberSub: req.user.sub,
      resourceType: req.body?.resourceType,
      resourceId: String(req.body?.resourceId ?? ''),
    })
    return reply.code(201).send(pin)
  })

  app.delete<{ Params: { id: string } }>('/pins/:id', async (req, reply) => {
    const removed = await deletePin(req.db, { id: req.params.id, memberSub: req.user.sub })
    if (!removed) return reply.code(404).send({ error: 'not found' })
    return reply.code(204).send()
  })

  app.patch<{ Body: { resourceType: PinResourceType; orderedIds: string[] } }>('/pins/reorder', async (req, reply) => {
    await reorderPins(req.db, {
      memberSub: req.user.sub,
      resourceType: req.body?.resourceType,
      orderedIds: req.body?.orderedIds ?? [],
    })
    return reply.code(204).send()
  })
}
