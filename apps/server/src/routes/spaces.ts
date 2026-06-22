import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, writeTuples, deleteTuples, deleteObjectTuples } from '@wikistead/authz'
import { resolveEntitlements } from '@wikistead/entitlements'
import { isAccentKey } from '@wikistead/types'
import { emit } from '@wikistead/events'
import { enqueueOutbox, processOutboxAsync } from '../search/index.js'
import type { SearchDriver } from '../search/index.js'
import type { TenantDb } from '../db/index.js'

interface SpaceRow { id: string; tenant_id: string; name: string; created_at: Date }
export interface Space { id: string; tenantId: string; name: string; createdAt: Date; capability?: 'view' | 'edit' | 'manage'; accentKey?: string | null }
function toSpace(r: SpaceRow): Space {
  return { id: r.id, tenantId: r.tenant_id, name: r.name, createdAt: r.created_at }
}

// ── Service functions ─────────────────────────────────────────────────────

// Create a space. No outbox needed here (no pages exist yet in the space).
// Space creation triggers no Meili indexing; pages do when created.
export async function createSpace(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; userId: string; name: string; plan: string },
): Promise<Space> {
  const ent = resolveEntitlements(args.plan)
  if (isFinite(ent.maxSpaces)) {
    // TODO(phase: billing): count + insert race; see billing.ts for details.
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
    await writeTuples(fga, [
      { user: `tenant:${args.tenantId}`, relation: 'tenant',  object: `space:${r.id}` },
      { user: `user:${args.userId}`,    relation: 'manager', object: `space:${r.id}` },
    ])
    return r
  })
  const space = toSpace(row as SpaceRow)
  emit({ type: 'space.created', tenantId: args.tenantId, spaceId: space.id, actorId: args.userId })
  return space
}

// List the spaces the user is allowed to VIEW. RLS gives only tenant isolation;
// per-space view authorization is enforced here so the sidebar never lists (or
// leaks the name of) a space the user cannot access — the same "confirm via
// OpenFGA before display" rule the search two-stage guard follows (the project design notes).
export async function listSpaces(db: TenantDb, fga: OpenFgaClient, userId: string): Promise<Space[]> {
  // accent_key (space branding, Phase 5c) joined in so the client can apply the
  // space ▷ tenant ▷ default accent cascade without a per-space fetch.
  const rows = await db.sql<(SpaceRow & { accent_key: string | null })[]>`
    SELECT s.id, s.tenant_id, s.name, s.created_at, ss.accent_key
    FROM spaces s LEFT JOIN space_settings ss ON ss.space_id = s.id
    ORDER BY s.created_at
  `
  // Per space, derive the caller's capability (view|edit|manage) so the sidebar can
  // show/hide management actions (the UI signal; the server stays the fortress).
  // Spaces are few, so a few checks each is cheap. Non-viewable spaces are dropped.
  const caps = await Promise.all(
    rows.map(async (r) => {
      const ref = { type: 'space', id: r.id } as const
      const user = `user:${userId}`
      const [view, edit, manage] = await Promise.all([
        check(fga, user, 'view', ref),
        check(fga, user, 'edit', ref),
        check(fga, user, 'manage', ref),
      ])
      const capability: Space['capability'] | null = manage ? 'manage' : edit ? 'edit' : view ? 'view' : null
      return [r.id, capability] as const
    }),
  )
  const capById = new Map(caps)
  return rows.filter((r) => capById.get(r.id) != null).map((r) => ({ ...toSpace(r), capability: capById.get(r.id)!, accentKey: r.accent_key }))
}

// Set/clear a space's branding accent (Phase 5c). manage-gated AND entitlement-
// gated (branding is a Pro lever): a non-entitled tenant gets 403 upgrade_required.
// accentKey must be a known preset (see ACCENT_PRESETS) or null to clear (inherit).
export async function updateSpaceBranding(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { spaceId: string; tenantId: string; userId: string; plan: string; accentKey: string | null },
): Promise<void> {
  await requireSpaceManage(fga, args.userId, args.spaceId)
  if (!resolveEntitlements(args.plan).branding) {
    throw Object.assign(new Error('branding requires an upgrade'), { statusCode: 403, code: 'upgrade_required' })
  }
  if (args.accentKey !== null && !isAccentKey(args.accentKey)) {
    throw Object.assign(new Error('unknown accent'), { statusCode: 400 })
  }
  await db.sql`
    INSERT INTO space_settings (space_id, tenant_id, accent_key, updated_at)
    VALUES (${args.spaceId}, ${args.tenantId}, ${args.accentKey}, now())
    ON CONFLICT (space_id) DO UPDATE SET accent_key = ${args.accentKey}, updated_at = now()
  `
  emit({ type: 'space.branding_updated', tenantId: args.tenantId, spaceId: args.spaceId, actorId: args.userId })
}

// Delete a space and all its pages.
//
// Delete order: FGA first → outbox + DB in same tx.
// Each page gets a 'delete' outbox entry so Meili docs are cleaned even if
// Meilisearch is temporarily down. Outbox entries fire asynchronously
// after the tx commits (non-blocking).
export async function deleteSpace(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { tenantId: string; spaceId: string; userId: string },
): Promise<void> {
  const canManage = await check(fga, `user:${args.userId}`, 'manage', { type: 'space', id: args.spaceId })
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  const pages = await db.sql<{ id: string; tenant_id: string }[]>`
    SELECT id, tenant_id FROM pages WHERE space_id = ${args.spaceId}
  `
  for (const { id } of pages) await deleteObjectTuples(fga, `page:${id}`)
  await deleteObjectTuples(fga, `space:${args.spaceId}`)

  // Write all 'delete' outbox entries in the same tx as the DB DELETE.
  // ON DELETE CASCADE removes pages. Fire Meili deletes after tx commits.
  const outboxEntries: { id: string; tenantId: string; pageId: string }[] = []
  await db.tx(async (tx) => {
    for (const page of pages) {
      const oid = await enqueueOutbox(tx, { tenantId: page.tenant_id, pageId: page.id, operation: 'delete' })
      outboxEntries.push({ id: oid, tenantId: page.tenant_id, pageId: page.id })
    }
    await tx`DELETE FROM spaces WHERE id = ${args.spaceId}`
  })

  for (const e of outboxEntries) {
    processOutboxAsync(driver, e.id, { tenantId: e.tenantId, pageId: e.pageId, operation: 'delete' })
  }
  emit({ type: 'space.deleted', tenantId: args.tenantId, spaceId: args.spaceId, actorId: args.userId })
}

// Rename a space. manage authority required (a management action, same as delete /
// the 3b cross-space move) — not everyone who can edit should rename the space.
export async function updateSpace(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { spaceId: string; userId: string; name: string },
): Promise<Space> {
  const canManage = await check(fga, `user:${args.userId}`, 'manage', { type: 'space', id: args.spaceId })
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  const name = args.name.trim()
  if (!name) throw Object.assign(new Error('empty name'), { statusCode: 400 })
  const [row] = await db.sql<SpaceRow[]>`
    UPDATE spaces SET name = ${name} WHERE id = ${args.spaceId} RETURNING id, tenant_id, name, created_at`
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
  emit({ type: 'space.updated', tenantId: row.tenant_id, spaceId: row.id, actorId: args.userId })
  return toSpace(row)
}

// ── per-space access grant/revoke/list (Phase 5b) ───────────────────────────
// The space-level analogue of per-page access (Phase 4b). A space grant is the
// INHERITANCE ROOT: viewer/editor/manager on the space flows (OR) to every
// PUBLISHED page in it. It only ever WIDENS (monotonic) — there is no way to make
// one published page MORE private than its space here (that is a known limitation;
// privacy before publish is the draft model). Only a `manage` holder may
// list/grant/revoke, so the permission structure is never shown to — or handed out
// by — someone without authority. Grantees are members (user:<sub>) or groups
// (group:<id>#member); share_link / wildcard are not hand-grantable.
export type SpaceCapability = 'view' | 'edit' | 'manage'
const SPACE_CAPS: SpaceCapability[] = ['view', 'edit', 'manage']
// Capability vocabulary (shared with page access) → the space's FGA relations.
const CAP_TO_RELATION: Record<SpaceCapability, string> = { view: 'viewer', edit: 'editor', manage: 'manager' }
const RELATION_TO_CAP: Record<string, SpaceCapability> = { viewer: 'view', editor: 'edit', manager: 'manage' }

function validateSpaceGrant(grantee: string, capability: string): asserts capability is SpaceCapability {
  if (!SPACE_CAPS.includes(capability as SpaceCapability)) {
    throw Object.assign(new Error('relation must be view, edit, or manage'), { statusCode: 400 })
  }
  if (!/^user:[^*\s]+$/.test(grantee) && !/^group:[^\s]+#member$/.test(grantee)) {
    throw Object.assign(new Error('grantee must be user:<sub> or group:<id>#member'), { statusCode: 400 })
  }
}

async function requireSpaceManage(fga: OpenFgaClient, userId: string, spaceId: string): Promise<void> {
  const canManage = await check(fga, `user:${userId}`, 'manage', { type: 'space', id: spaceId })
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
}

async function requireTenantAdmin(fga: OpenFgaClient, userId: string, tenantId: string): Promise<void> {
  const { allowed } = await fga.check({ user: `user:${userId}`, relation: 'admin', object: `tenant:${tenantId}` })
  if (!allowed) throw Object.assign(new Error('admin only'), { statusCode: 403 })
}

// Tenant-wide spaces overview for the admin console (Phase 5 #4). tenant#admin
// gated. pageCount = pages in the space; grantCount = people/groups with a DIRECT
// space grant (inherited tenant-admin access is not counted — that's everyone).
export async function listAdminSpaces(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; userId: string },
): Promise<{ id: string; name: string; pageCount: number; grantCount: number }[]> {
  await requireTenantAdmin(fga, args.userId, args.tenantId)
  const rows = await db.sql<{ id: string; name: string; page_count: number }[]>`
    SELECT s.id, s.name, count(p.id)::int AS page_count
    FROM spaces s LEFT JOIN pages p ON p.space_id = s.id
    GROUP BY s.id, s.name ORDER BY s.created_at
  `
  const out: { id: string; name: string; pageCount: number; grantCount: number }[] = []
  for (const r of rows) {
    const { tuples } = await fga.read({ object: `space:${r.id}` })
    const grantees = new Set<string>()
    for (const { key } of tuples ?? []) {
      if (!key || !(key.relation in RELATION_TO_CAP)) continue
      if (!/^user:[^*\s]+$/.test(key.user) && !/^group:[^\s]+#member$/.test(key.user)) continue
      grantees.add(key.user)
    }
    out.push({ id: r.id, name: r.name, pageCount: r.page_count, grantCount: grantees.size })
  }
  return out
}

// A space access change alters inheritance for every PUBLISHED page in the space,
// so the denormalized search viewer set (doc-builder includes space viewers ONLY
// when page#space is present = published) must be refreshed for each. Drafts have
// no page#space, so they neither inherit nor need reindexing. Same reliable outbox
// path as deleteSpace; stage-2 FGA stays authoritative during any reindex lag.
async function reindexPublishedPages(db: TenantDb, driver: SearchDriver, tenantId: string, spaceId: string): Promise<void> {
  const pages = await db.sql<{ id: string }[]>`
    SELECT id FROM pages WHERE space_id = ${spaceId} AND published_at IS NOT NULL
  `
  if (pages.length === 0) return
  const entries: { id: string; pageId: string }[] = []
  await db.tx(async (tx) => {
    for (const p of pages) {
      const oid = await enqueueOutbox(tx, { tenantId, pageId: p.id, operation: 'upsert' })
      entries.push({ id: oid, pageId: p.id })
    }
  })
  for (const e of entries) processOutboxAsync(driver, e.id, { tenantId, pageId: e.pageId, operation: 'upsert' })
}

export async function grantSpaceAccess(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { spaceId: string; tenantId: string; userId: string; grantee: string; capability: string },
): Promise<void> {
  validateSpaceGrant(args.grantee, args.capability)
  await requireSpaceManage(fga, args.userId, args.spaceId)
  await writeTuples(fga, [{ user: args.grantee, relation: CAP_TO_RELATION[args.capability], object: `space:${args.spaceId}` }])
  await reindexPublishedPages(db, driver, args.tenantId, args.spaceId)
  emit({ type: 'space.access_granted', tenantId: args.tenantId, spaceId: args.spaceId, grantee: args.grantee, relation: args.capability, actorId: args.userId })
}

export async function revokeSpaceAccess(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { spaceId: string; tenantId: string; userId: string; grantee: string; capability: string },
): Promise<void> {
  validateSpaceGrant(args.grantee, args.capability)
  await requireSpaceManage(fga, args.userId, args.spaceId)
  await deleteTuples(fga, [{ user: args.grantee, relation: CAP_TO_RELATION[args.capability], object: `space:${args.spaceId}` }])
  await reindexPublishedPages(db, driver, args.tenantId, args.spaceId)
  emit({ type: 'space.access_revoked', tenantId: args.tenantId, spaceId: args.spaceId, grantee: args.grantee, relation: args.capability, actorId: args.userId })
}

export async function listSpaceAccess(
  fga: OpenFgaClient,
  args: { spaceId: string; userId: string },
): Promise<{ grantee: string; capability: SpaceCapability }[]> {
  await requireSpaceManage(fga, args.userId, args.spaceId)
  const { tuples } = await fga.read({ object: `space:${args.spaceId}` })
  const out: { grantee: string; capability: SpaceCapability }[] = []
  for (const { key } of tuples ?? []) {
    if (!key || !(key.relation in RELATION_TO_CAP)) continue
    // Direct member/group grants only — never expose share_link, user:* (public)
    // or the structural tenant link.
    if (!/^user:[^*\s]+$/.test(key.user) && !/^group:[^\s]+#member$/.test(key.user)) continue
    out.push({ grantee: key.user, capability: RELATION_TO_CAP[key.relation]! })
  }
  return out
}

// Member typeahead for the grant picker. manage-gated (a space manager may add any
// tenant member — Confluence parity), RLS-scoped to the tenant. Minimal projection
// {sub, displayName} ONLY — email is contact info (not needed to PICK), so it is
// not exposed in a candidate list (least exposure).
export async function listMemberCandidates(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { spaceId: string; userId: string; q: string },
): Promise<{ sub: string; displayName: string | null }[]> {
  await requireSpaceManage(fga, args.userId, args.spaceId)
  const like = `%${args.q.trim()}%`
  const rows = await db.sql<{ sub: string; display_name: string | null }[]>`
    SELECT sub, display_name FROM members
    WHERE display_name ILIKE ${like} OR sub ILIKE ${like}
    ORDER BY display_name NULLS LAST, sub
    LIMIT 10
  `
  return rows.map((r) => ({ sub: r.sub, displayName: r.display_name }))
}

// ── Fastify plugin ────────────────────────────────────────────────────────

export async function spacesPlugin(app: FastifyInstance) {
  app.post<{ Body: { name: string } }>('/spaces', async (req, reply) => {
    const space = await createSpace(req.db, app.fga, {
      tenantId: req.tenant.id,
      userId: req.user.sub,
      name: req.body.name,
      plan: req.tenant.plan,
    })
    return reply.code(201).send(space)
  })

  app.get('/spaces', async (req) => listSpaces(req.db, app.fga, req.user.sub))

  // Tenant admin overview of all spaces (tenant#admin).
  app.get('/admin/spaces', async (req) => listAdminSpaces(req.db, app.fga, { tenantId: req.tenant.id, userId: req.user.sub }))

  app.patch<{ Params: { spaceId: string }; Body: { name?: string } }>('/spaces/:spaceId', async (req) => {
    return updateSpace(req.db, app.fga, { spaceId: req.params.spaceId, userId: req.user.sub, name: req.body?.name ?? '' })
  })

  app.delete<{ Params: { spaceId: string } }>('/spaces/:spaceId', async (req, reply) => {
    await deleteSpace(req.db, app.fga, app.searchDriver, {
      tenantId: req.tenant.id,
      spaceId: req.params.spaceId,
      userId: req.user.sub,
    })
    return reply.code(204).send()
  })

  // ── per-space access (Phase 5b) — all manage-gated ──
  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/access', async (req) => {
    return listSpaceAccess(app.fga, { spaceId: req.params.spaceId, userId: req.user.sub })
  })

  app.post<{ Params: { spaceId: string }; Body: { grantee: string; relation: string } }>('/spaces/:spaceId/access', async (req, reply) => {
    await grantSpaceAccess(req.db, app.fga, app.searchDriver, {
      spaceId: req.params.spaceId, tenantId: req.tenant.id, userId: req.user.sub,
      grantee: req.body?.grantee ?? '', capability: req.body?.relation ?? '',
    })
    return reply.code(204).send()
  })

  app.delete<{ Params: { spaceId: string }; Body: { grantee: string; relation: string } }>('/spaces/:spaceId/access', async (req, reply) => {
    await revokeSpaceAccess(req.db, app.fga, app.searchDriver, {
      spaceId: req.params.spaceId, tenantId: req.tenant.id, userId: req.user.sub,
      grantee: req.body?.grantee ?? '', capability: req.body?.relation ?? '',
    })
    return reply.code(204).send()
  })

  app.get<{ Params: { spaceId: string }; Querystring: { q?: string } }>('/spaces/:spaceId/member-candidates', async (req) => {
    return listMemberCandidates(req.db, app.fga, { spaceId: req.params.spaceId, userId: req.user.sub, q: req.query?.q ?? '' })
  })

  // Space branding accent (Phase 5c) — manage + entitlement gated.
  app.patch<{ Params: { spaceId: string }; Body: { accentKey?: string | null } }>('/spaces/:spaceId/branding', async (req, reply) => {
    await updateSpaceBranding(req.db, app.fga, {
      spaceId: req.params.spaceId, tenantId: req.tenant.id, userId: req.user.sub,
      plan: req.tenant.plan, accentKey: req.body?.accentKey ?? null,
    })
    return reply.code(204).send()
  })
}
