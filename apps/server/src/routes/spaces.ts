import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, filterAuthorized, writeTuples, deleteTuples, deleteObjectTuples, readObjectTuples, requireTenantAdmin, isSpaceCreator } from '@wikistead/authz'
import { resolveEntitlements } from '@wikistead/entitlements'
import { isAccentKey } from '@wikistead/types'
import { emit } from '@wikistead/events'
import { spaceGrantTuplesFor } from '../space-grant-expansion.js' // #514 §6: the ONE capability→relation table
import { enqueueOutbox, processOutboxAsync } from '../search/index.js'
import type { SearchDriver } from '../search/index.js'
import { groupGrantee, groupNameByFgaId, resolveGroupName } from '../auth/group-sync.js'
import { resolveAuthorIdentities } from '../author-identity.js' // #523 / ADR-190: full name on the manage-gated grant list
import { rollupPageViews, validateRollupQuery, isUniqueMode, type RollupQuery } from '../analytics/rollup.js' // #520 / ADR-189
import { auditIfEntitled } from '../audit/outbox.js'
import { deletePinsForResources } from './pins.js'
import { sweepWatchesForResources, sweepUnviewableWatches } from './notifications.js'
import { importArchive, ImportTooLargeError, ImportInvalidError } from '../import/index.js'
import type { StorageDriver } from '../storage/index.js'
import type { TenantDb } from '../db/index.js'

interface SpaceRow { id: string; tenant_id: string; name: string; created_at: Date }
export interface Space { id: string; tenantId: string; name: string; createdAt: Date; capability?: 'view' | 'edit' | 'manage'; canModerate?: boolean; accentKey?: string | null; iconImageUrl?: string | null; homePageId?: string | null; deleteMode?: 'trash_only' | 'both' | 'direct_only' }
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
// #308: bound the base64 import body BEFORE parse. The streaming unzip caps (IMPORT_MAX_*) bound the INFLATED
// size; this bounds the compressed upload (base64 ≈ 1.34x): ~200MB zip → ~270MB JSON body.
const IMPORT_BODY_LIMIT = 280 * 1024 * 1024
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
  // #445 / ADR-171 (supersedes the #399 §2 knob): space creation is the tenant-role capability
  // `tenant#space_creator` — ONE FGA check, no settings SELECT / admin branch. The wildcard tuple
  // (seeded at provisioning, toggled by the member default-role preset) is "all members may create";
  // custom tenant-role expansions add user/group leaves; admins always pass via the model's
  // `or admin` arm. RESTRICT-ONLY (gates creation, grants nothing else). The PERSONAL auto-create
  // stays exempt (a resource kind, not a privilege — first login must always succeed; ADR-158's
  // ruling carries over).
  if (!args.personal) {
    if (!(await isSpaceCreator(fga, args.userId, args.tenantId))) {
      // `code` (not just `reason`) is what Fastify serialises into the body — the client needs it to
      // say WHY (#445the denial was silent because nothing reached the browser).
      throw Object.assign(new Error('space creation is restricted'), { statusCode: 403, code: 'space_creator', reason: 'space_creator' })
    }
  }
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
// #364①: `viewer` (optional) adds a VIEW-GATED homePageId for the caller — the same ADR-157 §2
// oracle guard as listSpaces: the pointer is exposed ONLY when the caller can FGA-view the home page
// (a share_link guest sees it only for a PUBLISHED, link-covered home; an unpublished/private home is
// byte-identically absent = null, never an existence oracle).
export async function getSpaceInfo(
  db: TenantDb,
  spaceId: string,
  viewer?: { fga: OpenFgaClient; subject: string; context?: { current_time: string } },
): Promise<{ name: string; iconImageUrl: string | null; homePageId: string | null } | null> {
  const [row] = await db.sql<{ name: string; icon_image_key: string | null; home_page_id: string | null }[]>`
    SELECT s.name, ss.icon_image_key, s.home_page_id
    FROM spaces s LEFT JOIN space_settings ss ON ss.space_id = s.id
    WHERE s.id = ${spaceId}
  `
  if (!row) return null
  let homePageId: string | null = null
  if (row.home_page_id && viewer) {
    const ok = await check(viewer.fga, viewer.subject, 'view', { type: 'page', id: row.home_page_id }, viewer.context).catch(() => false)
    homePageId = ok ? row.home_page_id : null
  }
  return { name: row.name, iconImageUrl: row.icon_image_key ? `/spaces/${spaceId}/icon-image` : null, homePageId }
}

export async function listSpaces(db: TenantDb, fga: OpenFgaClient, userId: string): Promise<Space[]> {
  // accent_key (space branding, Phase 5c) joined in so the client can apply the
  // space ▷ tenant ▷ default accent cascade without a per-space fetch.
  // #437 / ADR-167: the RESOLVED delete mode rides the listing so the client can shape the delete
  // menu (trash / permanent / both) without a per-space fetch. A UI measure only — the routes gate.
  const rows = await db.sql<(SpaceRow & { accent_key: string | null; icon_image_key: string | null; home_page_id: string | null; delete_mode: string | null; tenant_delete_mode: string | null })[]>`
    SELECT s.id, s.tenant_id, s.name, s.created_at, s.home_page_id, ss.accent_key, ss.icon_image_key,
           s.delete_mode, (SELECT delete_mode FROM tenant_settings LIMIT 1) AS tenant_delete_mode
    FROM spaces s LEFT JOIN space_settings ss ON ss.space_id = s.id
    ORDER BY s.created_at
  `
  // Per space, derive the caller's capability (view|edit|manage) so the sidebar can
  // show/hide management actions (the UI signal; the server stays the fortress).
  // Spaces are few, so a few checks each is cheap. Non-viewable spaces are dropped.
  const user = `user:${userId}`
  const spaceIds = rows.map((r) => r.id)
  // #489 / ADR-183: batch the per-space capability fan-out — it was 4 individual FGA checks × N spaces
  // (676+ round-trips for 169 spaces, ~1.16s cold) — into 4 server-side BatchCheck passes, one per
  // capability, exactly as #500 batched the page tree. Each pass returns the authorized subset for that
  // capability; the per-space derivation below is byte-equivalent to the old per-check version (pinned by
  // the anti-test).
  // #326: `moderate` is reported ALONGSIDE the capability rather than folded into it. A space moderator is
  // not a manager (model.fga: `moderator … or manager`), and collapsing the two would hand every moderator
  // the rename/delete affordances. The UI needs both to offer the moderation queue without space settings.
  const [viewSet, editSet, manageSet, moderateSet] = await Promise.all([
    filterAuthorized(fga, user, 'view', spaceIds, undefined, 'space'),
    filterAuthorized(fga, user, 'edit', spaceIds, undefined, 'space'),
    filterAuthorized(fga, user, 'manage', spaceIds, undefined, 'space'),
    filterAuthorized(fga, user, 'moderate', spaceIds, undefined, 'space'),
  ])
  const capById = new Map(rows.map((r) => {
    const capability: Space['capability'] | null =
      manageSet.has(r.id) ? 'manage' : editSet.has(r.id) ? 'edit' : viewSet.has(r.id) ? 'view' : null
    return [r.id, { capability, canModerate: moderateSet.has(r.id) }] as const
  }))
  // iconImageUrl is a relative API path (the client prefixes it with the API base for
  // the <img> src). Public bytes are served by GET /spaces/:id/icon-image.
  // #364 / ADR-157 §2 (the pointer must not become an existence oracle): expose homePageId ONLY when the
  // CALLER can `view` the pointed page — via the shared FGA primitive, never a bespoke check. A denied
  // pointer is OMITTED (null), byte-identical to "no home set". #489: batched too — ONE BatchCheck over the
  // home pages of the VIEWABLE spaces (same gate as before: a non-viewable space's pointer is never
  // consulted, so its home page id never enters the batch).
  const homePageIds = rows
    .filter((r) => r.home_page_id != null && capById.get(r.id)?.capability != null)
    .map((r) => r.home_page_id as string)
  const homeOk = await filterAuthorized(fga, user, 'view', homePageIds) // type defaults to 'page'
  const homeVisible = new Map(rows.map((r) => [r.id, r.home_page_id != null && homeOk.has(r.home_page_id)] as const))
  return rows.filter((r) => capById.get(r.id)?.capability != null).map((r) => ({
    ...toSpace(r), capability: capById.get(r.id)!.capability!, canModerate: capById.get(r.id)!.canModerate, accentKey: r.accent_key,
    iconImageUrl: r.icon_image_key ? `/spaces/${r.id}/icon-image` : null,
    homePageId: homeVisible.get(r.id) ? r.home_page_id : null,
    deleteMode: (r.delete_mode ?? r.tenant_delete_mode ?? 'trash_only') as 'trash_only' | 'both' | 'direct_only',
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
    await sweepWatchesForResources(tx, [args.spaceId, ...pages.map((p) => p.id)]) // #320 / ADR-126: watch row hygiene
    // #536 review 4: assignment rows on the space (and its pages) go with it. FGA is the authz truth
    // so orphans confer nothing — this is row hygiene, and it matters more now that every built-in grant
    // leaves a row (the pre-536 orphan population was custom-role assignments only).
    await tx`DELETE FROM role_assignments WHERE (resource_type = 'space' AND resource_id = ${args.spaceId})
             OR (resource_type = 'page' AND resource_id = ANY(${pages.map((p) => p.id)}))`
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
  args: { spaceId: string; userId: string; name: string; driver?: SearchDriver },
): Promise<Space> {
  const canManage = await check(fga, `user:${args.userId}`, 'manage', { type: 'space', id: args.spaceId })
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  const name = args.name.trim()
  if (!name) throw Object.assign(new Error('empty name'), { statusCode: 400 })
  // #364→(user ruling, plan A): the home page's title IS the space name — no language
  // suffix is ever STORED (the "Home / " wording is a pure UI label the viewer's i18n renders).
  // A space rename re-writes the home title in the same tx (and re-indexes it for search).
  let outboxId: string | null = null
  let homeId: string | null = null
  const row = await db.tx(async (tx) => {
    const [r] = await tx<(SpaceRow & { home_page_id: string | null })[]>`
      UPDATE spaces SET name = ${name} WHERE id = ${args.spaceId} RETURNING id, tenant_id, name, created_at, home_page_id`
    if (!r) throw Object.assign(new Error('not found'), { statusCode: 404 })
    if (r.home_page_id) {
      const [updated] = await tx<{ id: string }[]>`
        UPDATE pages SET title = ${name}, updated_at = now()
        WHERE id = ${r.home_page_id} AND deleted_at IS NULL RETURNING id`
      if (updated) {
        homeId = updated.id
        outboxId = await enqueueOutbox(tx, { tenantId: r.tenant_id, pageId: updated.id, operation: 'upsert' })
      }
    }
    return r
  })
  if (outboxId && homeId && args.driver) {
    processOutboxAsync(args.driver, outboxId, { tenantId: row.tenant_id, pageId: homeId, operation: 'upsert' })
  }
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
// #330 / ADR-141 adds `moderate` → space#moderator (revert/freeze/patrol + page edit via the bypass; NOT manage).
export type SpaceCapability = 'view' | 'comment' | 'edit' | 'moderate' | 'manage'
const SPACE_CAPS: SpaceCapability[] = ['view', 'comment', 'edit', 'moderate', 'manage']
// Capability vocabulary (shared with page access) → the space's FGA relations.
// #274 / ADR-135: a member EDIT grant writes `editor_member` (the member-only leaf viewer_member /
// template#view reference); `editor` itself now carries only space edit SHARE-LINKS. The reverse map
// keeps `editor` → 'edit' so a pre-migration store's legacy member tuples still LIST correctly during
// the Step-A window (listSpaceAccess filters principals to user/group, so post-migration the mapping
// only ever sees share_link tuples there — which that filter drops).
// #529 / ADR-193: `comment` gains its own space leaf, so a comment-only grant is finally expressible.
// #514 / ADR-188 §6: the built-in grant no longer keeps its own capability→relation table. Both this path
// and the custom-role assignment expand through space-grant-expansion.ts, so the two cannot drift (the gap
// between them is where the #485 bug lived).
export const RELATION_TO_CAP: Record<string, SpaceCapability> = { viewer: 'view', commenter: 'comment', editor: 'edit', editor_member: 'edit', moderator: 'moderate', manager: 'manage' }

// #258 / ADR-110: a member VIEW grant writes BOTH `viewer` (unchanged — pages inherit view via
// view_base_from_space = viewer from space, and existing readers of `viewer` are untouched) AND
// `viewer_member` (the member-only relation template#view inherits, so a public/shared space never exposes
// its space-scoped templates to guests/anon). Additive: no existing `viewer` tuple is migrated. Only for the
// `viewer` relation (member/group grants — validateSpaceGrant already forbids wildcard/share_link here);
// editor/manager grants are single-tuple as before. Revoke deletes the same pair (kept in sync).
const spaceGrantTuples = spaceGrantTuplesFor // the shared expansion (#514 §6); the viewer/viewer_member
// pairing that used to be special-cased here is the `view` entry of that one table.

function validateSpaceGrant(grantee: string, capability: string): asserts capability is SpaceCapability {
  if (!SPACE_CAPS.includes(capability as SpaceCapability)) {
    throw Object.assign(new Error('relation must be view, comment, edit, moderate, or manage'), { statusCode: 400 })
  }
  if (!/^user:[^*\s]+$/.test(grantee) && !/^group:[^\s]+#member$/.test(grantee)) {
    throw Object.assign(new Error('grantee must be user:<sub> or group:<id>#member'), { statusCode: 400 })
  }
}

async function requireSpaceManage(fga: OpenFgaClient, userId: string, spaceId: string): Promise<void> {
  const canManage = await check(fga, `user:${userId}`, 'manage', { type: 'space', id: spaceId })
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
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
    // #553 re-review: paginated — a truncated read UNDER-counts grantees, and this number is what
    // the admin screen reports as "who can reach this space".
    const grantees = new Set<string>()
    for (const key of await readObjectTuples(fga, `space:${r.id}`)) {
      if (!(key.relation in RELATION_TO_CAP)) continue
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
export async function reindexPublishedPages(db: TenantDb, driver: SearchDriver, tenantId: string, spaceId: string): Promise<void> {
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

// ── #536item 2: ONE principal = ONE role on a space ──────────────────
//
// Policy (reported on the ticket): a manual add REPLACES the principal's other manual roles instead of
// stacking — the alternative (reject) turns the common "change someone's role" edit into revoke-then-add,
// and the Members picker offers no way to see why the add was refused. Two layers: the UI confirms the
// replacement; the server converges regardless of who calls (a direct API double-grant cannot stack).
//
// Boundaries
// - SPACE scope only — the ruling is about the space Members surface; page/tenant assignment semantics
// are unchanged.
// - A MACHINE-owned row (origin mapping/default) is never replaced by a manual add — ADR-183 §1: the
// mapping owns its assignment. The add is refused up front (409) so the machine state stays intact.
// - Legacy ROWLESS grants (pre-086 FGA tuples with no role_assignments row) are swept in the same pass,
// so the principal converges to exactly the new role. This IS the recorded migration policy for
// pre-existing duplicate data: it is cleaned up on the next add for that principal (no bulk backfill
// untouched principals keep their historical rows/tuples until someone edits them).

// The up-front refusal: adding a role to a principal whose CURRENT role is machine-managed would replace
// machine state. Runs BEFORE any write so a 409 leaves everything untouched.
export async function assertNoMachineSpaceRole(
  db: TenantDb,
  args: { spaceId: string; principal: string; keep: { builtinCapability?: string; builtinCapabilities?: string[]; roleId?: string } },
): Promise<void> {
  const rows = await db.sql<{ origin: string; role_id: string | null; builtin_capability: string | null }[]>`
    SELECT origin, role_id, builtin_capability FROM role_assignments
    WHERE resource_type = 'space' AND resource_id = ${args.spaceId} AND principal = ${args.principal}`
  const isKeep = (r: { role_id: string | null; builtin_capability: string | null }) =>
    (args.keep.builtinCapability !== undefined && r.builtin_capability === args.keep.builtinCapability) ||
    (args.keep.builtinCapabilities !== undefined && r.builtin_capability !== null && args.keep.builtinCapabilities.includes(r.builtin_capability)) ||
    (args.keep.roleId !== undefined && r.role_id === args.keep.roleId)
  if (rows.some((r) => !isKeep(r) && r.origin !== 'manual')) {
    throw Object.assign(new Error('the principal already holds a machine-managed role — edit the mapping instead'), { statusCode: 409 })
  }
}

// The convergence sweep: runs AFTER the new row landed (so the principal never has an access gap), and
// removes (a) every OTHER manual row via the refcount-aware unassign core, then (b) any legacy rowless
// FGA capability the surviving rows don't cover. One reindex at the end when anything changed.
export async function sweepOtherSpaceRoles(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: {
    spaceId: string; tenantId: string; userId: string; principal: string;
    keep: { builtinCapability?: string; builtinCapabilities?: string[]; roleId?: string }; keepCaps: string[]; plan?: string;
  },
): Promise<void> {
  const rows = await db.sql<{ id: string; origin: string; role_id: string | null; builtin_capability: string | null }[]>`
    SELECT id, origin, role_id, builtin_capability FROM role_assignments
    WHERE resource_type = 'space' AND resource_id = ${args.spaceId} AND principal = ${args.principal}`
  const isKeep = (r: { role_id: string | null; builtin_capability: string | null }) =>
    (args.keep.builtinCapability !== undefined && r.builtin_capability === args.keep.builtinCapability) ||
    (args.keep.builtinCapabilities !== undefined && r.builtin_capability !== null && args.keep.builtinCapabilities.includes(r.builtin_capability)) ||
    (args.keep.roleId !== undefined && r.role_id === args.keep.roleId)
  // `manage` is EXEMPT from auto-replacement (row-tracked here, rowless below): silently demoting a
  // manager on an unrelated add is the owner-lockout footgun — a manager is demoted only by an explicit
  // revoke. Everything below manage converges to one role.
  const others = rows.filter((r) => !isKeep(r) && r.origin === 'manual' && r.builtin_capability !== 'manage')
  const { unassignRoleInTx } = await import('./roles.js')
  let changed = false
  for (const r of others) {
    await unassignRoleInTx(db, fga, driver, {
      tenant: { id: args.tenantId, plan: args.plan ?? '' },
      assignmentId: r.id,
      actorSub: args.userId,
      // keep each mechanism's own audit vocabulary (the #536 rule: the mechanism changed, the event didn't)
      ...(r.builtin_capability !== null ? { auditAction: 'space.access_revoked' } : {}),
      skipAudit: args.plan === undefined,
    })
  }
  // Legacy rowless tuples: whatever FGA still grants this principal beyond the kept role's bundle goes,
  // unless a surviving row covers it (same covering rule as the rowless revoke path).
  // (unassignRoleInTx reindexed per removed row already — only the rowless tuple sweep below still needs one)
  changed = false
  // fga-read-ok: ONE principal on ONE object — a (user, relation, object) tuple is unique, so the row count is bounded by the type's relation count (~15), never by tenant size.
  const { tuples } = await fga.read({ user: args.principal, object: `space:${args.spaceId}` })
  // Group the tuples that ACTUALLY exist by capability — deletion must target exactly these keys (a
  // legacy/seeded grant can hold only half of an expansion pair, and deleting a non-existent tuple is
  // an FGA error that would fail the whole add after the new row already landed).
  const heldByCap = new Map<string, { user: string; relation: string; object: string }[]>()
  for (const t of tuples ?? []) {
    const rel = t.key?.relation ?? ''
    const cap = RELATION_TO_CAP[rel]
    if (!cap) continue
    const list = heldByCap.get(cap) ?? []
    list.push({ user: args.principal, relation: rel, object: `space:${args.spaceId}` })
    heldByCap.set(cap, list)
  }
  for (const [cap, held] of heldByCap) {
    if (args.keepCaps.includes(cap)) continue
    // A ROWLESS `manage` is indistinguishable from the structural owner leaf createSpace writes for the
    // creator — sweeping it would let "assign any role to the owner" silently destroy their manage and
    // lock them out of their own space. Rowless manage is therefore never swept (an EXPLICIT, row-tracked
    // manager grant still replaces normally above — that swap is visible and confirmed in the UI).
    if (cap === 'manage') continue
    const covering = await db.sql`
      SELECT 1 FROM role_assignments a LEFT JOIN roles r ON r.id = a.role_id
      WHERE a.resource_type = 'space' AND a.resource_id = ${args.spaceId} AND a.principal = ${args.principal}
        AND ${cap} = ANY(COALESCE(r.capabilities, ARRAY[a.builtin_capability])) LIMIT 1`
    if (covering.length === 0) {
      await deleteTuples(fga, held)
      changed = true
    }
  }
  if (changed) await reindexPublishedPages(db, driver, args.tenantId, args.spaceId)
}

export async function grantSpaceAccess(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { spaceId: string; tenantId: string; userId: string; grantee: string; capability: string; plan?: string },
): Promise<void> {
  validateSpaceGrant(args.grantee, args.capability)
  await requireSpaceManage(fga, args.userId, args.spaceId)
  // #536 / ADR-188 §6 item 1: a built-in grant IS a role assignment now. It goes through the same helper a
  // custom role does, differing only in which column of the row identifies what was granted -- so a
  // built-in grant finally participates in the reference count that decides whether a shared leaf may be
  // deleted. Before this, a grant and an overlapping role assignment were invisible to each other: whoever
  // was revoked second took the other's access with it.
  //
  // The audit action stays `space.access_granted` (not `role.assigned`). The mechanism changed; what
  // happened did not, and an audit stream that silently renames its events is one nobody can search.
  const { assignRoleInTx } = await import('./roles.js')
  // #497 (088): the idempotent dup path ('ignore') would silently ADOPT a mapping-owned row — a 204
  // that grants nothing and later confuses both surfaces about who owns the assignment. Same refusal
  // as revoke: the mapping is the owner; manage the grant through it.
  const [held] = await db.sql<{ origin: string }[]>`
    SELECT origin FROM role_assignments
    WHERE builtin_capability = ${args.capability} AND resource_type = 'space' AND resource_id = ${args.spaceId} AND principal = ${args.grantee}`
  if (held?.origin === 'mapping') {
    throw Object.assign(new Error('managed by a group mapping — edit the mapping instead'), { statusCode: 409 })
  }
  // #536item 2: 1 principal = 1 role — a machine-owned row refuses the add up front; after the
  // new row lands, the principal's other manual roles (rows + legacy rowless tuples) are swept.
  await assertNoMachineSpaceRole(db, { spaceId: args.spaceId, principal: args.grantee, keep: { builtinCapability: args.capability } })
  await assignRoleInTx(db, fga, driver, {
    tenant: { id: args.tenantId, plan: args.plan ?? '' },
    roleId: null,
    builtinCapability: args.capability,
    capabilities: [args.capability as never],
    resourceType: 'space',
    resourceId: args.spaceId,
    principal: args.grantee,
    actorSub: args.userId,
    // Granting what someone already has is not an error here: the Members control has no "already
    // granted" state to show, and the pre-#536 path simply wrote the tuple again.
    onDuplicate: 'ignore',
    auditAction: 'space.access_granted',
    skipAudit: args.plan === undefined,
  })
  await sweepOtherSpaceRoles(db, fga, driver, {
    spaceId: args.spaceId, tenantId: args.tenantId, userId: args.userId, principal: args.grantee,
    keep: { builtinCapability: args.capability }, keepCaps: [args.capability], plan: args.plan,
  })
  emit({ type: 'space.access_granted', tenantId: args.tenantId, spaceId: args.spaceId, grantee: args.grantee, relation: args.capability, actorId: args.userId })
}

// #553 / ADR-199 §2: the editor-noun COMPOSITE grant — where a built-in role NOUN is offered, choosing
// it issues N single-capability grants (today: editor = edit + comment) in one transaction, then ONE
// sweep keeping both arms. The bare-capability form stays exactly what it says (an API that quietly
// granted more than asked would be the same lie #553 removes); the bundle lives only where the noun is.
// The server's ONE bundle table lives in roles.ts (builtinBundle); this surface derives from it
// rather than restating it (#497 re-review: three copies of the same table — web, roles, spaces
// with nothing pinning them equal, and a drift meant "the mapping creates arms the Members
// composite then refuses with 400").
const sameCapSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')

export async function grantSpaceAccessComposite(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { spaceId: string; tenantId: string; userId: string; grantee: string; capabilities: string[]; plan?: string },
): Promise<void> {
  for (const cap of args.capabilities) validateSpaceGrant(args.grantee, cap)
  // #553 review D: the plural wire form is NOT a free-form multi-grant — only the ruled noun
  // bundles pass (today: editor = edit+comment). An arbitrary capability list would slip N roles
  // past the one-principal-one-role convergence (#536) through the sweep's keep-set.
  const { builtinBundle } = await import('./roles.js')
  const allowed = [...new Set(Object.values(RELATION_TO_CAP))].map((c) => builtinBundle(c)).filter((b) => b.length > 1)
  if (!allowed.some((b) => sameCapSet(b, args.capabilities))) {
    throw Object.assign(new Error('unknown composite grant'), { statusCode: 400 })
  }
  await requireSpaceManage(fga, args.userId, args.spaceId)
  // machine-row refusal across BOTH arms (the same 409 the single grant gives)
  const held = await db.sql<{ origin: string; builtin_capability: string | null }[]>`
    SELECT origin, builtin_capability FROM role_assignments
    WHERE resource_type = 'space' AND resource_id = ${args.spaceId} AND principal = ${args.grantee}
      AND builtin_capability = ANY(${args.capabilities})`
  if (held.some((h) => h.origin === 'mapping')) {
    throw Object.assign(new Error('managed by a group mapping — edit the mapping instead'), { statusCode: 409 })
  }
  await assertNoMachineSpaceRole(db, { spaceId: args.spaceId, principal: args.grantee, keep: { builtinCapabilities: args.capabilities } })
  const { assignBuiltinCompositeInTx } = await import('./roles.js')
  await assignBuiltinCompositeInTx(db, fga, driver, {
    tenant: { id: args.tenantId, plan: args.plan ?? '' },
    spaceId: args.spaceId, principal: args.grantee, actorSub: args.userId,
    capabilities: args.capabilities,
    auditAction: 'space.access_granted',
    skipAudit: args.plan === undefined,
  })
  await sweepOtherSpaceRoles(db, fga, driver, {
    spaceId: args.spaceId, tenantId: args.tenantId, userId: args.userId, principal: args.grantee,
    keep: { builtinCapabilities: args.capabilities }, keepCaps: args.capabilities, plan: args.plan,
  })
  // one event per arm — the mechanism changed, what happened did not (#536 rule); two precise events
  for (const cap of args.capabilities) {
    emit({ type: 'space.access_granted', tenantId: args.tenantId, spaceId: args.spaceId, grantee: args.grantee, relation: cap, actorId: args.userId })
  }
}

export async function revokeSpaceAccess(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { spaceId: string; tenantId: string; userId: string; grantee: string; capability: string; plan?: string },
): Promise<void> {
  validateSpaceGrant(args.grantee, args.capability)
  await requireSpaceManage(fga, args.userId, args.spaceId)
  // #536 / ADR-188 §6 item 1: revoke the ROW when there is one, so the reference count decides which
  // leaves may go. A principal holding both a `view` grant and a role bundling `view` keeps viewing after
  // either one is taken away — which is what "still granted" has always meant everywhere else.
  const { unassignRoleInTx } = await import('./roles.js')
  const [row] = await db.sql<{ id: string; origin: string }[]>`
    SELECT id, origin FROM role_assignments
    WHERE builtin_capability = ${args.capability} AND resource_type = 'space' AND resource_id = ${args.spaceId} AND principal = ${args.grantee}`
  // #497 (088): a mapping OWNS its assignment (ADR-183 §1). Before 088 a mapping row could never match
  // this builtin lookup (its builtin_capability was always NULL), so the Members revoke could not reach
  // one; with built-in mappings it can — and revoking it here would strand the mapping as a console row
  // that claims access nobody holds, with its own delete a silent no-op. Machine-managed rows are
  // removed where the machine is: delete the MAPPING.
  if (row?.origin === 'mapping') {
    throw Object.assign(new Error('managed by a group mapping — delete the mapping instead'), { statusCode: 409 })
  }
  if (row) {
    await unassignRoleInTx(db, fga, driver, {
      tenant: { id: args.tenantId, plan: args.plan ?? '' },
      assignmentId: row.id, actorSub: args.userId,
      auditAction: 'space.access_revoked', skipAudit: args.plan === undefined,
    })
  } else {
    // A grant made before migration 086 has no row (deliberately — see 086: reconstructing rows from
    // tuples would assert grants nobody made). It stays revocable — but not refcount-blind (#536 review)
    // this pre-086 delete path knows nothing about assignment rows, so with a live custom-role assignment
    // bundling the same capability it deleted the shared leaf out from under it. If any row still covers
    // the capability, the tuples stay — the rowless grant is subsumed and "revoking" it removes nothing
    // the surviving assignment does not still confer.
    const covering = await db.sql`
      SELECT 1 FROM role_assignments a LEFT JOIN roles r ON r.id = a.role_id
      WHERE a.resource_type = 'space' AND a.resource_id = ${args.spaceId} AND a.principal = ${args.grantee}
        AND ${args.capability} = ANY(COALESCE(r.capabilities, ARRAY[a.builtin_capability])) LIMIT 1`
    await db.tx(async (tx) => {
      if (args.plan !== undefined) {
        await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'space.access_revoked', target: `space:${args.spaceId}` })
      }
      if (covering.length === 0) await deleteTuples(fga, spaceGrantTuples(args.grantee, args.capability, args.spaceId))
    })
    await reindexPublishedPages(db, driver, args.tenantId, args.spaceId)
  }
  // #362 E1: revocation watch sweep (post-FGA, best-effort; per-watcher view re-check inside — a watcher
  // whose view survives via another path keeps their watch). Space-scoped: sweeps watches ON the space id
  // (page-level fallout is covered by the display gate; page grants have their own sweep).
  void sweepUnviewableWatches(db, fga, [args.spaceId]).catch(() => {})
  emit({ type: 'space.access_revoked', tenantId: args.tenantId, spaceId: args.spaceId, grantee: args.grantee, relation: args.capability, actorId: args.userId })
}

export async function listSpaceAccess(
  fga: OpenFgaClient,
  db: TenantDb,
  args: { spaceId: string; tenantId: string; userId: string },
): Promise<{ grantee: string; capability: SpaceCapability; groupName?: string; displayName?: string | null; managed?: boolean }[]> {
  await requireSpaceManage(fga, args.userId, args.spaceId)
  // #553 re-review N1: paginated — a bare read answers ONE page (50) and the comment arm falling off
  // it would draw an unfolded editor row whose revoke strips edit but leaves comment behind.
  const tuples = await readObjectTuples(fga, `space:${args.spaceId}`)
  // #163: resolve group grantee ids back to names for display (groupFgaId is one-way).
  const names = (await db.sql<{ g: string }[]>`SELECT DISTINCT unnest(groups) AS g FROM members WHERE groups IS NOT NULL`).map((r) => r.g)
  const byId = groupNameByFgaId(args.tenantId, names)
  // #497 (088): a row conferred BY A MAPPING is machine-managed (ADR-183 §1) — the list says so, and
  // the UI drops the revoke affordance for it (the server refuses anyway; two layers, UI convenience).
  const managed = new Set((await db.sql<{ builtin_capability: string; principal: string }[]>`
    SELECT builtin_capability, principal FROM role_assignments
    WHERE resource_type = 'space' AND resource_id = ${args.spaceId} AND origin = 'mapping' AND builtin_capability IS NOT NULL`)
    .map((r) => `${r.principal} ${r.builtin_capability}`))
  // #536(5), measured on the motivating data: a CUSTOM-role assignment expands into per-capability
  // tuples, and this list rendered those expansion tuples as INDEPENDENT built-in grant rows — one aaa
  // (view/edit/publish/delete) assignment showed as AAA + VIEWER + EDITOR rows for the same principal.
  // A capability owned by a custom-role row is that row's expansion, not a separate grant, so it is
  // filtered here — UNLESS the same (principal, capability) also exists as a BUILT-IN row (then the
  // tuple is the built-in grant's own face and must stay, or its revoke becomes unreachable). `manage`
  // is never filtered: the manager tuple can be the structural owner leaf, which no row represents.
  const customOwned = new Set<string>()
  const builtinOwned = new Set<string>()
  for (const r of await db.sql<{ principal: string; caps: string[] | null; builtin_capability: string | null }[]>`
    SELECT a.principal, COALESCE(r.capabilities, ARRAY[a.builtin_capability]) AS caps, a.builtin_capability
    FROM role_assignments a LEFT JOIN roles r ON r.id = a.role_id
    WHERE a.resource_type = 'space' AND a.resource_id = ${args.spaceId}`) {
    for (const c of r.caps ?? []) (r.builtin_capability != null ? builtinOwned : customOwned).add(`${r.principal} ${c}`)
  }
  const out: { grantee: string; capability: SpaceCapability; groupName?: string; displayName?: string | null; managed?: boolean }[] = []
  for (const key of tuples) {
    if (!(key.relation in RELATION_TO_CAP)) continue
    // Direct member/group grants only — never expose share_link, user:* (public)
    // or the structural tenant link.
    if (!/^user:[^*\s]+$/.test(key.user) && !/^group:[^\s]+#member$/.test(key.user)) continue
    const groupName = resolveGroupName(key.user, byId)
    const cap = RELATION_TO_CAP[key.relation]!
    if (cap !== 'manage' && customOwned.has(`${key.user} ${cap}`) && !builtinOwned.has(`${key.user} ${cap}`)) continue
    out.push({ grantee: key.user, capability: cap, ...(groupName ? { groupName } : {}), ...(managed.has(`${key.user} ${cap}`) ? { managed: true } : {}) })
  }
  // #523 / ADR-190: FULL name resolution (override ?? OIDC display_name) for the USER grantees. This is a
  // server-set, VIEW-GATED result set — the caller already passed requireSpaceManage, so these are grants
  // they can see; naming them is not a membership oracle (the #486/ADR-150 Addendum-2 precedent). Resolved
  // on the caller's RLS handle so a cross-tenant sub returns ABSENT (→ null, the client keeps the sub).
  // NEVER an email (resolveAuthorIdentities); guest/anon subs are structurally dropped there. Unlike
  // /members/identities (arbitrary client subs → customized-only, no oracle), THIS set is authorization-
  // bounded, so full resolution — including un-customized members — is safe and is the point of #523.
  const userSubs = out.filter((g) => g.grantee.startsWith('user:') && !g.groupName).map((g) => g.grantee.slice('user:'.length))
  if (userSubs.length > 0) {
    const ids = await resolveAuthorIdentities(db, userSubs)
    for (const g of out) {
      if (g.grantee.startsWith('user:') && !g.groupName) g.displayName = ids.get(g.grantee.slice('user:'.length))?.displayName ?? null
    }
  }
  return out
}

// Comment AUDIENCE setting (#100 / ADR-029) — a resource setting, not a link capability. Toggling it
// writes/deletes the wildcard `space:<id>#comment_open@{share_link:*, user:*}` tuples (is_public-style;
// FGA is the source of truth), which the page `comment` relation intersects with `view_base`. Pages
// inherit `comment_open from space` (space is the only inheritance level). No reindex needed: the VIEW
// audience is unchanged (viewers already view via view_base; comment_open only opens commenting).
async function readCommentOpen(fga: OpenFgaClient, spaceId: string): Promise<{ guests: boolean; members: boolean }> {
  // #553 re-review N2: paginated — the comment_open wildcards are written LAST on a busy space, so a
  // one-page read would show the toggle OFF while the audience is actually open.
  const tuples = await readObjectTuples(fga, `space:${spaceId}`)
  let guests = false, members = false
  for (const key of tuples) {
    if (key.relation !== 'comment_open') continue
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

// ── Space public toggle (#277 / ADR-116) ─────────────────────────────────
// The space-level mirror of setPagePublic: writes/deletes the anonymous
// `space:S#viewer@user:*` wildcard (model.fga). Every page's exposure flows through
// `view_base_from_space = viewer from space but not private`, so private pages stay cut
// CONTINUOUSLY by the model — unlike the page toggle there is no public⊥private TOCTOU
// and no compensating re-read. Guardrails: the tenant parent switch is enforced at the
// ROUTE (403 while OFF); manage-gated with a UNIFORM 403 (never an existence oracle);
// audited in-tx; spaces.noindex forced true in the same tx; and the space's published
// pages are bulk-reindexed via the OUTBOX (durable — review condition ③, never
// best-effort) so the denormalised search `is_public` tracks the new inheritance. The
// doc-builder resolves is_public per page from FGA at reindex time, so enqueueing ALL
// published pages is correct (a private page recomputes to non-public; no filter here).

const SPACE_PUBLIC_GRANT = (spaceId: string) => ({ user: 'user:*', relation: 'viewer', object: `space:${spaceId}` })

// Review condition ④ (defence-in-depth): before writing a GLOBAL user:* wildcard, assert the
// space row exists under THIS tenant's RLS — symmetric with the public read route's belt
// (public.ts, the in-tenant SELECT). The FGA manage gate already blocks foreign spaces; failing
// here throws the SAME uniform 403 as a non-manager, so the write endpoint stays existence-blind.
async function assertSpaceInTenant(db: TenantDb, spaceId: string): Promise<void> {
  const [r] = await db.sql<{ id: string }[]>`SELECT id FROM spaces WHERE id = ${spaceId}`
  if (!r) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
}

// Enqueue an outbox upsert for every PUBLISHED page of the space (inside the caller's tx),
// returning the jobs to fire after commit. Draft pages have no search doc to update.
async function enqueueSpaceReindex(
  tx: Sql,
  args: { tenantId: string; spaceId: string },
): Promise<{ id: string; pageId: string }[]> {
  const pages = await tx<{ id: string }[]>`
    SELECT id FROM pages WHERE space_id = ${args.spaceId} AND published_at IS NOT NULL
  `
  const jobs: { id: string; pageId: string }[] = []
  for (const p of pages) {
    jobs.push({ id: await enqueueOutbox(tx, { tenantId: args.tenantId, pageId: p.id, operation: 'upsert' }), pageId: p.id })
  }
  return jobs
}

export async function setSpacePublic(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { spaceId: string; tenantId: string; userId: string; plan?: string },
): Promise<void> {
  await requireSpaceManage(fga, args.userId, args.spaceId)
  await assertSpaceInTenant(db, args.spaceId)
  const jobs = await db.tx(async (tx) => {
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'space.made_public', target: `space:${args.spaceId}` })
    }
    // Guardrail 4: a newly-public space is never crawler-indexed by default (same tx as the grant).
    await tx`UPDATE spaces SET noindex = true WHERE id = ${args.spaceId}`
    const j = await enqueueSpaceReindex(tx, { tenantId: args.tenantId, spaceId: args.spaceId })
    await writeTuples(fga, [SPACE_PUBLIC_GRANT(args.spaceId)])
    return j
  })
  for (const j of jobs) processOutboxAsync(driver, j.id, { tenantId: args.tenantId, pageId: j.pageId, operation: 'upsert' })
  emit({ type: 'space.made_public', tenantId: args.tenantId, spaceId: args.spaceId, actorId: args.userId })
}

// Revoke: ONE tuple delete + the same bulk reindex (is_public drops). Per-page public grants
// (view_base@user:* written by the ADR-113 page toggle) are UNTOUCHED — non-destructive.
// noindex stays as-is (harmless while non-public; the future "allow indexing" toggle owns it).
export async function unsetSpacePublic(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { spaceId: string; tenantId: string; userId: string; plan?: string },
): Promise<void> {
  await requireSpaceManage(fga, args.userId, args.spaceId)
  const jobs = await db.tx(async (tx) => {
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'space.made_non_public', target: `space:${args.spaceId}` })
    }
    const j = await enqueueSpaceReindex(tx, { tenantId: args.tenantId, spaceId: args.spaceId })
    await deleteTuples(fga, [SPACE_PUBLIC_GRANT(args.spaceId)]).catch(() => {}) // idempotent — may not be public
    return j
  })
  for (const j of jobs) processOutboxAsync(driver, j.id, { tenantId: args.tenantId, pageId: j.pageId, operation: 'upsert' })
  emit({ type: 'space.made_non_public', tenantId: args.tenantId, spaceId: args.spaceId, actorId: args.userId })
}

// Manage-gated read of the space's public state for the toggle UI's authoritative read.
export async function isSpacePublic(fga: OpenFgaClient, args: { spaceId: string; userId: string }): Promise<boolean> {
  await requireSpaceManage(fga, args.userId, args.spaceId)
  // #553 re-review: paginated — a space with >50 viewer tuples could hide `viewer@user:*` past the
  // first page and report a PUBLIC space as private (the toggle would then read as off).
  const tuples = await readObjectTuples(fga, `space:${args.spaceId}`)
  return tuples.some((k) => k.relation === 'viewer' && k.user === 'user:*')
}

// The tenant parent switch (#253 / ADR-113 guardrail 1), read fresh. Kept as a LOCAL read
// (same one-row SELECT as pages.ts publicSurfaceEnabled) to avoid a pages↔spaces import cycle.
async function spacePublicSurfaceEnabled(db: TenantDb): Promise<boolean> {
  const [row] = await db.sql<{ public_enabled: boolean }[]>`SELECT public_enabled FROM tenant_settings LIMIT 1`
  return row?.public_enabled === true
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
  return searchMemberCandidates(db, args.q)
}

// #416 / ADR-161: the ONE candidate-search core shared by the space- and page-scoped endpoints (the
// gates differ; the projection must not). {sub, displayName} ONLY, LIMIT 10, and an EMPTY query returns
// [] — never the first-10 member dump (the ADR's empty-query pin, enforced for both callers here).
export async function searchMemberCandidates(
  db: TenantDb,
  q: string,
): Promise<{ sub: string; displayName: string | null }[]> {
  const needle = q.trim()
  if (!needle) return []
  const like = `%${needle}%`
  const rows = await db.sql<{ sub: string; display_name: string | null }[]>`
    SELECT sub, display_name FROM members
    WHERE display_name ILIKE ${like} OR sub ILIKE ${like}
    ORDER BY display_name NULLS LAST, sub
    LIMIT 10
  `
  return rows.map((r) => ({ sub: r.sub, displayName: r.display_name }))
}

// ── Fastify plugin ────────────────────────────────────────────────────────

// #364 / ADR-157 §3: create the space HOME — one endpoint creates a regular page (title = the space
// name) and points `spaces.home_page_id` at it ATOMICALLY (the pointer write rides createPage's own
// transaction via onCreatedInTx; a lost race rolls the page insert back and 409s). Gate = space `edit`
// (owner ruling 3); the policy knob (#399) applies inside createPage's chokepoint like every create.
// #364(user ruling, plan A): the home page's STORED title is the space name, nothing else
// deriveHomeTitle (the language-suffixed variant) is retired. The "Home / " suffix is rendered
// by the viewer's UI from an i18n key, so search / pins / breadcrumbs keep one language-stable stored
// value, every surface follows the VIEWER's language (anonymous/guest included), and the export
// `_home.md` H1 is simply the space name. The title stays locked (updatePage refuses a home rename).

export async function createSpaceHome(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { tenantId: string; spaceId: string; userId: string },
): Promise<{ id: string }> {
  const canEdit = await check(fga, `user:${args.userId}`, 'edit', { type: 'space', id: args.spaceId })
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  const [row] = await db.sql<[{ name: string; home_page_id: string | null }?]>`
    SELECT name, home_page_id FROM spaces WHERE id = ${args.spaceId}`
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
  // #411 interplay: a TRASHED home keeps the row (no FK SET NULL) but is byte-identically absent
  // everywhere (the trash markers revoke view, so the oracle guard already omits the pointer). The
  // empty state then shows the create button — allow REPLACING a trashed home's pointer; if that
  // trashed page is later restored it comes back as a REGULAR page (the pointer moved on).
  let replaceable: string | null = null
  if (row.home_page_id) {
    const [cur] = await db.sql<[{ deleted_at: Date | null }?]>`SELECT deleted_at FROM pages WHERE id = ${row.home_page_id}`
    if (cur && cur.deleted_at == null) throw Object.assign(new Error('a home page already exists'), { statusCode: 409 })
    replaceable = row.home_page_id
  }
  const { createPage } = await import('./pages.js')
  const page = await createPage(db, fga, driver, {
    tenantId: args.tenantId,
    spaceId: args.spaceId,
    userId: args.userId,
    //the locked title IS the space name (no stored suffix; updatePage refuses a home rename)
    title: row.name,
    onCreatedInTx: async (tx, pageId) => {
      // the conditional write IS the race guard: someone else pointed first → 0 rows → rollback → 409
      const updated = replaceable
        ? await tx`UPDATE spaces SET home_page_id = ${pageId} WHERE id = ${args.spaceId} AND home_page_id = ${replaceable} RETURNING id`
        : await tx`UPDATE spaces SET home_page_id = ${pageId} WHERE id = ${args.spaceId} AND home_page_id IS NULL RETURNING id`
      if (updated.length === 0) throw Object.assign(new Error('a home page already exists'), { statusCode: 409 })
    },
  })
  return { id: page.id }
}

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

  // #364 / ADR-157: create-and-point the space home (edit-gated; 409 when one exists).
  app.post<{ Params: { spaceId: string } }>('/spaces/:spaceId/home', async (req, reply) => {
    const created = await createSpaceHome(req.db, app.fga, app.searchDriver, {
      tenantId: req.tenant.id,
      spaceId: req.params.spaceId,
      userId: req.user.sub,
    })
    return reply.code(201).send(created)
  })

  // Tenant admin overview of all spaces (tenant#admin).
  app.get('/admin/spaces', async (req) => listAdminSpaces(req.db, app.fga, { tenantId: req.tenant.id, userId: req.user.sub }))

  app.patch<{ Params: { spaceId: string }; Body: { name?: string } }>('/spaces/:spaceId', async (req) => {
    return updateSpace(req.db, app.fga, { spaceId: req.params.spaceId, userId: req.user.sub, name: req.body?.name ?? '', driver: app.searchDriver })
  })

  app.delete<{ Params: { spaceId: string } }>('/spaces/:spaceId', async (req, reply) => {
    await deleteSpace(req.db, app.fga, app.searchDriver, {
      tenantId: req.tenant.id,
      spaceId: req.params.spaceId,
      userId: req.user.sub,
    })
    return reply.code(204).send()
  })

  // #399 / ADR-158 §3: the per-space page-creation policy knob (manage-gated, the comment-open shape).
  // RESTRICT-ONLY — enforcement lives inside createPage (the chokepoint); this only stores the setting.
  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/page-creation-policy', async (req) => {
    await requireSpaceManage(app.fga, req.user.sub, req.params.spaceId)
    const [row] = await req.db.sql<[{ page_creation_policy: string }?]>`
      SELECT page_creation_policy FROM spaces WHERE id = ${req.params.spaceId}`
    return { pageCreationPolicy: row?.page_creation_policy ?? 'editors' }
  })
  app.put<{ Params: { spaceId: string }; Body: { pageCreationPolicy?: string } }>('/spaces/:spaceId/page-creation-policy', async (req, reply) => {
    await requireSpaceManage(app.fga, req.user.sub, req.params.spaceId)
    const v = req.body?.pageCreationPolicy
    if (v !== 'editors' && v !== 'managers') return reply.code(400).send({ error: "pageCreationPolicy ('editors' | 'managers') required" })
    await req.db.sql`UPDATE spaces SET page_creation_policy = ${v} WHERE id = ${req.params.spaceId}`
    return { pageCreationPolicy: v }
  })

  // #437 / ADR-167: the per-space delete-mode override (manage-gated, the page-creation-policy shape).
  // NULL inherits the tenant default; enforcement lives in trashPage/directDeletePage — this only
  // stores the setting. Pathways only: WHO may delete is untouched in every mode.
  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/delete-mode', async (req) => {
    await requireSpaceManage(app.fga, req.user.sub, req.params.spaceId)
    const [row] = await req.db.sql<[{ mode: string | null; tenant_mode: string | null }?]>`
      SELECT s.delete_mode AS mode, (SELECT delete_mode FROM tenant_settings LIMIT 1) AS tenant_mode
      FROM spaces s WHERE s.id = ${req.params.spaceId}`
    const tenantDefault = row?.tenant_mode ?? 'trash_only'
    return { deleteMode: row?.mode ?? null, tenantDefault, resolved: row?.mode ?? tenantDefault }
  })
  app.put<{ Params: { spaceId: string }; Body: { deleteMode?: string | null } }>('/spaces/:spaceId/delete-mode', async (req, reply) => {
    await requireSpaceManage(app.fga, req.user.sub, req.params.spaceId)
    const v = req.body?.deleteMode ?? null
    if (v !== null && v !== 'trash_only' && v !== 'both' && v !== 'direct_only') {
      return reply.code(400).send({ error: "deleteMode ('trash_only' | 'both' | 'direct_only' | null) required" })
    }
    await req.db.sql`UPDATE spaces SET delete_mode = ${v} WHERE id = ${req.params.spaceId}`
    return { deleteMode: v }
  })

  // #520 / ADR-189 (analytics v2 · slice 1): SPACE-level page-view aggregation. Rolls up page_view_daily
  // over ONLY the pages the caller can MANAGE (§5 manage-filter-set) — never space#viewer (the ADR-126 leak
  // class), so a private page's view activity never surfaces to a non-manager. Existence floor: space `view`
  // (a 404 hides a space you cannot see). EE-gated exactly like the per-page dashboard (#464). No roster, no
  // member names, no minted IDs — aggregate counts only (the search-term stream was rejected at Review).
  // #520 / ADR-189 slice 2: period (from/to date range) + viewerClass filter + sort (day|views · asc|desc)
  // as OPTIONAL query params. These only SHAPE the already-authorized roll-up (they run AFTER the §5
  // manage-filter-set), so the authz surface is unchanged from slice 1. Everything is validated and
  // parameterised (the sort clause is picked from a fixed allowlist, never interpolated user text).
  // #520 / ADR-189 slice 3: `unique=true` switches the MEMBER metric from summed page counts to DISTINCT
  // members across the space — page_view_roster (one row per page/member/day) COUNT(DISTINCT member_sub),
  // so a member who read N pages counts ONCE. Guest/anon have NO cross-page session id (ADR-175 §4: no
  // minted ids), so their "unique" stays the per-page deduped-session sum — a session/day approximation the
  // UI must label as such (slice 4). The roster is personal data, read on the SAME manage-filter-set.
  // #520 / ADR-189 slice 5: the roll-up itself (manage-filter-set + shaping + unique) now lives in the
  // SHARED `rollupPageViews` helper so this space surface and the tenant surface /admin/analytics) cannot
  // drift on the privacy-critical part. This route keeps what is scope-specific: the existence floor
  // (space `view` → 404), the EE gate, and the candidate page set (this space, RLS-scoped).
  app.get<{ Params: { spaceId: string }; Querystring: RollupQuery }>('/spaces/:spaceId/analytics', async (req, reply) => {
    const subject = `user:${req.user.sub}`
    const unique = isUniqueMode(req.query)
    if (!(await check(app.fga, subject, 'view', { type: 'space', id: req.params.spaceId }))) return reply.code(404).send({ error: 'not found' }) // existence-hiding floor
    if (!resolveEntitlements(req.tenant.plan).analytics) return { entitled: false, pages: 0, daily: [], unique } // EE gate (paid feature)
    const invalid = validateRollupQuery(req.query) // 400 before any FGA/DB work
    if (invalid) return reply.code(400).send({ error: invalid })
    // Candidates are this space's pages; the ancestry map spans the whole (RLS-scoped) tenant because a
    // private ANCESTOR that makes a candidate private need not itself be a candidate.
    const rows = await req.db.sql<{ id: string; parent_id: string | null; space_id: string }[]>`SELECT id, parent_id, space_id FROM pages`
    const parentOf = new Map(rows.map((r) => [r.id, r.parent_id] as const))
    const candidates = rows.filter((r) => r.space_id === req.params.spaceId).map((r) => r.id)
    // #520ONE check decides whether the per-page fan-out is needed at all. A space manager manages
    // every non-private page in the space by the model, so only private ones still get a per-page check.
    const scopeManager = await check(app.fga, subject, 'manage', { type: 'space', id: req.params.spaceId })
    return rollupPageViews(req.db, app.fga, subject, candidates, req.query, scopeManager, { parentOf, managedSpaceIds: [req.params.spaceId] })
  })

  // ── per-space access (Phase 5b) — all manage-gated ──
  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/access', async (req) => {
    return listSpaceAccess(app.fga, req.db, { spaceId: req.params.spaceId, tenantId: req.tenant.id, userId: req.user.sub })
  })

  // grantee = user:<sub> | group:<id>#member (raw), OR groupName (#163: server resolves it to
  // group:<id>#member via groupGrantee → groupFgaId, so the id always matches #111's sync).
  app.post<{ Params: { spaceId: string }; Body: { grantee?: string; groupName?: string; relation?: string; relations?: string[] } }>('/spaces/:spaceId/access', async (req, reply) => {
    const grantee = req.body?.groupName ? groupGrantee(req.tenant.id, req.body.groupName) : (req.body?.grantee ?? '')
    // #553 / ADR-199 §2: `relations` (plural) is the composite form — the editor NOUN grants edit +
    // comment as N single-capability rows in one tx. The singular `relation` keeps meaning exactly
    // what it says.
    if (Array.isArray(req.body?.relations) && req.body.relations.length > 0) {
      await grantSpaceAccessComposite(req.db, app.fga, app.searchDriver, {
        spaceId: req.params.spaceId, tenantId: req.tenant.id, userId: req.user.sub,
        grantee, capabilities: req.body.relations, plan: req.tenant.plan,
      })
      return reply.code(204).send()
    }
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

  // Comment audience setting (#100 / ADR-029): read + toggle who may comment on this space's pages
  // guests (any view link) and/or public members. manage-gated (it's an administrative setting).
  // #277 / ADR-116: space-level anonymous public toggle. GET = current state (manage-gated).
  // POST makes the space public — ONLY while the tenant parent switch is ON (OFF ⇒ 403, mirroring
  // the page toggle: the hidden UI is convenience, the API is the fortress). DELETE (make
  // non-public) is always allowed — revoking is safe.
  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/public-access', async (req) => ({
    public: await isSpacePublic(app.fga, { spaceId: req.params.spaceId, userId: req.user.sub }),
  }))
  app.post<{ Params: { spaceId: string } }>('/spaces/:spaceId/public-access', async (req, reply) => {
    if (!(await spacePublicSurfaceEnabled(req.db))) throw Object.assign(new Error('public surface disabled for this tenant'), { statusCode: 403 })
    await setSpacePublic(req.db, app.fga, app.searchDriver, {
      spaceId: req.params.spaceId, tenantId: req.tenant.id, userId: req.user.sub, plan: req.tenant.plan,
    })
    return reply.code(204).send()
  })
  app.delete<{ Params: { spaceId: string } }>('/spaces/:spaceId/public-access', async (req, reply) => {
    await unsetSpacePublic(req.db, app.fga, app.searchDriver, {
      spaceId: req.params.spaceId, tenantId: req.tenant.id, userId: req.user.sub, plan: req.tenant.plan,
    })
    return reply.code(204).send()
  })

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

  // #308 / ADR-132: content import — materialize an export ZIP as DRAFT pages under this space. MEMBER-ONLY
  // the route carries no `config.guest`, so a share_link (anonymous edit-guest, #274) is rejected before any
  // work — closing the anonymous-ZIP storage-abuse surface (§4). The executor is further gated to space `edit`
  // inside createPage (a viewer is 403'd). base64 ZIP in (no multipart dep; bodyLimit + streaming size caps
  // bound memory). Returns the import report. `publish` opt-in bulk-publishes (else all pages land as drafts).
  app.post<{ Params: { spaceId: string }; Body: { zipBase64?: string; parentPageId?: string | null; publish?: boolean } }>(
    '/spaces/:spaceId/import', { bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
      const archive = Buffer.from(req.body?.zipBase64 ?? '', 'base64')
      if (archive.length === 0) return reply.code(400).send({ error: 'empty archive' })
      try {
        return await importArchive(
          { db: req.db, fga: app.fga, storage: app.storageDriver, driver: app.searchDriver },
          new Uint8Array(archive),
          {
            tenantId: req.tenant.id, spaceId: req.params.spaceId, userId: req.user.sub, plan: req.tenant.plan,
            parentPageId: req.body?.parentPageId ?? null, publish: req.body?.publish === true,
          },
        )
      } catch (e) {
        if ((e as { statusCode?: number })?.statusCode === 403) return reply.code(403).send({ error: 'forbidden' })
        if (e instanceof ImportTooLargeError) return reply.code(413).send({ error: 'archive too large' })
        if (e instanceof ImportInvalidError) return reply.code(400).send({ error: 'invalid archive' })
        throw e
      }
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
