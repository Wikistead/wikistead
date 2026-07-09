import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, writeTuples, deleteTuples, deleteObjectTuples } from '@wikistead/authz'
import { resolveEntitlements } from '@wikistead/entitlements'
import { isAccentKey } from '@wikistead/types'
import { emit } from '@wikistead/events'
import { enqueueOutbox, processOutboxAsync } from '../search/index.js'
import type { SearchDriver } from '../search/index.js'
import { groupGrantee, groupNameByFgaId, resolveGroupName } from '../auth/group-sync.js'
import { auditIfEntitled } from '../audit/outbox.js'
import { deletePinsForResources } from './pins.js'
import type { StorageDriver } from '../storage/index.js'
import type { TenantDb } from '../db/index.js'

interface SpaceRow { id: string; tenant_id: string; name: string; created_at: Date }
export interface Space { id: string; tenantId: string; name: string; createdAt: Date; capability?: 'view' | 'edit' | 'manage'; accentKey?: string | null; iconImageUrl?: string | null }
function toSpace(r: SpaceRow): Space {
  return { id: r.id, tenantId: r.tenant_id, name: r.name, createdAt: r.created_at }
}

// Space icon image (#6). Mirrors the tenant logo: a server-generated key + magic-byte
// sniff (NEVER the client content-type). SVG is excluded — the icon is a PUBLIC asset,
// so an SVG could carry <script> = stored XSS. png/jpeg/webp only.
const ICON_MAX_BYTES = 512 * 1024
// Bound the raw JSON body BEFORE parse so a huge base64 string can't exhaust memory
// (base64 ≈ 1.34x the bytes; this fits a ≤512KB image with JSON overhead).
const ICON_BODY_LIMIT = 1_000_000
function sniffImage(b: Uint8Array): { mime: string; ext: string } | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', ext: 'png' }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { mime: 'image/webp', ext: 'webp' }
  return null
}

// ── Service functions ─────────────────────────────────────────────────────

// Create a space. No outbox needed here (no pages exist yet in the space).
// Space creation triggers no Meili indexing; pages do when created.
export async function createSpace(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; userId: string; name: string; plan: string; personal?: boolean },
): Promise<Space> {
  const ent = resolveEntitlements(args.plan)
  // maxSpaces is enforced ATOMICALLY (#129 / ADR-044): the count + insert run in ONE tx, gated
  // by a per-tenant advisory xact lock, so two concurrent creates at the cap can't both pass the
  // check and both insert (the old count-outside-the-tx race). The lock is tenant-scoped (no
  // cross-tenant contention) and auto-releases at tx end; the count runs under tenant RLS.
  // entitlement(ce) is the bastion — the UI count is advisory; the server enforces here.
  // #226 / ADR-106: a PERSONAL space is EXEMPT from maxSpaces (it is per-member, not part of the shared-
  // space budget) — the auto-create must always succeed, so it skips the cap. This is a resource-kind
  // distinction (personal vs shared), NOT a plan branch: the cap value still comes from the resolver.
  const row = await db.tx(async (tx) => {
    if (!args.personal && isFinite(ent.maxSpaces)) {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`space:${args.tenantId}`}))`
      const [{ count }] = await tx<[{ count: string }]>`SELECT count(*)::text AS count FROM spaces WHERE personal_owner_sub IS NULL`
      if (Number(count) >= ent.maxSpaces) {
        throw Object.assign(new Error('space limit reached'), { statusCode: 403 })
      }
    }
    const [r] = await tx<SpaceRow[]>`
      INSERT INTO spaces (tenant_id, name, personal_owner_sub)
      VALUES (${args.tenantId}, ${args.name}, ${args.personal ? args.userId : null})
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

// #226 / ADR-106: idempotently ensure a member's owner-only personal space exists. Called best-effort on
// first sign-in (a failure must NOT block login). A fast-path read short-circuits the common case; the
// partial UNIQUE(tenant_id, personal_owner_sub) is the RACE AUTHORITY, so two concurrent first-logins can't
// both insert — the loser catches the unique violation and treats it as already-created. One member = one
// personal space; personal spaces are maxSpaces-exempt (createSpace personal path), so this always succeeds.
export async function ensurePersonalSpace(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; userId: string; name: string; plan: string },
): Promise<void> {
  const [existing] = await db.sql<{ id: string }[]>`
    SELECT id FROM spaces WHERE personal_owner_sub = ${args.userId} LIMIT 1`
  if (existing) return
  try {
    await createSpace(db, fga, { tenantId: args.tenantId, userId: args.userId, name: args.name, plan: args.plan, personal: true })
  } catch (err) {
    // A concurrent first-login won the race → the UNIQUE index rejected this insert. That's success, not
    // failure: the personal space exists. Any OTHER error is swallowed by the best-effort caller (login
    // must not break), but re-throwing a non-unique error here would surface a real bug in tests.
    const code = (err as { code?: string })?.code
    if (code !== '23505') throw err // 23505 = unique_violation (already created by the winning login)
  }
}

// List the spaces the user is allowed to VIEW. RLS gives only tenant isolation;
// per-space view authorization is enforced here so the sidebar never lists (or
// leaks the name of) a space the user cannot access — the same "confirm via
// OpenFGA before display" rule the search two-stage guard follows (the project design notes).
// #270: minimal space header for the GUEST reader-chrome — ONLY the name + public icon (never accent,
// capability, members, or any other field). A space-link guest is authorised to see the space they were
// shared into (their share_link is a `viewer` on it), so its name/icon is safe to show the recipient; the
// caller (the guest route) enforces the resource binding. RLS-scoped to the tenant.
export async function getSpaceInfo(db: TenantDb, spaceId: string): Promise<{ name: string; iconImageUrl: string | null } | null> {
  const [row] = await db.sql<{ name: string; icon_image_key: string | null }[]>`
    SELECT s.name, ss.icon_image_key
    FROM spaces s LEFT JOIN space_settings ss ON ss.space_id = s.id
    WHERE s.id = ${spaceId}
  `
  if (!row) return null
  return { name: row.name, iconImageUrl: row.icon_image_key ? `/spaces/${spaceId}/icon-image` : null }
}

export async function listSpaces(db: TenantDb, fga: OpenFgaClient, userId: string): Promise<Space[]> {
  // accent_key (space branding, Phase 5c) joined in so the client can apply the
  // space ▷ tenant ▷ default accent cascade without a per-space fetch.
  const rows = await db.sql<(SpaceRow & { accent_key: string | null; icon_image_key: string | null })[]>`
    SELECT s.id, s.tenant_id, s.name, s.created_at, ss.accent_key, ss.icon_image_key
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
  // iconImageUrl is a relative API path (the client prefixes it with the API base for
  // the <img> src). Public bytes are served by GET /spaces/:id/icon-image.
  return rows.filter((r) => capById.get(r.id) != null).map((r) => ({
    ...toSpace(r), capability: capById.get(r.id)!, accentKey: r.accent_key,
    iconImageUrl: r.icon_image_key ? `/spaces/${r.id}/icon-image` : null,
  }))
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

// (The text-glyph icon override was removed — a space icon is an uploaded image or the
// auto initials chip. The `space_settings.icon` column is left dormant; not exposed.)

// Upload a space icon IMAGE (#6). manage-gated, NOT entitlement-gated. base64 in (no
// multipart dependency): the raw body is bounded by the route bodyLimit AND the decoded
// size is checked here, so a giant base64 string can't exhaust memory. The content type
// is derived from magic bytes (SVG rejected), the key is server-generated + space-
// scoped (no user filename), and the previous object is deleted. Mirrors setTenantLogo.
export async function setSpaceIconImage(
  db: TenantDb,
  fga: OpenFgaClient,
  storage: StorageDriver,
  args: { spaceId: string; tenantId: string; userId: string; dataBase64: string },
): Promise<void> {
  await requireSpaceManage(fga, args.userId, args.spaceId)
  const bytes = Buffer.from(args.dataBase64 ?? '', 'base64')
  if (bytes.length === 0) throw Object.assign(new Error('empty image'), { statusCode: 400 })
  if (bytes.length > ICON_MAX_BYTES) throw Object.assign(new Error('image too large'), { statusCode: 413 })
  const kind = sniffImage(bytes)
  if (!kind) throw Object.assign(new Error('unsupported image (png, jpeg, webp only)'), { statusCode: 400 })

  const key = `spaces/${args.spaceId}/icon-${randomUUID()}.${kind.ext}`
  await storage.putObject(key, bytes, kind.mime)
  const [old] = await db.sql<{ icon_image_key: string | null }[]>`SELECT icon_image_key FROM space_settings WHERE space_id = ${args.spaceId}`
  await db.sql`
    INSERT INTO space_settings (space_id, tenant_id, icon_image_key, icon_image_content_type, updated_at)
    VALUES (${args.spaceId}, ${args.tenantId}, ${key}, ${kind.mime}, now())
    ON CONFLICT (space_id) DO UPDATE SET icon_image_key = ${key}, icon_image_content_type = ${kind.mime}, updated_at = now()
  `
  if (old?.icon_image_key && old.icon_image_key !== key) await storage.deleteObject(old.icon_image_key).catch(() => {})
  emit({ type: 'space.updated', tenantId: args.tenantId, spaceId: args.spaceId, actorId: args.userId })
}

export async function clearSpaceIconImage(
  db: TenantDb,
  fga: OpenFgaClient,
  storage: StorageDriver,
  args: { spaceId: string; tenantId: string; userId: string },
): Promise<void> {
  await requireSpaceManage(fga, args.userId, args.spaceId)
  const [old] = await db.sql<{ icon_image_key: string | null }[]>`SELECT icon_image_key FROM space_settings WHERE space_id = ${args.spaceId}`
  await db.sql`UPDATE space_settings SET icon_image_key = NULL, icon_image_content_type = NULL, updated_at = now() WHERE space_id = ${args.spaceId}`
  if (old?.icon_image_key) await storage.deleteObject(old.icon_image_key).catch(() => {})
  emit({ type: 'space.updated', tenantId: args.tenantId, spaceId: args.spaceId, actorId: args.userId })
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
    // #284 / ADR-119: best-effort pin cleanup (space + its pages). Correctness does
    // not depend on this — the pin display gate drops orphans — it's row hygiene.
    await deletePinsForResources(tx, [args.spaceId, ...pages.map((p) => p.id)])
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

// #258 / ADR-110: a member VIEW grant writes BOTH `viewer` (unchanged — pages inherit view via
// view_base_from_space = viewer from space, and existing readers of `viewer` are untouched) AND
// `viewer_member` (the member-only relation template#view inherits, so a public/shared space never exposes
// its space-scoped templates to guests/anon). Additive: no existing `viewer` tuple is migrated. Only for the
// `viewer` relation (member/group grants — validateSpaceGrant already forbids wildcard/share_link here);
// editor/manager grants are single-tuple as before. Revoke deletes the same pair (kept in sync).
function spaceGrantTuples(grantee: string, relation: string, spaceId: string): { user: string; relation: string; object: string }[] {
  const base = { user: grantee, relation, object: `space:${spaceId}` }
  return relation === 'viewer' ? [base, { user: grantee, relation: 'viewer_member', object: `space:${spaceId}` }] : [base]
}

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

// #258 one-time migration: existing `space:S#viewer@<member>` tuples predate viewer_member, so template#view
// (now `viewer_member from space`) wouldn't see those members until re-granted. Copy each member/group viewer
// grant to viewer_member. Idempotent (skips ones already present) and safe to re-run. Wildcards/share_link are
// NOT copied — they must stay viewer-only so a public/shared space never leaks its templates to guests/anon.
// prod runner enumerates `SELECT id FROM spaces` (admin pool) and passes the ids; returns tuples written.
export async function backfillSpaceViewerMembers(fga: OpenFgaClient, spaceIds: string[]): Promise<number> {
  const isMember = (u?: string) => !!u && (/^user:[^*\s]+$/.test(u) || /^group:[^\s]+#member$/.test(u))
  let written = 0
  for (const spaceId of spaceIds) {
    // A migration must be exhaustive: page through ALL of the space's tuples (fga.read caps a single
    // page at ~50–100), else members past the first page never get viewer_member — and since we always
    // re-read from page 1, a re-run would keep missing them. Accumulate the full set before writing.
    const viewerMembers = new Set<string>()
    const haveViewerMember = new Set<string>()
    let token: string | undefined
    do {
      const page = await fga.read({ object: `space:${spaceId}` }, token ? { continuationToken: token } : undefined)
      for (const t of page.tuples ?? []) {
        if (t.key?.relation === 'viewer' && isMember(t.key.user)) viewerMembers.add(t.key.user)
        else if (t.key?.relation === 'viewer_member' && t.key.user) haveViewerMember.add(t.key.user)
      }
      token = page.continuation_token || undefined
    } while (token)
    const toWrite = [...viewerMembers].filter((u) => !haveViewerMember.has(u))
    if (toWrite.length) {
      await writeTuples(fga, toWrite.map((user) => ({ user, relation: 'viewer_member', object: `space:${spaceId}` })))
      written += toWrite.length
    }
  }
  return written
}

export async function grantSpaceAccess(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { spaceId: string; tenantId: string; userId: string; grantee: string; capability: string; plan?: string },
): Promise<void> {
  validateSpaceGrant(args.grantee, args.capability)
  await requireSpaceManage(fga, args.userId, args.spaceId)
  const relation = CAP_TO_RELATION[args.capability] // narrowed here (assertion doesn't flow into the closure)
  // Durable audit (#177) + FGA in one tx; FGA LAST so a grant failure rolls the audit back.
  await db.tx(async (tx) => {
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'space.access_granted', target: `space:${args.spaceId}` })
    }
    await writeTuples(fga, spaceGrantTuples(args.grantee, relation, args.spaceId))
  })
  await reindexPublishedPages(db, driver, args.tenantId, args.spaceId)
  emit({ type: 'space.access_granted', tenantId: args.tenantId, spaceId: args.spaceId, grantee: args.grantee, relation: args.capability, actorId: args.userId })
}

export async function revokeSpaceAccess(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { spaceId: string; tenantId: string; userId: string; grantee: string; capability: string; plan?: string },
): Promise<void> {
  validateSpaceGrant(args.grantee, args.capability)
  await requireSpaceManage(fga, args.userId, args.spaceId)
  const relation = CAP_TO_RELATION[args.capability] // narrowed here (assertion doesn't flow into the closure)
  // Durable audit (#177) + FGA in one tx; FGA LAST so a revoke failure rolls the audit back.
  await db.tx(async (tx) => {
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'space.access_revoked', target: `space:${args.spaceId}` })
    }
    await deleteTuples(fga, spaceGrantTuples(args.grantee, relation, args.spaceId))
  })
  await reindexPublishedPages(db, driver, args.tenantId, args.spaceId)
  emit({ type: 'space.access_revoked', tenantId: args.tenantId, spaceId: args.spaceId, grantee: args.grantee, relation: args.capability, actorId: args.userId })
}

export async function listSpaceAccess(
  fga: OpenFgaClient,
  db: TenantDb,
  args: { spaceId: string; tenantId: string; userId: string },
): Promise<{ grantee: string; capability: SpaceCapability; groupName?: string }[]> {
  await requireSpaceManage(fga, args.userId, args.spaceId)
  const { tuples } = await fga.read({ object: `space:${args.spaceId}` })
  // #163: resolve group grantee ids back to names for display (groupFgaId is one-way).
  const names = (await db.sql<{ g: string }[]>`SELECT DISTINCT unnest(groups) AS g FROM members WHERE groups IS NOT NULL`).map((r) => r.g)
  const byId = groupNameByFgaId(args.tenantId, names)
  const out: { grantee: string; capability: SpaceCapability; groupName?: string }[] = []
  for (const { key } of tuples ?? []) {
    if (!key || !(key.relation in RELATION_TO_CAP)) continue
    // Direct member/group grants only — never expose share_link, user:* (public)
    // or the structural tenant link.
    if (!/^user:[^*\s]+$/.test(key.user) && !/^group:[^\s]+#member$/.test(key.user)) continue
    const groupName = resolveGroupName(key.user, byId)
    out.push({ grantee: key.user, capability: RELATION_TO_CAP[key.relation]!, ...(groupName ? { groupName } : {}) })
  }
  return out
}

// Comment AUDIENCE setting (#100 / ADR-029) — a resource setting, not a link capability. Toggling it
// writes/deletes the wildcard `space:<id>#comment_open@{share_link:*, user:*}` tuples (is_public-style;
// FGA is the source of truth), which the page `comment` relation intersects with `view_base`. Pages
// inherit `comment_open from space` (space is the only inheritance level). No reindex needed: the VIEW
// audience is unchanged (viewers already view via view_base; comment_open only opens commenting).
async function readCommentOpen(fga: OpenFgaClient, spaceId: string): Promise<{ guests: boolean; members: boolean }> {
  const { tuples } = await fga.read({ object: `space:${spaceId}` })
  let guests = false, members = false
  for (const { key } of tuples ?? []) {
    if (key?.relation !== 'comment_open') continue
    if (key.user === 'share_link:*') guests = true
    else if (key.user === 'user:*') members = true
  }
  return { guests, members }
}

export async function getSpaceCommentOpen(
  fga: OpenFgaClient,
  args: { spaceId: string; userId: string },
): Promise<{ guests: boolean; members: boolean }> {
  await requireSpaceManage(fga, args.userId, args.spaceId)
  return readCommentOpen(fga, args.spaceId)
}

// Set the comment audience(s). Idempotent: reads the current wildcards and writes only the missing /
// deletes only the present ones (writeTuples/deleteTuples are not idempotent on their own). `guests`
// toggles `share_link:*`, `members` toggles `user:*`; an undefined field is left unchanged.
export async function setSpaceCommentOpen(
  fga: OpenFgaClient,
  args: { spaceId: string; userId: string; guests?: boolean; members?: boolean },
): Promise<{ guests: boolean; members: boolean }> {
  await requireSpaceManage(fga, args.userId, args.spaceId)
  const cur = await readCommentOpen(fga, args.spaceId)
  const writes: { user: string; relation: string; object: string }[] = []
  const deletes: { user: string; relation: string; object: string }[] = []
  const obj = `space:${args.spaceId}`
  const apply = (want: boolean | undefined, have: boolean, user: string) => {
    if (want === undefined || want === have) return
    ;(want ? writes : deletes).push({ user, relation: 'comment_open', object: obj })
  }
  apply(args.guests, cur.guests, 'share_link:*')
  apply(args.members, cur.members, 'user:*')
  if (deletes.length) await deleteTuples(fga, deletes)
  if (writes.length) await writeTuples(fga, writes)
  return {
    guests: args.guests ?? cur.guests,
    members: args.members ?? cur.members,
  }
}

// Tenant group-name source for the group-grant picker (#163 / ADR-053). The set of group names
// seen across the tenant's members (IdP-imported via members.groups, #111 — no manual group CRUD).
// manage-gated like the grant itself: group NAMES can themselves be sensitive (existence leak), so
// this is NOT open to every member — only someone who can actually grant on this space (#163
// review condition). RLS-scopes to the tenant. A name with zero current members is still listed
// (granting to it is allowed — it resolves once members sync, ADR-053).
export async function listTenantGroups(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { spaceId: string; userId: string },
): Promise<string[]> {
  await requireSpaceManage(fga, args.userId, args.spaceId)
  const rows = await db.sql<{ g: string }[]>`
    SELECT DISTINCT unnest(groups) AS g FROM members WHERE groups IS NOT NULL ORDER BY g
  `
  return rows.map((r) => r.g).filter((g) => g != null && g !== '')
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
    return listSpaceAccess(app.fga, req.db, { spaceId: req.params.spaceId, tenantId: req.tenant.id, userId: req.user.sub })
  })

  // grantee = user:<sub> | group:<id>#member (raw), OR groupName (#163: server resolves it to
  // group:<id>#member via groupGrantee → groupFgaId, so the id always matches #111's sync).
  app.post<{ Params: { spaceId: string }; Body: { grantee?: string; groupName?: string; relation: string } }>('/spaces/:spaceId/access', async (req, reply) => {
    const grantee = req.body?.groupName ? groupGrantee(req.tenant.id, req.body.groupName) : (req.body?.grantee ?? '')
    await grantSpaceAccess(req.db, app.fga, app.searchDriver, {
      spaceId: req.params.spaceId, tenantId: req.tenant.id, userId: req.user.sub,
      grantee, capability: req.body?.relation ?? '', plan: req.tenant.plan,
    })
    return reply.code(204).send()
  })

  app.delete<{ Params: { spaceId: string }; Body: { grantee?: string; groupName?: string; relation: string } }>('/spaces/:spaceId/access', async (req, reply) => {
    const grantee = req.body?.groupName ? groupGrantee(req.tenant.id, req.body.groupName) : (req.body?.grantee ?? '')
    await revokeSpaceAccess(req.db, app.fga, app.searchDriver, {
      spaceId: req.params.spaceId, tenantId: req.tenant.id, userId: req.user.sub,
      grantee, capability: req.body?.relation ?? '', plan: req.tenant.plan,
    })
    return reply.code(204).send()
  })

  // Comment audience setting (#100 / ADR-029): read + toggle who may comment on this space's pages —
  // guests (any view link) and/or public members. manage-gated (it's an administrative setting).
  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/comment-open', async (req) => {
    return getSpaceCommentOpen(app.fga, { spaceId: req.params.spaceId, userId: req.user.sub })
  })
  app.patch<{ Params: { spaceId: string }; Body: { guests?: boolean; members?: boolean } }>('/spaces/:spaceId/comment-open', async (req) => {
    return setSpaceCommentOpen(app.fga, {
      spaceId: req.params.spaceId, userId: req.user.sub,
      guests: req.body?.guests, members: req.body?.members,
    })
  })

  // Tenant group-name source for the group-grant picker (#163). manage-gated (group names can be
  // sensitive — not exposed to all members).
  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/groups', async (req) => {
    return listTenantGroups(req.db, app.fga, { spaceId: req.params.spaceId, userId: req.user.sub })
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

  // Space icon IMAGE (#6) — manage-gated write (base64; bodyLimit bounds the raw body).
  app.post<{ Params: { spaceId: string }; Body: { data?: string } }>('/spaces/:spaceId/icon-image', { bodyLimit: ICON_BODY_LIMIT }, async (req, reply) => {
    await setSpaceIconImage(req.db, app.fga, app.storageDriver, {
      spaceId: req.params.spaceId, tenantId: req.tenant.id, userId: req.user.sub, dataBase64: req.body?.data ?? '',
    })
    return reply.code(204).send()
  })

  app.delete<{ Params: { spaceId: string } }>('/spaces/:spaceId/icon-image', async (req, reply) => {
    await clearSpaceIconImage(req.db, app.fga, app.storageDriver, {
      spaceId: req.params.spaceId, tenantId: req.tenant.id, userId: req.user.sub,
    })
    return reply.code(204).send()
  })

  // PUBLIC icon bytes (read public, write strict — mirrors the tenant logo). The query
  // is RLS-scoped to the Host-resolved tenant, so a space id from another tenant yields
  // no row (404) — no cross-tenant read. Icons are not secret; serving them unauthed
  // lets <img> tags (which can't send a bearer) render them. 404 when unset.
  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/icon-image', { config: { public: true } }, async (req, reply) => {
    const [row] = await req.db.sql<{ icon_image_key: string | null; icon_image_content_type: string | null }[]>`
      SELECT icon_image_key, icon_image_content_type FROM space_settings WHERE space_id = ${req.params.spaceId}
    `
    if (!row?.icon_image_key) return reply.code(404).send()
    const bytes = await app.storageDriver.getObject(row.icon_image_key)
    return reply
      .header('Content-Type', row.icon_image_content_type ?? 'application/octet-stream')
      .header('Cache-Control', 'public, max-age=300')
      .send(Buffer.from(bytes))
  })
}
