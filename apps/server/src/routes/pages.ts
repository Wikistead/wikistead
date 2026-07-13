import * as Y from 'yjs'
import type { Sql } from 'postgres'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, checkMemberAccess, filterAuthorized, writeTuples, deleteTuples, deleteObjectTuples } from '@wikistead/authz'
import { emit } from '@wikistead/events'
import { docName } from '@wikistead/types'
import { enqueueOutbox, processOutboxAsync } from '../search/index.js'
import type { SearchDriver } from '../search/index.js'
import type { StorageDriver } from '../storage/index.js'
import { storeRevisionYdoc } from './revision-ydoc.js'
import type { TenantDb } from '../db/index.js'
import { flushDraft } from '../collab-flush.js'
import { countTodoTasks } from '../task-progress.js' // #290: :::todo aggregate for the sidebar ring
import { groupGrantee, groupNameByFgaId, resolveGroupName } from '../auth/group-sync.js'
import { auditIfEntitled } from '../audit/outbox.js'
import { resolveEmbed, EmbedDeniedError } from '../embed-resolve.js'
import { resolveTranscludeRef } from '../transclude-resolve.js'
import { renderPlantuml } from '../plantuml-render.js'
import { assertPageViewable } from '../page-view-gate.js'
import { revokeResourceShareLinks } from './share-links.js'
import { getTemplate } from './templates.js'
import { getSpaceInfo } from './spaces.js'
import { deletePinsForResources } from './pins.js'
import { enqueueWebhookOutbox } from './webhooks.js'

// #108 bounce: normalise an admin-supplied external-embed allowlist into bare, lowercase hostnames
// the exact form isAllowlistedEmbed matches. Strip a scheme, path/query/fragment, port, whitespace and
// leading dots; require a dotted hostname; drop empties, non-hostnames and duplicates. (https is
// implied — the client only ever iframes https hosts.) Pure + exported for unit tests.
export function normalizeEmbedProviders(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    let h = item.trim().toLowerCase()
    h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // strip scheme
    h = h.replace(/[/?#].*$/, '')                 // strip path/query/fragment
    h = h.replace(/:\d+$/, '')                     // strip a port
    h = h.replace(/^\.+/, '').replace(/\.+$/, '')   // strip leading/trailing dots
    if (!/^[a-z0-9.-]+$/.test(h) || !h.includes('.')) continue // must be a bare dotted hostname
    if (!seen.has(h)) { seen.add(h); out.push(h) }
  }
  return out
}

// #108 bounce: write the tenant's external-embed host allowlist. tenant#admin ONLY (same authority as
// branding / API policy — a non-admin gets 403). Entries are normalised to bare hostnames. Scoped to
// the given tenant (ON CONFLICT tenant_id) so it can't touch another tenant's row. Returns the stored
// (normalised) list. Extracted as a service fn so the admin gate + isolation are unit-testable.
export async function setEmbedProviders(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; userId: string; providers: unknown },
): Promise<string[]> {
  // Raw FGA check (like branding's requireTenantAdmin) — `admin` on `tenant:` isn't a capability the
  // `check` helper maps; the tenant-admin relation is checked directly.
  const { allowed } = await fga.check({ user: `user:${args.userId}`, relation: 'admin', object: `tenant:${args.tenantId}` })
  if (!allowed) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  const providers = normalizeEmbedProviders(args.providers)
  await db.sql`
    INSERT INTO tenant_settings (tenant_id, embed_providers, updated_at)
    VALUES (${args.tenantId}, ${db.sql.array(providers)}, now())
    ON CONFLICT (tenant_id) DO UPDATE SET embed_providers = ${db.sql.array(providers)}, updated_at = now()
  `
  emit({ type: 'tenant.embed_providers_updated', tenantId: args.tenantId, actorId: args.userId, count: providers.length })
  return providers
}

interface PageRow { id: string; tenant_id: string; space_id: string; parent_id: string | null; title: string; position: number; created_at: Date; updated_at: Date; has_unpublished_changes?: boolean; published?: boolean; created_by?: string | null; updated_by?: string | null; task_done?: number; task_total?: number }
export interface Page { id: string; tenantId: string; spaceId: string; parentId: string | null; title: string; position: number; createdAt: Date; updatedAt: Date; capability?: 'view' | 'edit'; hasUnpublishedChanges?: boolean; published?: boolean; canManage?: boolean; canComment?: boolean; private?: boolean; createdBy?: string | null; updatedBy?: string | null; taskDone?: number; taskTotal?: number }
function toPage(r: PageRow): Page {
  // hasUnpublishedChanges + published are only present when the SELECT included the
  // columns (listPages); together they drive the sidebar's 3-state badge
  // (Draft / Published / Unpublished changes). `published` is a cheap check
  // (published_at IS NOT NULL) — the heavy published_md is not read for the tree.
  // #222: createdBy/updatedBy (author subs) are present only when the SELECT included them (getPage)
  // they feed the title-bar metadata row; undefined for the tree list (not needed there).
  return { id: r.id, tenantId: r.tenant_id, spaceId: r.space_id, parentId: r.parent_id, title: r.title, position: r.position, createdAt: r.created_at, updatedAt: r.updated_at, hasUnpublishedChanges: r.has_unpublished_changes ?? false, published: r.published ?? false, createdBy: r.created_by ?? null, updatedBy: r.updated_by ?? null, taskDone: r.task_done ?? 0, taskTotal: r.task_total ?? 0 }
}

// Fractional sibling ordering: a new value between two neighbours, no renumber.
// front = min-1, end = max+1, between = midpoint, empty = 0.
//
// v1 uses a float midpoint (chosen over a LexoRank-style string rank to avoid the
// string min-boundary edge; both satisfy the no-renumber / single-row-UPDATE
// concurrency property). KNOWN LIMITATION: ~53 consecutive inserts into the SAME
// gap make two positions compare equal (float precision exhaustion) and the order
// becomes ambiguous.
// Fractional positions can exhaust float precision after ~53 consecutive inserts into the
// SAME gap (two siblings compare equal → ambiguous order). #118: detect that collapse and
// re-spread the affected sibling group with evenly-spaced integer positions. Stays fractional
// (no LexoRank string migration); the spread restores ample bisection room.
function positionBetween(before: number | null, after: number | null): number {
  if (before == null && after == null) return 0
  if (before == null) return (after as number) - 1
  if (after == null) return before + 1
  return (before + after) / 2
}

// A gap is COLLAPSED when the midpoint between two neighbours is not STRICTLY between them
// i.e. inserting there would produce a position equal to a neighbour (float exhaustion or
// duplicate/equal positions). Only meaningful with two finite neighbours.
export function gapCollapsed(before: number | null, after: number | null): boolean {
  if (before == null || after == null) return false
  const mid = (before + after) / 2
  return !(before < mid && mid < after)
}

export const POSITION_STEP = 1024 // wide, power-of-two spacing → lots of future bisection room

// Evenly-spaced positions for `n` siblings: STEP, 2·STEP, … (1-based so nothing sits at 0).
export function spreadPositions(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i + 1) * POSITION_STEP)
}

// Re-spread a sibling group to evenly-spaced positions, preserving the current visible order
// (position, then created_at — the same tie-break listPages uses, so a collapsed/duplicate gap
// resolves deterministically). Excludes `excludeId` (the page being moved). A multi-row UPDATE,
// but only invoked on the rare collapse. Returns the fresh (id, position) list in order.
export async function rebalanceSiblings(
  sql: Sql,
  spaceId: string,
  parentId: string | null,
  excludeId: string,
): Promise<{ id: string; position: number }[]> {
  const sibs = await sql<{ id: string }[]>`
    SELECT id FROM pages
    WHERE space_id = ${spaceId} AND parent_id IS NOT DISTINCT FROM ${parentId} AND id <> ${excludeId}
    ORDER BY position, created_at
  `
  const spread = spreadPositions(sibs.length)
  const out: { id: string; position: number }[] = []
  for (let i = 0; i < sibs.length; i++) {
    await sql`UPDATE pages SET position = ${spread[i]!}, updated_at = now() WHERE id = ${sibs[i]!.id}`
    out.push({ id: sibs[i]!.id, position: spread[i]! })
  }
  return out
}

// Decode the markdown body from a persisted Y.Doc binary (the canonical 'content'
// Y.Text). null/never-edited → ''. Used by publish (draft → published snapshot) and
// the published-read endpoint's draft-vs-published comparison.
function decodeYdocContent(buf: Buffer | null): string {
  if (!buf) return ''
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(buf))
  return doc.getText('content').toString()
}

// ── GFM task-checkbox helpers (ADR-019) ─────────────────────────────────────
//
// A task checkbox is a GFM task-list marker: a list item whose first token is
// `[ ]` / `[x]` / `[X]`. These helpers let the no-revision toggle endpoint prove a
// draft differs from the published snapshot by EXACTLY one checkbox flip and nothing
// else — the structural guard that stops the path being used to publish real content.
const TASK_MARKER = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\](?=[ \t])/gm

// The "skeleton": the markdown with every checkbox state normalized to unchecked.
// Two documents with equal skeletons differ ONLY in checkbox states (their prose and
// their set/positions of task items are identical).
function taskSkeleton(md: string): string {
  return md.replace(TASK_MARKER, (_m, lead: string) => `${lead}[ ]`)
}

// The ordered list of checkbox states (true = checked). Aligned 1:1 across two docs
// iff their skeletons are equal.
function taskStates(md: string): boolean[] {
  const states: boolean[] = []
  for (const m of md.matchAll(TASK_MARKER)) states.push(m[2] !== ' ')
  return states
}

// #316 / ADR-123: the ordered task LABELS (the text after each checkbox). Two docs share the same task
// COMPOSITION iff these sequences are equal — same tasks, same order — regardless of the prose around them
// or their checked states. `taskSkeleton` above is the WHOLE-doc guard for the one-flip toggle (same prose);
// this is the task-STRUCTURE-only skeleton the restore reconciliation needs, because a restore legitimately
// changes the surrounding prose.
const TASK_LINE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[[ xX]\][ \t](.*)$/gm
function taskLabels(md: string): string[] {
  const out: string[] = []
  for (const m of md.matchAll(TASK_LINE)) out.push(m[2].trimEnd())
  return out
}

// #316 / ADR-123: reconcile a restore target's checkbox states with the CURRENT ones. When the task
// composition is unchanged (same labels in the same order), overlay the CURRENT checked/unchecked states
// onto the target's prose — restoring the BODY must not silently revert live task progress (case a). When a
// task was added / removed / reordered, the target's own snapshot states stand (fallback — an ordinal
// overlay would mis-map). Checkbox state stays INLINE in the markdown (the ADR-123 invariant), so export /
// search / render / the #290 ring stay correct by construction. Pure — unit-tested.
export function reconcileTaskChecks(currentMd: string, targetMd: string): string {
  const cur = taskLabels(currentMd)
  const tgt = taskLabels(targetMd)
  if (cur.length !== tgt.length || !cur.every((l, i) => l === tgt[i])) return targetMd // composition differs → fallback
  const states = taskStates(currentMd)
  let i = 0
  return targetMd.replace(TASK_MARKER, (_m, lead: string) => `${lead}[${states[i++] ? 'x' : ' '}]`)
}

// ── Service functions ─────────────────────────────────────────────────────

// Create a page. Outbox entry is written in the same DB transaction as the
// INSERT + FGA write. Meili indexing fires asynchronously after tx commits
// (non-blocking: API success is independent of Meili availability).
export async function createPage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { tenantId: string; spaceId: string; userId: string; title?: string; parentId?: string | null; fromPageId?: string | null; templateId?: string | null },
): Promise<Page> {
  // Destination gate FIRST: creating a page here needs `edit` on the space. This runs BEFORE any
  // template resolution, so a template-seeded create can never bypass the destination's authz (a
  // non-editor gets 403 regardless of any templateId/fromPageId they pass).
  const canEdit = await check(fga, `user:${args.userId}`, 'edit', { type: 'space', id: args.spaceId })
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  // Seed the new page's DRAFT content. Two sources, both view-gated and existence-hidden (404)
  // #250 templateId — a `templates` snapshot (view = manage or space/tenant audience); title defaults
  // to the template name. This is the real template system.
  // #229 fromPageId — "duplicate a page": any page the creator can VIEW; its PUBLISHED md is the body.
  // Either way the new page stays an unpublished, creator-only draft holding the seeded body.
  let seedMd: string | null = null
  let seedTitle = args.title
  if (args.templateId) {
    const tpl = await getTemplate(db, fga, { userId: args.userId, id: args.templateId })
    if (!tpl) throw Object.assign(new Error('template not found'), { statusCode: 404 }) // hide existence
    seedMd = tpl.body
    if (seedTitle == null || seedTitle === '') seedTitle = tpl.name
  } else if (args.fromPageId) {
    const canViewSrc = await check(fga, `user:${args.userId}`, 'view', { type: 'page', id: args.fromPageId })
    if (!canViewSrc) throw Object.assign(new Error('template not found'), { statusCode: 404 }) // hide existence
    const [src] = await db.sql<{ published_md: string | null }[]>`SELECT published_md FROM pages WHERE id = ${args.fromPageId}`
    seedMd = src?.published_md ?? null
  }

  const parentId = args.parentId ?? null
  if (parentId) {
    // Nesting is structural only and stays within one space; the parent must be
    // a page in the SAME space (the composite FK already blocks cross-tenant).
    const [p] = await db.sql<{ space_id: string }[]>`SELECT space_id FROM pages WHERE id = ${parentId}`
    if (!p || p.space_id !== args.spaceId) throw Object.assign(new Error('parent not in space'), { statusCode: 400 })
    // #218 / ADR-103 (comment 996 decision 3): cap nesting depth so the inherited-authz parent chain stays
    // resolvable under OpenFGA's resolution-depth limit. The new leaf's depth = parent depth + 1.
    if ((await ancestorDepth(db, parentId)) + 1 > MAX_PAGE_DEPTH) {
      throw Object.assign(new Error(`max nesting depth (${MAX_PAGE_DEPTH}) exceeded`), { statusCode: 400 })
    }
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
      INSERT INTO pages (tenant_id, space_id, parent_id, title, position, created_by)
      VALUES (${args.tenantId}, ${args.spaceId}, ${parentId}, ${seedTitle ?? ''}, ${position}, ${args.userId})
      RETURNING id, tenant_id, space_id, parent_id, title, position, created_at, updated_at
    `
    // Visibility gate (Phase 4): a new page is a DRAFT — do NOT link it to its
    // space (no `page#space`), so space members do NOT inherit access. Grant the
    // CREATOR direct `manage` instead. publishPage writes `page#space` to release
    // space inheritance. Until then the draft is visible only to the creator + any
    // explicitly-granted users (page direct grants).
    await writeTuples(fga, [
      { user: `user:${args.userId}`, relation: 'manage', object: `page:${r.id}` },
      // #218 / ADR-103 prep: structural page#parent tuple (inert until the model change wires it — see
      // syncPageParentTuple). A new page is a leaf, so it can never introduce a parent cycle.
      ...(parentId ? [{ user: `page:${parentId}`, relation: 'parent', object: `page:${r.id}` }] : []),
    ])
    // #229: seed the draft ydoc with the template body so the editor opens pre-filled (collab loads
    // pages.ydoc on connect; the canonical Y.Text is 'content'). Stays unpublished until the user publishes.
    if (seedMd) {
      const doc = new Y.Doc()
      doc.getText('content').insert(0, seedMd)
      await tx`UPDATE pages SET ydoc = ${Buffer.from(Y.encodeStateAsUpdate(doc))} WHERE id = ${r.id}`
    }
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
// Lists the pages in a space the SUBJECT may view. The subject is the FGA principal
// ("user:<sub>" for a member, "share_link:<id>" for a space-link guest); `context` carries
// current_time for a time-bounded guest link. A space-link guest only sees PUBLISHED pages
// (a draft has no page#space, so view doesn't inherit from the space) and never another
// space's pages (the space_id filter) — leak-safe by construction.
export async function listPages(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { spaceId: string; subject: string; context?: { current_time: string } },
): Promise<Page[]> {
  const rows = await db.sql<PageRow[]>`
    SELECT id, tenant_id, space_id, parent_id, title, position, created_at, updated_at,
           has_unpublished_changes, (published_at IS NOT NULL) AS published, task_done, task_total
    FROM pages WHERE space_id = ${args.spaceId} ORDER BY position, created_at
  `
  const allowed = await filterAuthorized(fga, args.subject, 'view', rows.map((r) => r.id), args.context)
  const visible = rows.filter((r) => allowed.has(r.id))
  // #109 Fix B: annotate each visible page with its private flag so the sidebar can render a lock.
  // Bounded to the space's visible pages; a read fault falls back to "not private" (no false lock).
  const privateFlags = await Promise.all(
    visible.map((r) => readPagePrivate(fga, r.id).catch(() => false)),
  )
  return visible.map((r, i) => ({ ...toPage(r), private: privateFlags[i] }))
}

export async function getPage(db: TenantDb, fga: OpenFgaClient, args: { pageId: string; userId: string }): Promise<Page> {
  // Resolve view AND edit in one batch: the web uses `capability` to decide whether
  // to offer the Edit control. This is convenience only — the collab server is the
  // fortress (it re-derives readOnly from FGA per document, so a forged edit button
  // still cannot write). null = no view access at all → 403.
  const access = await checkMemberAccess(fga, args.userId, { type: 'page', id: args.pageId })
  // #262: existence-hiding on the READ/DISPLAY path — "no view access" and "no such page" return the SAME
  // 404 so a member can't tell a page they lack access to from one that doesn't exist ( leaks
  // existence). Uniform 404, like the public surface (#227) and share-links. Edit/manage ops keep their 403s
  // (an action failure is a different signal from a hidden resource).
  if (!access) throw Object.assign(new Error('not found'), { statusCode: 404 })
  const [row] = await db.sql<PageRow[]>`
    SELECT id, tenant_id, space_id, parent_id, title, position, created_at, updated_at, has_unpublished_changes,
           created_by, updated_by, (published_at IS NOT NULL) AS published
    FROM pages WHERE id = ${args.pageId}
  `
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
  // canManage gates the permission UI (server re-checks on the access endpoints).
  const canManage = await check(fga, `user:${args.userId}`, 'manage', { type: 'page', id: args.pageId })
  // canComment gates the comment COMPOSER (#100): true for edit, an explicit comment grant, OR a
  // viewer when the space's comment_open is on (view_base and comment_open). view/edit is capability;
  // comment is a distinct capability the UI needs to show the composer to comment-capable viewers.
  // Convenience only — the comment routes re-check FGA (the fortress), so a forged composer can't post.
  const canComment = await check(fga, `user:${args.userId}`, 'comment', { type: 'page', id: args.pageId })
  // #109 Fix B: private flag drives the lock badge next to the title (visible to any viewer of the page).
  const isPrivate = await readPagePrivate(fga, args.pageId)
  return { ...toPage(row), capability: access.readOnly ? 'view' : 'edit', canManage, canComment, private: isPrivate }
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

// Publish: promote the current draft (pages.ydoc) to the published version. The
// published snapshot is what viewers / search / export / public render read, so a
// draft's in-progress content never leaks until published. edit-gated (a guest with
// an edit share-link qualifies — guest-token auth on this route is wired in 2f-3).
//
// A revision records the published snapshot (this is the history entry — the old
// 5-min auto-snapshot was removed; history is now the publish history). ADR-003
// order: the DB tx commits (revision + published_* + outbox) before the async
// reindex + emit, so a tx failure leaves NO half-published state.
export async function publishPage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  storage: StorageDriver,
  // subject = FGA principal for the edit check ("user:<sub>" | "share_link:<id>");
  // createdBy attributes the revision/event ("user:<sub>" | "guest:<id>"); context
  // (guests) evaluates the share_link's non_expired condition.
  args: { pageId: string; subject: string; createdBy: string; context?: { current_time: string } },
): Promise<{ publishedAt: Date | null; revisionId: string | null; noop: boolean }> {
  const canEdit = await check(fga, args.subject, 'edit', { type: 'page', id: args.pageId }, args.context)
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  const [draft] = await db.sql<[{ tenant_id: string; space_id: string; ydoc: Buffer | null; title: string; published_md: string | null; published_at: Date | null; published_revision_id: string | null }]>`
    SELECT tenant_id, space_id, ydoc, title, published_md, published_at, published_revision_id FROM pages WHERE id = ${args.pageId}
  `
  if (!draft) throw Object.assign(new Error('not found'), { statusCode: 404 })
  const md = decodeYdocContent(draft.ydoc)

  // No-op guard (server is the accurate gate): if the draft text equals what is
  // already published, do NOT create a revision — that would be meaningless history.
  // The UI's enable/disable uses the cheap over-approximated flag; this is the exact
  // check. Reconcile the cheap flag to false so a spurious "unpublished" badge clears.
  // Still RELEASE space inheritance (idempotent) — covers a re-publish and the
  // repair case where a prior publish's page#space write failed; reindex if it wrote.
  if (md === draft.published_md) {
    await db.sql`UPDATE pages SET has_unpublished_changes = false WHERE id = ${args.pageId}`
    const wrote = await ensurePageSpaceLink(fga, args.pageId, draft.space_id)
    if (wrote) {
      const oid = await db.tx(async (tx) => enqueueOutbox(tx, { tenantId: draft.tenant_id, pageId: args.pageId, operation: 'upsert' }))
      processOutboxAsync(driver, oid, { tenantId: draft.tenant_id, pageId: args.pageId, operation: 'upsert' })
    }
    return { publishedAt: draft.published_at, revisionId: draft.published_revision_id, noop: true }
  }

  // A never-edited page publishes an empty Y.Doc snapshot.
  const ydocBuf = draft.ydoc ?? Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()))
  // Offload the revision bytes to storage S3-FIRST (ADR-062 #113): put succeeds → write the
  // key; a put failure throws here BEFORE the tx, so no row with a dangling pointer is created.
  const ydocKey = await storeRevisionYdoc(storage, draft.tenant_id, ydocBuf)

  let outboxId!: string
  let revisionId!: string
  let publishedAt!: Date
  await db.tx(async (tx) => {
    const [rev] = await tx<[{ id: string }]>`
      INSERT INTO revisions (tenant_id, page_id, ydoc_key, title, created_by)
      VALUES (${draft.tenant_id}, ${args.pageId}, ${ydocKey}, ${draft.title}, ${args.createdBy})
      RETURNING id
    `
    revisionId = rev.id
    const tp = countTodoTasks(md) // #290 / ADR-114: refresh the :::todo aggregate for the sidebar ring
    const [p] = await tx<[{ published_at: Date }]>`
      UPDATE pages SET published_md = ${md}, published_revision_id = ${rev.id}, published_at = now(),
        has_unpublished_changes = false, updated_by = ${args.subject.replace(/^user:/, '')},
        task_done = ${tp.done}, task_total = ${tp.total}
      WHERE id = ${args.pageId}
      RETURNING published_at
    `
    publishedAt = p.published_at
    outboxId = await enqueueOutbox(tx, { tenantId: draft.tenant_id, pageId: args.pageId, operation: 'upsert' })
    // #228 / ADR-108: enqueue the page.published webhook IN this tx (reliable — a commit-then-crash still
    // delivers). Thin payload (ids/actor only). The drain applies the private/draft existence-hiding
    // filter at send time (by then page#space is written below, so a published page is deliverable).
    await enqueueWebhookOutbox(tx, { tenantId: draft.tenant_id, eventType: 'page.published', payload: { pageId: args.pageId, revisionId, actorId: args.createdBy, occurredAt: new Date().toISOString() } })
  })
  // AFTER the DB commit (fail-closed: a tx failure above leaves the page gated)
  // release space inheritance, THEN reindex so buildSearchDoc sees the published
  // state. If this FGA write fails, the page stays gated and a retry publish (no-op
  // path) repairs it; the two-stage search guard keeps stage-2 FGA authoritative.
  await ensurePageSpaceLink(fga, args.pageId, draft.space_id)
  processOutboxAsync(driver, outboxId, { tenantId: draft.tenant_id, pageId: args.pageId, operation: 'upsert' })
  emit({ type: 'page.published', tenantId: draft.tenant_id, pageId: args.pageId, revisionId, actorId: args.createdBy })
  return { publishedAt, revisionId, noop: false }
}

// Toggle a single GFM task checkbox on the PUBLISHED page without creating a revision
// (ADR-019). A checkbox tick is a state update, not content history — snapshotting it
// would flood the revision log and make history/diff useless.
//
// Flow: the edit-capable client has already flipped the checkbox in the live draft
// (a normal offset-invariant Y.Text edit over its existing collab connection — the
// server never operates Yjs directly). The route flushes that draft to pages.ydoc,
// then this folds the flip into published_md.
//
// Security (D3/D4): server is the bastion — requires FGA `edit`. The "checkbox-only
// diff" guard makes it structurally impossible to publish real content through this
// no-revision path: if the draft differs from the published snapshot by anything other
// than the single expected checkbox flip, it is rejected (409) and the change must go
// through publish (which DOES snapshot).
export async function toggleTask(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; subject: string; createdBy: string; index: number; context?: { current_time: string } },
): Promise<{ publishedAt: Date | null }> {
  const canEdit = await check(fga, args.subject, 'edit', { type: 'page', id: args.pageId }, args.context)
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  const [page] = await db.sql<[{ tenant_id: string; ydoc: Buffer | null; published_md: string | null; published_at: Date | null }]>`
    SELECT tenant_id, ydoc, published_md, published_at FROM pages WHERE id = ${args.pageId}
  `
  if (!page) throw Object.assign(new Error('not found'), { statusCode: 404 })
  if (page.published_md == null) throw Object.assign(new Error('not published'), { statusCode: 409 })

  const draftMd = decodeYdocContent(page.ydoc)
  const publishedMd = page.published_md

  // Structural guard: the ONLY difference may be a single checkbox flip at `index`.
  // Equal skeletons ⇒ identical prose AND identically-positioned task items; then the
  // state arrays align 1:1 and exactly one must differ, at the claimed index.
  if (taskSkeleton(draftMd) !== taskSkeleton(publishedMd)) {
    throw Object.assign(new Error('draft has non-checkbox changes; publish them first'), { statusCode: 409 })
  }
  const draftStates = taskStates(draftMd)
  const pubStates = taskStates(publishedMd)
  const diff = draftStates.reduce<number[]>((acc, s, i) => (s !== pubStates[i] ? [...acc, i] : acc), [])
  if (diff.length !== 1 || diff[0] !== args.index) {
    throw Object.assign(new Error('expected exactly one checkbox flip at the given index'), { statusCode: 409 })
  }

  // Fold the flip into the published snapshot. NO revision insert (the whole point);
  // draft == published again ⇒ not dirty. Reindex like publish (published text changed).
  let outboxId!: string
  let publishedAt!: Date
  await db.tx(async (tx) => {
    const tp = countTodoTasks(draftMd) // #290: a checkbox tick changes the :::todo aggregate too — keep it fresh
    const [p] = await tx<[{ published_at: Date }]>`
      UPDATE pages SET published_md = ${draftMd}, has_unpublished_changes = false,
        task_done = ${tp.done}, task_total = ${tp.total}
      WHERE id = ${args.pageId}
      RETURNING published_at
    `
    publishedAt = p.published_at
    outboxId = await enqueueOutbox(tx, { tenantId: page.tenant_id, pageId: args.pageId, operation: 'upsert' })
    // Lightweight audit (ADR-019 D2 / #97): who toggled which checkbox to what, when. NOT in
    // the revision/diff history (a toggle is interactive state). In the same tx as the flip,
    // so the log can never disagree with the published state. `actor` uses the human-readable
    // principal (`user:`/`guest:` = createdBy), matching the attribution label revisions store
    // NOT the FGA `subject` (`share_link:`), which is the authz check identity only.
    await tx`
      INSERT INTO checkbox_events (tenant_id, page_id, actor, checkbox_index, checked)
      VALUES (${page.tenant_id}, ${args.pageId}, ${args.createdBy}, ${args.index}, ${draftStates[args.index]!})
    `
  })
  processOutboxAsync(driver, outboxId, { tenantId: page.tenant_id, pageId: args.pageId, operation: 'upsert' })
  return { publishedAt }
}

// Release space inheritance for a page: write `page#space` if absent (idempotent
// OpenFGA rejects duplicate writes, so we check first). Returns whether it wrote.
async function ensurePageSpaceLink(fga: OpenFgaClient, pageId: string, spaceId: string): Promise<boolean> {
  const { tuples } = await fga.read({ object: `page:${pageId}` })
  const linked = (tuples ?? []).some((t) => t.key?.relation === 'space' && t.key?.user === `space:${spaceId}`)
  if (linked) return false
  await writeTuples(fga, [{ user: `space:${spaceId}`, relation: 'space', object: `page:${pageId}` }])
  return true
}

// Read the published content (view-gated). hasUnpublishedChanges = the live shared
// draft differs from the published snapshot — a PAGE-level state (the draft is one
// shared collaborative doc, not per-user), shown to all editors.
export async function getPublished(
  db: TenantDb,
  fga: OpenFgaClient,
  // subject is the FGA principal ("user:<sub>" | "share_link:<id>"); guests pass a
  // context so the share_link's non_expired condition is evaluated (expired = denied).
  args: { pageId: string; subject: string; context?: { current_time: string } },
): Promise<{ title: string; publishedMd: string | null; publishedAt: Date | null; hasUnpublishedChanges: boolean; canComment: boolean }> {
  const canView = await check(fga, args.subject, 'view', { type: 'page', id: args.pageId }, args.context)
  // #262: existence-hiding — view-denied returns the SAME 404 as a missing page (a "published" read is a
  // display path). Uniform 404 with getPage + the public surface.
  if (!canView) throw Object.assign(new Error('not found'), { statusCode: 404 })
  // #318: title rides along so a view-capable GUEST (whose only page read is this route) can render the
  // title band. Minimal-field policy (the #270 space-info precedent): nothing beyond what the surface
  // shows — no space/creator/member data is added here.
  const [row] = await db.sql<[{ title: string; published_md: string | null; published_at: Date | null; ydoc: Buffer | null }]>`
    SELECT title, published_md, published_at, ydoc FROM pages WHERE id = ${args.pageId}
  `
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
  const hasUnpublishedChanges = decodeYdocContent(row.ydoc) !== (row.published_md ?? '')
  // canComment (#100): does THIS principal (member or view-guest) have the comment capability on the
  // page (comment_open on + view, an explicit comment grant, or edit)? The guest page uses it to show
  // the comment composer. Convenience only — the comment routes re-check FGA (fortress).
  const canComment = await check(fga, args.subject, 'comment', { type: 'page', id: args.pageId }, args.context)
  return { title: row.title, publishedMd: row.published_md, publishedAt: row.published_at, hasUnpublishedChanges, canComment }
}

// ── per-page access grant/revoke/list (Phase 4b) ────────────────────────────
// The generic "grant X access to page Y" mechanism — the shared base for the
// permission UI AND draft invitations (a draft is created with only a creator
// grant; inviting someone = granting them view/edit here). Only a `manage` holder
// may grant/revoke/list, so the permission structure is never shown to — or handed
// out by — someone without authority. A grantee is a member (user:<sub>) or a group
// (group:<id>#member); share_link / wildcard subjects are not grantable here.
// User-facing page capabilities. #100/ADR-029 adds `comment` (a per-member comment grant, member
// granularity). NOTE: `view` is a COMPUTED FGA relation now (view_base or comment) — a direct view
// grant is written to `view_base`, so the API capability ('view') maps to the FGA relation below.
export type PageRelation = 'view' | 'comment' | 'edit' | 'manage'
const PAGE_RELATIONS: PageRelation[] = ['view', 'comment', 'edit', 'manage']

// capability → FGA relation to WRITE (view → view_base leaf; the rest are identity).
function fgaRelationForCap(cap: PageRelation): 'view_base' | 'comment' | 'edit' | 'manage' {
  return cap === 'view' ? 'view_base' : cap
}
// FGA relation (as stored/read) → user-facing capability; null for non-grant relations (space/parent/
// comment_open/view). view_base surfaces as 'view'.
function capForFgaRelation(rel: string): PageRelation | null {
  if (rel === 'view_base') return 'view'
  if (rel === 'comment' || rel === 'edit' || rel === 'manage') return rel
  return null
}

function validateGrant(grantee: string, relation: string): asserts relation is PageRelation {
  if (!PAGE_RELATIONS.includes(relation as PageRelation)) {
    throw Object.assign(new Error('relation must be view, comment, edit, or manage'), { statusCode: 400 })
  }
  // Only real principals: a member or a group's member-set. NOT share_link, user:*,
  // page:, space: — those are not hand-grantable per-page access.
  if (!/^user:[^*\s]+$/.test(grantee) && !/^group:[^\s]+#member$/.test(grantee)) {
    throw Object.assign(new Error('grantee must be user:<sub> or group:<id>#member'), { statusCode: 400 })
  }
}

async function requireManage(fga: OpenFgaClient, userId: string, pageId: string): Promise<void> {
  const canManage = await check(fga, `user:${userId}`, 'manage', { type: 'page', id: pageId })
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
}

export async function grantPageAccess(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; tenantId: string; userId: string; grantee: string; relation: string; plan?: string },
): Promise<void> {
  validateGrant(args.grantee, args.relation)
  await requireManage(fga, args.userId, args.pageId)
  // One tx: durable audit (#177) + the reindex outbox; FGA LAST so a grant failure rolls both back.
  const oid = await db.tx(async (tx) => {
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'page.access_granted', target: `page:${args.pageId}` })
    }
    const o = await enqueueOutbox(tx, { tenantId: args.tenantId, pageId: args.pageId, operation: 'upsert' })
    await writeTuples(fga, [{ user: args.grantee, relation: fgaRelationForCap(args.relation as PageRelation), object: `page:${args.pageId}` }])
    return o
  })
  // Reindex so the new grantee appears in the search viewer set (post-commit; FGA now set).
  processOutboxAsync(driver, oid, { tenantId: args.tenantId, pageId: args.pageId, operation: 'upsert' })
  emit({ type: 'page.access_granted', tenantId: args.tenantId, pageId: args.pageId, grantee: args.grantee, relation: args.relation, actorId: args.userId })
}

export async function revokePageAccess(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; tenantId: string; userId: string; grantee: string; relation: string; plan?: string },
): Promise<void> {
  validateGrant(args.grantee, args.relation)
  await requireManage(fga, args.userId, args.pageId)
  // One tx: durable audit (#177) + the reindex outbox; FGA LAST so a revoke failure rolls both back.
  const oid = await db.tx(async (tx) => {
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'page.access_revoked', target: `page:${args.pageId}` })
    }
    const o = await enqueueOutbox(tx, { tenantId: args.tenantId, pageId: args.pageId, operation: 'upsert' })
    await deleteTuples(fga, [{ user: args.grantee, relation: fgaRelationForCap(args.relation as PageRelation), object: `page:${args.pageId}` }])
    return o
  })
  // Reindex so the revoked grantee drops out of the search viewer set immediately
  // (FGA-derived surfaces — tree/comments/attachments/collab — drop on next request).
  processOutboxAsync(driver, oid, { tenantId: args.tenantId, pageId: args.pageId, operation: 'upsert' })
  emit({ type: 'page.access_revoked', tenantId: args.tenantId, pageId: args.pageId, grantee: args.grantee, relation: args.relation, actorId: args.userId })
}

// #109 / ADR-072 monotonic deny: RESTRICT a principal from a page. Writes page#restricted so the
// principal's `view` (= viewable but not restricted) becomes false everywhere — the page 404s for
// them even if they're a space viewer. Manage-gated + audited + reindexed, like grant/revoke. Only a
// real member/group (never share_link / wildcard) is restrictable.
function validateRestrictee(who: string): void {
  if (!/^user:[^*\s]+$/.test(who) && !/^group:[^\s]+#member$/.test(who)) {
    throw Object.assign(new Error('restrictee must be user:<sub> or group:<id>#member'), { statusCode: 400 })
  }
}

export async function restrictPageAccess(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; tenantId: string; userId: string; principal: string; plan?: string },
): Promise<void> {
  validateRestrictee(args.principal)
  await requireManage(fga, args.userId, args.pageId)
  const oid = await db.tx(async (tx) => {
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'page.access_restricted', target: `page:${args.pageId}` })
    }
    const o = await enqueueOutbox(tx, { tenantId: args.tenantId, pageId: args.pageId, operation: 'upsert' })
    await writeTuples(fga, [{ user: args.principal, relation: 'restricted', object: `page:${args.pageId}` }])
    return o
  })
  // Reindex so the restricted principal drops out of FGA-derived surfaces on the next request.
  processOutboxAsync(driver, oid, { tenantId: args.tenantId, pageId: args.pageId, operation: 'upsert' })
  emit({ type: 'page.access_restricted', tenantId: args.tenantId, pageId: args.pageId, grantee: args.principal, relation: 'restricted', actorId: args.userId })
}

export async function unrestrictPageAccess(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; tenantId: string; userId: string; principal: string; plan?: string },
): Promise<void> {
  validateRestrictee(args.principal)
  await requireManage(fga, args.userId, args.pageId)
  const oid = await db.tx(async (tx) => {
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'page.access_unrestricted', target: `page:${args.pageId}` })
    }
    const o = await enqueueOutbox(tx, { tenantId: args.tenantId, pageId: args.pageId, operation: 'upsert' })
    await deleteTuples(fga, [{ user: args.principal, relation: 'restricted', object: `page:${args.pageId}` }])
    return o
  })
  processOutboxAsync(driver, oid, { tenantId: args.tenantId, pageId: args.pageId, operation: 'upsert' })
  emit({ type: 'page.access_unrestricted', tenantId: args.tenantId, pageId: args.pageId, grantee: args.principal, relation: 'restricted', actorId: args.userId })
}

// List the principals RESTRICTED on a page (manage-gated) — the deny list, distinct from grants.
export async function listPageRestrictions(
  fga: OpenFgaClient,
  args: { pageId: string; userId: string },
): Promise<{ principal: string }[]> {
  await requireManage(fga, args.userId, args.pageId)
  const { tuples } = await fga.read({ object: `page:${args.pageId}`, relation: 'restricted' })
  const out: { principal: string }[] = []
  for (const { key } of tuples ?? []) {
    if (key?.relation === 'restricted' && key.user) out.push({ principal: key.user })
  }
  return out
}

// #109 / ADR-098: per-page PRIVATE (allowlist). Writing `private@user:*` cuts the space-inherited
// grant paths (view/edit/manage) — only explicit direct grants (the allow list, managed via grant/
// revoke) remain. Setting private ALSO strips the public grant (view_base@user:*) so a page can't be
// both public and private (the write-boundary invariant → is_public becomes false on reindex). The allow
// list itself is the existing grant/revoke path; this pair only flips the marker. Manage-gated + audited
// (#177) + reindexed, like restrict.
// #244 / ADR-098 addendum: the private marker is a PAIR — `private@user:*` AND `private@share_link:*`.
// OpenFGA's typed wildcard `user:*` matches ONLY user-type principals, so without share_link:* a space
// share-link guest (share_link:Y) slipped past `... but not private` and read private pages via
// `viewer from space`. Both are ALWAYS written/deleted together (a lone user:* over-permits guests; a
// lone share_link:* over-denies members). Reads (readPagePrivate/isPagePrivate/doc-builder) still key on
// user:* — the pair is always in sync, so user:* presence remains the private predicate.
const PRIVATE_MARKERS = (pageId: string) => [
  { user: 'user:*', relation: 'private', object: `page:${pageId}` },
  { user: 'share_link:*', relation: 'private', object: `page:${pageId}` },
]
const PUBLIC_GRANT = (pageId: string) => ({ user: 'user:*', relation: 'view_base', object: `page:${pageId}` })

// Read the private marker WITHOUT a manage gate (#109 Fix B): the lock badge is shown to
// anyone who can already see the page (sidebar + title). Callers who can view a page ARE its
// allowlist when it is private, so exposing the flag to them leaks nothing (non-viewers 404).
// isPagePrivate stays manage-gated for the permission UI's authoritative read.
async function readPagePrivate(fga: OpenFgaClient, pageId: string): Promise<boolean> {
  const { tuples } = await fga.read({ object: `page:${pageId}`, relation: 'private' })
  return (tuples ?? []).some(({ key }) => key?.relation === 'private' && key.user === 'user:*')
}

export async function setPagePrivate(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; tenantId: string; userId: string; plan?: string },
): Promise<void> {
  await requireManage(fga, args.userId, args.pageId)
  const oid = await db.tx(async (tx) => {
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'page.made_private', target: `page:${args.pageId}` })
    }
    const o = await enqueueOutbox(tx, { tenantId: args.tenantId, pageId: args.pageId, operation: 'upsert' })
    await writeTuples(fga, PRIVATE_MARKERS(args.pageId))
    // public⊥private invariant: strip the public grant so is_public can't survive privatisation. Idempotent
    // (ignore "not found" — the page may not be public). This is the write-boundary that closes the leak
    // where a private page still indexes as public.
    await deleteTuples(fga, [PUBLIC_GRANT(args.pageId)]).catch(() => {})
    return o
  })
  // #109 Fix A (comment 768) + comment 785: revoke this page's share links AFTER the private-ization commit
  // above — the marker + public strip + outbox reindex are the security-critical, fail-safe part and must
  // land first (a revoke failure must NOT roll back the private marker or the reindex, else the page stays
  // publicly indexed — a worse leak). revokeResourceShareLinks makes the DB revoke atomic and returns which
  // links were cleared (emit AFTER commit) + which FGA deletes failed (logged, left recoverable).
  const { revoked, failed } = await revokeResourceShareLinks(db, fga, { type: 'page', id: args.pageId }, args.tenantId, args.userId)
  // Reindex so is_public flips to false (view_base@user:* gone) + space members drop from stage-1.
  processOutboxAsync(driver, oid, { tenantId: args.tenantId, pageId: args.pageId, operation: 'upsert' })
  emit({ type: 'page.made_private', tenantId: args.tenantId, pageId: args.pageId, actorId: args.userId })
  // comment 785 #2: emit share_link.revoked ONLY after the DB revoke committed (never on a rolled-back tx).
  for (const link of revoked) emit({ type: 'share_link.revoked', tenantId: args.tenantId, shareLinkId: link.id, pageId: link.pageId, actorId: args.userId })
  // comment 785 #3: a partial FGA-delete failure is not silent — the page IS private (fail-safe), but these
  // links are still live on FGA until a re-privatise/sweep retries them (they stay revoked_at IS NULL).
  if (failed.length) console.error('[setPagePrivate] share-link revoke incomplete (private applied; links pending FGA delete)', { pageId: args.pageId, failed })
}

export async function unsetPagePrivate(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; tenantId: string; userId: string; plan?: string },
): Promise<void> {
  await requireManage(fga, args.userId, args.pageId)
  const oid = await db.tx(async (tx) => {
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'page.made_non_private', target: `page:${args.pageId}` })
    }
    const o = await enqueueOutbox(tx, { tenantId: args.tenantId, pageId: args.pageId, operation: 'upsert' })
    // Clearing private resumes space inheritance; it does NOT restore public (one-way — a re-publish or
    // an explicit public toggle re-adds view_base@user:* if desired). Delete each marker INDEPENDENTLY
    // a legacy page privatised before the #244 backfill has only user:*, and a single batch delete of a
    // missing share_link:* would fail the whole write and leave the page stuck private.
    await Promise.all(PRIVATE_MARKERS(args.pageId).map((m) => deleteTuples(fga, [m]).catch(() => {})))
    return o
  })
  processOutboxAsync(driver, oid, { tenantId: args.tenantId, pageId: args.pageId, operation: 'upsert' })
  emit({ type: 'page.made_non_private', tenantId: args.tenantId, pageId: args.pageId, actorId: args.userId })
}

// #253 / ADR-113: make a PUBLISHED page anonymously public (or revoke it). Mirrors setPagePrivate — the
// public grant is the SAME existing `view_base@user:*` (PUBLIC_GRANT), so no new FGA type; manage-gated +
// audited (#177) + outbox-reindexed. Five guardrails (ADR-113): the tenant parent switch (a READ-TIME gate,
// enforced in the public routes — publicSurfaceEnabled), manager/admin only (requireManage), audit,
// noindex=true set in the SAME tx (guardrail 4), published-only (draft → 400), and public⊥private held at
// the write boundary (a private page is rejected just before the write, TOCTOU-minimised).
export async function setPagePublic(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; tenantId: string; userId: string; plan?: string },
): Promise<void> {
  await requireManage(fga, args.userId, args.pageId)
  // published-only: a draft has no public snapshot to serve (would leak an in-progress page).
  const [p] = await db.sql<{ published_at: Date | null }[]>`SELECT published_at FROM pages WHERE id = ${args.pageId}`
  if (!p || p.published_at == null) throw Object.assign(new Error('only a published page can be made public'), { statusCode: 400 })
  // public⊥private: never make a private page public. Read the marker at the LAST moment before the write to
  // minimise the TOCTOU window (a concurrent privatise still can't co-exist — the reindex resolves is_public
  // from FGA, and setPagePrivate strips PUBLIC_GRANT).
  if (await readPagePrivate(fga, args.pageId)) throw Object.assign(new Error('a private page cannot be made public'), { statusCode: 409 })
  const oid = await db.tx(async (tx) => {
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'page.made_public', target: `page:${args.pageId}` })
    }
    // Guardrail 4: force noindex ON in the SAME tx as the public grant so a newly-public page is never
    // crawler-indexed by default (opt-in indexing is a future ticket — ADR-113 decision 3).
    await tx`UPDATE pages SET noindex = true WHERE id = ${args.pageId}`
    const o = await enqueueOutbox(tx, { tenantId: args.tenantId, pageId: args.pageId, operation: 'upsert' })
    await writeTuples(fga, [PUBLIC_GRANT(args.pageId)]) // view_base@user:* — is_public flips true on reindex
    return o
  })
  // #253 review (TOCTOU self-heal): the pre-write private check (:786) is outside the tx, so a concurrent
  // setPagePrivate could land its markers BETWEEN that check and the grant write above, leaving a private page
  // with a live view_base@user:* (anonymous world-readable, no self-heal — the higher-stakes leak the reviewer
  // flagged). Re-read private AFTER the write; if it is now private, REVOKE the grant we just wrote so
  // private always wins (public⊥private converges without an advisory lock). Idempotent.
  if (await readPagePrivate(fga, args.pageId)) {
    await deleteTuples(fga, [PUBLIC_GRANT(args.pageId)]).catch(() => {})
    throw Object.assign(new Error('a private page cannot be made public'), { statusCode: 409 })
  }
  processOutboxAsync(driver, oid, { tenantId: args.tenantId, pageId: args.pageId, operation: 'upsert' })
  emit({ type: 'page.made_public', tenantId: args.tenantId, pageId: args.pageId, actorId: args.userId })
}

export async function unsetPagePublic(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; tenantId: string; userId: string; plan?: string },
): Promise<void> {
  await requireManage(fga, args.userId, args.pageId)
  const oid = await db.tx(async (tx) => {
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'page.made_non_public', target: `page:${args.pageId}` })
    }
    const o = await enqueueOutbox(tx, { tenantId: args.tenantId, pageId: args.pageId, operation: 'upsert' })
    // Remove the anonymous grant (idempotent — the page may not be public). Exactly one tuple, so no orphan.
    await deleteTuples(fga, [PUBLIC_GRANT(args.pageId)]).catch(() => {})
    return o
  })
  processOutboxAsync(driver, oid, { tenantId: args.tenantId, pageId: args.pageId, operation: 'upsert' })
  emit({ type: 'page.made_non_public', tenantId: args.tenantId, pageId: args.pageId, actorId: args.userId })
}

// #253 / ADR-113 (guardrail 1): the tenant parent switch, read FRESH (like ai_enabled) so an admin turning
// it OFF takes effect immediately. This is the READ-TIME gate every anonymous public route consults — OFF ⇒
// the whole public surface 404s uniformly, WITHOUT touching any index or grant (non-destructive; ON restores).
export async function publicSurfaceEnabled(db: TenantDb): Promise<boolean> {
  const [row] = await db.sql<{ public_enabled: boolean }[]>`SELECT public_enabled FROM tenant_settings LIMIT 1` // RLS-scoped to this tenant (like ai_enabled)
  return row?.public_enabled === true
}

// Admin: flip the tenant parent switch. Upserts the settings row, preserving other columns (mirrors
// setTenantAiEnabled). Turning it OFF is non-destructive (no grants/index touched) — the read-time gate
// simply hides the surface until it is turned back ON.
export async function setTenantPublicEnabled(db: TenantDb, tenantId: string, enabled: boolean): Promise<void> {
  await db.sql`
    INSERT INTO tenant_settings (tenant_id, public_enabled)
    VALUES (${tenantId}, ${enabled})
    ON CONFLICT (tenant_id) DO UPDATE SET public_enabled = ${enabled}, updated_at = now()
  `
}

// Manage-gated read of a page's public state (view_base@user:*) for the toggle UI's authoritative read.
export async function isPagePublic(fga: OpenFgaClient, args: { pageId: string; userId: string }): Promise<boolean> {
  await requireManage(fga, args.userId, args.pageId)
  const { tuples } = await fga.read({ object: `page:${args.pageId}`, relation: 'view_base' })
  return (tuples ?? []).some(({ key }) => key?.relation === 'view_base' && key.user === 'user:*')
}

// Is the page private (allowlist mode)? Manage-gated read for the permissions UI.
export async function isPagePrivate(
  fga: OpenFgaClient,
  args: { pageId: string; userId: string },
): Promise<boolean> {
  await requireManage(fga, args.userId, args.pageId)
  const { tuples } = await fga.read({ object: `page:${args.pageId}`, relation: 'private' })
  return (tuples ?? []).some(({ key }) => key?.relation === 'private' && key.user === 'user:*')
}

export async function listPageAccess(
  fga: OpenFgaClient,
  db: TenantDb,
  args: { pageId: string; tenantId: string; userId: string },
): Promise<{ grantee: string; relation: PageRelation; groupName?: string }[]> {
  await requireManage(fga, args.userId, args.pageId)
  const { tuples } = await fga.read({ object: `page:${args.pageId}` })
  // #163: resolve group grantee ids back to names for display (groupFgaId is one-way).
  const names = (await db.sql<{ g: string }[]>`SELECT DISTINCT unnest(groups) AS g FROM members WHERE groups IS NOT NULL`).map((r) => r.g)
  const byId = groupNameByFgaId(args.tenantId, names)
  const out: { grantee: string; relation: PageRelation; groupName?: string }[] = []
  for (const { key } of tuples ?? []) {
    const cap = key ? capForFgaRelation(key.relation) : null
    if (!key || !cap) continue // maps view_base→view, comment/edit/manage; skips space/view/comment_open
    // Direct member/group grants only — never expose share_link or the space link.
    if (!/^user:[^*\s]+$/.test(key.user) && !/^group:[^\s]+#member$/.test(key.user)) continue
    const groupName = resolveGroupName(key.user, byId)
    out.push({ grantee: key.user, relation: cap, ...(groupName ? { groupName } : {}) })
  }
  return out
}

// Pages overview for a space (Phase 5 #5). space#manage gated — a manager sees the
// pages ONLY of a space they manage (RLS scopes to the tenant; the space#manage
// check is the authority), so nothing leaks beyond their authority. Per page
// published state, the cheap unpublished-changes flag, the count of DIRECT page
// grants (user/group only — never share_link/wildcard/the space link), and the
// count of active share links.
export interface PageOverview {
  id: string; title: string; published: boolean; hasUnpublishedChanges: boolean; grantCount: number; linkCount: number
}
export async function listSpacePagesOverview(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { spaceId: string; userId: string },
): Promise<PageOverview[]> {
  const canManage = await check(fga, `user:${args.userId}`, 'manage', { type: 'space', id: args.spaceId })
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  const rows = await db.sql<{ id: string; title: string; published: boolean; has_unpublished_changes: boolean; link_count: number }[]>`
    SELECT p.id, p.title, (p.published_at IS NOT NULL) AS published, p.has_unpublished_changes,
           count(sl.id) FILTER (WHERE sl.revoked_at IS NULL)::int AS link_count
    FROM pages p
    LEFT JOIN share_links sl ON sl.resource_type = 'page' AND sl.resource_id = p.id
    WHERE p.space_id = ${args.spaceId}
    GROUP BY p.id, p.title, p.published_at, p.has_unpublished_changes, p.position, p.created_at
    ORDER BY p.position, p.created_at
  `
  const out: PageOverview[] = []
  for (const r of rows) {
    const { tuples } = await fga.read({ object: `page:${r.id}` })
    let grantCount = 0
    for (const { key } of tuples ?? []) {
      if (!key || !PAGE_RELATIONS.includes(key.relation as PageRelation)) continue
      if (!/^user:[^*\s]+$/.test(key.user) && !/^group:[^\s]+#member$/.test(key.user)) continue
      grantCount++
    }
    out.push({ id: r.id, title: r.title, published: r.published, hasUnpublishedChanges: r.has_unpublished_changes, grantCount, linkCount: r.link_count })
  }
  return out
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

// #218 / ADR-103 prep slice ③ (approval comment 996, decision 3): a max page-nesting depth, enforced at
// the create/move write boundary. ADR-103 makes `private`/allow inherit through the `parent` chain
// (`private from parent`, `*_from_parent`), so an authz Check resolves ~one hop per nesting level; OpenFGA's
// default resolution depth is 25, and unbounded nesting would eventually make deep pages un-resolvable (the
// Check errors → that page's authz FAILS). Cap depth well under that limit with margin. Inert today (the
// `parent` relation isn't wired into the model yet) but a required guard the model flip depends on — landed
// separately so the atomic flip carries no separable scaffolding.
export const MAX_PAGE_DEPTH = 10 // 0-indexed: a top-level page is depth 0, so up to 11 nesting levels.

// Depth of a page = its number of ancestors (0 for a top-level page). Walks parent_id up to the root.
async function ancestorDepth(db: TenantDb, id: string): Promise<number> {
  const [r] = await db.sql<[{ n: number }]>`
    WITH RECURSIVE anc AS (
      SELECT parent_id FROM pages WHERE id = ${id}
      UNION ALL
      SELECT p.parent_id FROM pages p JOIN anc ON p.id = anc.parent_id WHERE anc.parent_id IS NOT NULL
    )
    SELECT count(*) FILTER (WHERE parent_id IS NOT NULL)::int AS n FROM anc
  `
  return r?.n ?? 0
}

// Height of the subtree rooted at `id` = the deepest descendant's distance below it (0 for a leaf).
async function subtreeHeight(db: TenantDb, id: string): Promise<number> {
  const [r] = await db.sql<[{ h: number }]>`
    WITH RECURSIVE d AS (
      SELECT id, 0 AS lvl FROM pages WHERE id = ${id}
      UNION ALL
      SELECT p.id, d.lvl + 1 FROM pages p JOIN d ON p.parent_id = d.id
    )
    SELECT COALESCE(MAX(lvl), 0)::int AS h FROM d
  `
  return r?.h ?? 0
}

// Swap each page's direct `space:<id>#space@page:<id>` grant from oldSpace to
// newSpace, in the ORDER delete-OLD → add-NEW (ADR-003). Authorization for a
// page derives solely from its space (page#parent is unwired), so a cross-space
// move must re-point every page in the moved subtree.
//
// Ordering matters for the failure mode: by deleting OLD first, the only
// reachable intermediate is "the page is grantless = invisible from ANY space"
// — never "granted by BOTH spaces" (which would leak the page to the source
// space's members after it has logically left). If the add-NEW write throws, the
// caller's surrounding tx rolls the DB back to oldSpace, leaving the page
// fail-closed (invisible) and the move retryable.
//
// The OLD delete is idempotent and surgical: we read each page's tuples and
// delete only the oldSpace `space` grant that actually exists, so a retry after a
// partial failure is safe and share_link grants on the page are left untouched.
async function swapSpaceTuples(
  fga: OpenFgaClient,
  oldSpace: string,
  newSpace: string,
  pageIds: string[],
): Promise<void> {
  const deletes: { user: string; relation: string; object: string }[] = []
  const writes: { user: string; relation: string; object: string }[] = []
  for (const id of pageIds) {
    const { tuples } = await fga.read({ object: `page:${id}` })
    const keys = (tuples ?? []).map((t) => t.key).filter((k): k is NonNullable<typeof k> => !!k)
    const hadOld = keys.some((k) => k.relation === 'space' && k.user === `space:${oldSpace}`)
    // Only swap pages that were LINKED to the old space (published). A DRAFT has no
    // page#space (the visibility gate) — leave it unlinked so it stays gated; its
    // next publish writes page#space for whatever space it then lives in. Writing a
    // new link for a draft here would prematurely release the gate in the new space.
    if (!hadOld) continue
    deletes.push({ user: `space:${oldSpace}`, relation: 'space', object: `page:${id}` })
    if (!keys.some((k) => k.relation === 'space' && k.user === `space:${newSpace}`)) {
      writes.push({ user: `space:${newSpace}`, relation: 'space', object: `page:${id}` })
    }
  }
  if (deletes.length) await deleteTuples(fga, deletes) // (1) OLD removed → invisible from any space
  if (writes.length) await writeTuples(fga, writes) // (2) NEW added; if this throws, see caller rollback
}

// #218 / ADR-103 prep slice: keep the structural `page#parent` FGA tuple in sync with the DB `parent_id` on
// every create/move, so the nested private/allow inheritance (`private`/`view_base` `from parent`) can be
// lit up by the follow-up model change WITHOUT re-deriving live edits. The `parent` relation is currently
// UNWIRED in model.fga (reserved, not read by any permission relation) — writing it has NO authorization
// effect yet — so this is inert plumbing that primes the data path (the model DSL flip + a one-off backfill
// of pre-existing rows are the remaining atomic slice). The tuple is `page:<child>#parent@page:<parent>`.
// Called only AFTER movePage's existing cycle guard (a page can't move under itself or a descendant), so the
// parent chain can never form a computed-recursion cycle. Idempotent: a missing delete is success.
async function syncPageParentTuple(fga: OpenFgaClient, pageId: string, oldParent: string | null, newParent: string | null): Promise<void> {
  if (oldParent === newParent) return;
  if (oldParent) {
    try {
      await deleteTuples(fga, [{ user: `page:${oldParent}`, relation: 'parent', object: `page:${pageId}` }])
    } catch (err) {
      if (!String((err as Error)?.message ?? '').includes('did not exist')) throw err
    }
  }
  if (newParent) await writeTuples(fga, [{ user: `page:${newParent}`, relation: 'parent', object: `page:${pageId}` }])
}

// Move/reorder a page: change parent_id, position, and optionally its space.
//
// Intra-space (no space change): permissions derive from the space and don't
// change, so this needs `edit` on the page. It is a single-row UPDATE of a
// fractional position between the new neighbours (no sibling renumber →
// concurrent moves of different pages don't conflict).
//
// Cross-space (3b ②): the whole subtree follows the page into the destination
// space, so it needs `manage` on the page (a structural ownership change) AND
// `edit` on the destination space. ADR-003 (DB-first): the DB writes and the FGA
// tuple swap run inside one tx with the FGA swap LAST, so a swap failure throws
// and rolls the DB back (no ghost authorization), and only the commit itself can
// fall after a successful swap.
export async function movePage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; userId: string; parentId: string | null; afterId: string | null; spaceId?: string | null },
): Promise<Page> {
  const [page] = await db.sql<PageRow[]>`
    SELECT id, tenant_id, space_id, parent_id, title, position, created_at, updated_at
    FROM pages WHERE id = ${args.pageId}
  `
  if (!page) throw Object.assign(new Error('not found'), { statusCode: 404 })

  const newParent = args.parentId ?? null
  let targetSpace = args.spaceId ?? page.space_id
  if (newParent) {
    const [p] = await db.sql<{ space_id: string }[]>`SELECT space_id FROM pages WHERE id = ${newParent}`
    if (!p) throw Object.assign(new Error('parent not found'), { statusCode: 400 })
    if (args.spaceId != null && p.space_id !== args.spaceId) {
      throw Object.assign(new Error('parent not in target space'), { statusCode: 400 })
    }
    targetSpace = p.space_id // the parent's space is authoritative for the destination
  }
  const crossSpace = targetSpace !== page.space_id

  // Authorization: cross-space is a structural ownership move.
  if (crossSpace) {
    const [canManage, canEditDest] = await Promise.all([
      check(fga, `user:${args.userId}`, 'manage', { type: 'page', id: args.pageId }),
      check(fga, `user:${args.userId}`, 'edit', { type: 'space', id: targetSpace }),
    ])
    if (!canManage || !canEditDest) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  } else {
    const canEdit = await check(fga, `user:${args.userId}`, 'edit', { type: 'page', id: args.pageId })
    if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  }

  // No cycles: a page cannot be nested under itself or its own descendant.
  if (newParent) {
    if (newParent === args.pageId) throw Object.assign(new Error('cannot nest under itself'), { statusCode: 400 })
    if ((await descendantIds(db, args.pageId)).includes(newParent)) {
      throw Object.assign(new Error('cannot nest under own descendant'), { statusCode: 400 })
    }
    // #218 / ADR-103 (comment 996 decision 3): the MOVED subtree's deepest node lands at
    // newParent depth + 1 + the subtree's own height — cap it under the resolution-depth limit.
    if ((await ancestorDepth(db, newParent)) + 1 + (await subtreeHeight(db, args.pageId)) > MAX_PAGE_DEPTH) {
      throw Object.assign(new Error(`max nesting depth (${MAX_PAGE_DEPTH}) exceeded`), { statusCode: 400 })
    }
  }

  // Position between afterId and the next sibling in the DESTINATION sibling list.
  const sibs = await db.sql<{ id: string; position: number }[]>`
    SELECT id, position FROM pages
    WHERE space_id = ${targetSpace} AND parent_id IS NOT DISTINCT FROM ${newParent} AND id <> ${args.pageId}
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

  if (!crossSpace) {
    // Common case: a single-row UPDATE with the fractional position (no sibling renumber, so
    // concurrent moves of different pages don't conflict). Collapsed gap (#118): re-spread the
    // destination sibling group first, then recompute the slot — all in one tx.
    if (gapCollapsed(before, after)) {
      const r = await db.tx(async (tx) => {
        const fresh = await rebalanceSiblings(tx, targetSpace, newParent, args.pageId)
        let b: number | null = null
        let a: number | null = null
        if (args.afterId == null) a = fresh[0]?.position ?? null
        else { const i = fresh.findIndex((s) => s.id === args.afterId); b = fresh[i]!.position; a = fresh[i + 1]?.position ?? null }
        const [row] = await tx<PageRow[]>`
          UPDATE pages SET parent_id = ${newParent}, position = ${positionBetween(b, a)}, updated_at = now()
          WHERE id = ${args.pageId}
          RETURNING id, tenant_id, space_id, parent_id, title, position, created_at, updated_at
        `
        return row!
      })
      await syncPageParentTuple(fga, args.pageId, page.parent_id, newParent) // #218 prep (inert until model change)
      emit({ type: 'page.updated', tenantId: page.tenant_id, pageId: page.id, actorId: args.userId })
      return toPage(r)
    }
    const [r] = await db.sql<PageRow[]>`
      UPDATE pages SET parent_id = ${newParent}, position = ${position}, updated_at = now()
      WHERE id = ${args.pageId}
      RETURNING id, tenant_id, space_id, parent_id, title, position, created_at, updated_at
    `
    await syncPageParentTuple(fga, args.pageId, page.parent_id, newParent) // #218 prep (inert until model change)
    emit({ type: 'page.updated', tenantId: page.tenant_id, pageId: page.id, actorId: args.userId })
    return toPage(r)
  }

  // ── cross-space: subtree follows the page; re-index each; swap space grants ──
  const subtree = [args.pageId, ...(await descendantIds(db, args.pageId))]
  const oldSpace = page.space_id
  const outboxIds: { id: string; pageId: string }[] = []
  const row = await db.tx(async (tx) => {
    await tx`UPDATE pages SET space_id = ${targetSpace}, updated_at = now() WHERE id IN ${tx(subtree)}`
    const [r] = await tx<PageRow[]>`
      UPDATE pages SET parent_id = ${newParent}, position = ${position}, updated_at = now()
      WHERE id = ${args.pageId}
      RETURNING id, tenant_id, space_id, parent_id, title, position, created_at, updated_at
    `
    // Viewer denormalization in Meili changes with the space → re-index the subtree.
    for (const id of subtree) {
      outboxIds.push({ id: await enqueueOutbox(tx, { tenantId: page.tenant_id, pageId: id, operation: 'upsert' }), pageId: id })
    }
    // FGA swap LAST: a throw here rolls back every DB write above (ADR-003).
    await swapSpaceTuples(fga, oldSpace, targetSpace, subtree)
    return r
  })
  await syncPageParentTuple(fga, args.pageId, page.parent_id, newParent) // #218 prep (inert until model change)
  for (const o of outboxIds) processOutboxAsync(driver, o.id, { tenantId: page.tenant_id, pageId: o.pageId, operation: 'upsert' })
  emit({ type: 'page.updated', tenantId: page.tenant_id, pageId: page.id, actorId: args.userId })
  return toPage(row as PageRow)
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
    // #284 / ADR-119: best-effort pin cleanup (page + descendants). The pin display
    // gate drops orphans regardless — this is row hygiene, not correctness.
    await deletePinsForResources(tx, ids)
    await tx`DELETE FROM pages WHERE id = ${args.pageId}` // cascade deletes descendants
  })
  for (const o of outboxIds) processOutboxAsync(driver, o.id, { tenantId, pageId: o.pageId, operation: 'delete' })
  emit({ type: 'page.deleted', tenantId, pageId: args.pageId, actorId: args.userId })
}

// Resolve the request principal (member OR guest) for a page action. Returns the FGA subject,
// the attribution id, and (guests) the time context for the share_link condition.
//
// Guest token binding
// - a PAGE token is bound to its own page (a token for page A can never read page B).
// - a SPACE token (#104) is accepted for ANY page — the per-route FGA check re-derives
// authority (page#view ← viewer from space), so it grants ONLY published pages in that
// space and never an out-of-space page or a draft. (Space links are view-only, so the
// edit-gated routes reject the token at the auth hook before this is reached.)
export function principalForPage(req: FastifyRequest, pageId: string): { subject: string; createdBy: string; context?: { current_time: string } } {
  if (req.user) {
    return { subject: `user:${req.user.sub}`, createdBy: `user:${req.user.sub}` }
  }
  if (req.guest) {
    const r = req.guest.resource
    const bound = (r.type === 'page' && r.id === pageId) || r.type === 'space'
    if (!bound) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
    return {
      subject: `share_link:${req.guest.shareLinkId}`,
      createdBy: `guest:${req.guest.shareLinkId}`,
      context: { current_time: new Date().toISOString() },
    }
  }
  throw Object.assign(new Error('unauthorized'), { statusCode: 401 })
}

// #276 / ADR-117: the subject for a BATCH request NOT bound to a single pageId (link-status). Unlike
// principalForPage there is no URL resource to bind a guest token against, so a guest resolves as its
// bare `share_link:<id>` and the per-id FGA `view` check is the sole gate — a page-token guest then sees
// every OTHER page as dead (no leak; ADR-117 §1 guardrail). Never sets/reads existence — subject only.
export function batchPrincipal(req: FastifyRequest): { subject: string; context?: { current_time: string } } {
  if (req.user) return { subject: `user:${req.user.sub}` }
  if (req.guest) return { subject: `share_link:${req.guest.shareLinkId}`, context: { current_time: new Date().toISOString() } }
  throw Object.assign(new Error('unauthorized'), { statusCode: 401 })
}

// #276 / ADR-117: resolve which of a client-supplied id list the viewer can `view` — the batch behind the
// dead-internal-link overlay. This is a VIEWABILITY check, NEVER an existence check: it runs ONLY the FGA
// `check` (via the shared filterAuthorized primitive, the same one search stage-2 / #224 use), with NO DB
// existence query — a non-existent id, a deleted page, and a private page the viewer can't see are all
// byte-identically absent from the result (the 404-unification / no-existence-oracle invariant, #262). A
// DB prefilter here would REINTRODUCE the oracle and is forbidden. De-duped + capped by the caller.
export const MAX_LINK_STATUS_IDS = 256

// #230: backlinks — the pages that reference `pageId` from their PUBLISHED content. Sources are the
// PERSISTED internal references only: an `:::embed-page\n<id>\n:::` block (the body IS the target id)
// and an explicit markdown link to `/p/<id>`. (The #224 title-match auto-links are display-only
// never in the source — so they are out of scope here and follow #224's finalisation.)
// Security: the SQL LIKE only prefilters candidates that mention the id string; each candidate is then
// (a) confirmed to hold a REAL reference (precise regex, not a coincidental substring) and (b) gated
// by an FGA `view` check for the viewer — so a backlink from a page the viewer can't see is never
// leaked ("confirm via OpenFGA before display", like listSpaces / the search stage-2 guard).
export interface Backlink { id: string; title: string }
export async function getBacklinks(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; subject: string; context?: { current_time: string } },
): Promise<Backlink[]> {
  // #307 /view-gate the TARGET page itself. This endpoint is now callable with an ARBITRARY target
  // (the `:::backlinks` macro can carry a page id in its body). Without this, a caller could probe any id and
  // learn "which pages I can see link to it" — leaking the target's existence/backlinks even when they can't
  // view it. `check(view)` is false for BOTH a non-viewable AND a non-existent page, so a uniform 404 keeps the
  // two indistinguishable (existence-hiding,.4). The current-page callers (#230 panel, delete warning)
  // are always viewing the page, so this passes for them (no regression).
  if (!(await check(fga, args.subject, 'view', { type: 'page', id: args.pageId }, args.context))) {
    throw Object.assign(new Error('not found'), { statusCode: 404 })
  }
  // A real reference = an /p/<id> link OR the id as an embed-page body line. Word-boundary the id so
  // `/p/ab` doesn't match page `abc`.
  const idRe = args.pageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const refRe = new RegExp(`/p/${idRe}(?![\\w-])|(^|\\n)\\s*${idRe}\\s*(\\n|$)`)
  const rows = await db.sql<{ id: string; title: string; published_md: string }[]>`
    SELECT id, title, published_md FROM pages
    WHERE id <> ${args.pageId}
      AND published_at IS NOT NULL
      AND published_md IS NOT NULL
      AND published_md LIKE ${'%' + args.pageId + '%'}
    ORDER BY updated_at DESC
    LIMIT 200
  `
  const candidates = rows.filter((r) => refRe.test(r.published_md))
  const out: Backlink[] = []
  for (const c of candidates) {
    const ok = await check(fga, args.subject, 'view', { type: 'page', id: c.id }, args.context)
    if (ok) out.push({ id: c.id, title: c.title })
  }
  return out
}

// ── #224 / ADR-104: title dictionary + excerpt (auto internal links) ─────────

export interface TitleDictEntry { id: string; title: string }

// The user-typed "public" principal (same as routes/public.ts): `view_base@user:*` only matches
// user-type principals (#244 typed-wildcard lesson), so this resolves exactly the PUBLIC page set.
const DICT_ANON = 'user:anonymous'
//condition 2: a hard server-side dictionary cap bounds the client's match cost
// (matchTitleLinks is O(dict × visible text)). Overflow is a UX gap, never a leak (absent = safe).
const DICT_CAP = 2000

// The viewer-scoped title dictionary (ADR-104 Addendum 3 Finding A, shape (ii) DB + ListObjects).
// authz model (Addendum 2 point 1): this dictionary IS the primary defence — it must only ever
// contain titles the caller may view. Two principals
// - member → FGA ListObjects('view') for user:<sub> — the full authoritative view set — then the
// tenant-scoped (RLS) title join, then the Addendum-3 belt-and-braces filterAuthorized confirm.
// - share_link guest → **forced to the PUBLIC set via the anonymous user-typed principal** and
// published-only rows. The share_link principal itself is NEVER given a reverse lookup — that is
// thebinding closing the #244 re-entry (a space-shared non-public title must not leak).
// Existence-hiding needs no 404 here: a non-viewable page is simply absent from the response.
export async function getTitleDictionary(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { subject: string },
): Promise<{ entries: TitleDictEntry[]; capped: boolean }> {
  const isGuest = args.subject.startsWith('share_link:')
  const principal = isGuest ? DICT_ANON : args.subject
  const { objects } = await fga.listObjects({ user: principal, relation: 'view', type: 'page' })
  const ids = (objects ?? []).map((o: string) => o.replace(/^page:/, ''))
  if (ids.length === 0) return { entries: [], capped: false }
  // ListObjects spans the shared FGA store; the tenant-scoped handle (RLS) narrows to this tenant.
  // Guests link only into the published public surface; members may link to viewable drafts too
  // (their titles already show in the member sidebar — nothing new is revealed).
  const rows = isGuest
    ? await db.sql<{ id: string; title: string }[]>`
        SELECT id, title FROM pages WHERE id = ANY(${ids}) AND published_at IS NOT NULL
        ORDER BY updated_at DESC LIMIT ${DICT_CAP + 1}`
    : await db.sql<{ id: string; title: string }[]>`
        SELECT id, title FROM pages WHERE id = ANY(${ids})
        ORDER BY updated_at DESC LIMIT ${DICT_CAP + 1}`
  const capped = rows.length > DICT_CAP
  const windowRows = capped ? rows.slice(0, DICT_CAP) : rows
  // Addendum 3: the final confirm on the capped window (belt-and-braces for the ListObjects shape;
  // a SINGLE filterAuthorized pass — never per-link display-time checks, anti-test 8).
  const confirmed = await filterAuthorized(fga, principal, 'view', windowRows.map((r) => r.id))
  return { entries: windowRows.filter((r) => confirmed.has(r.id)), capped }
}

// The hover-card excerpt (ADR-104 Slice B): a thin, view-gated read following the getPublished
// pattern — deny and missing are the SAME 404 (#262 existence-hiding; anti-test 5: no wording ever
// distinguishes them). Published content only: an unpublished draft returns excerpt null (the title
// alone is already in the viewer's dictionary). The client renders the excerpt as textContent
// (plain text, no markdown render → no injection surface).
export async function getExcerpt(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; subject: string; context?: { current_time: string } },
): Promise<{ title: string; excerpt: string | null }> {
  const canView = await check(fga, args.subject, 'view', { type: 'page', id: args.pageId }, args.context)
  if (!canView) throw Object.assign(new Error('not found'), { statusCode: 404 })
  const [row] = await db.sql<[{ title: string; published_md: string | null }]>`
    SELECT title, published_md FROM pages WHERE id = ${args.pageId}
  `
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
  const md = (row.published_md ?? '').trim()
  return { title: row.title, excerpt: md ? md.slice(0, 400) : null }
}

// ── Fastify plugin ────────────────────────────────────────────────────────

export async function pagesPlugin(app: FastifyInstance) {
  app.post<{ Params: { spaceId: string }; Body: { title?: string; parentId?: string | null; fromPageId?: string | null; templateId?: string | null } }>(
    '/spaces/:spaceId/pages', async (req, reply) => {
      const page = await createPage(req.db, app.fga, app.searchDriver, {
        tenantId: req.tenant.id,
        spaceId: req.params.spaceId,
        userId: req.user.sub,
        title: req.body.title,
        parentId: req.body.parentId ?? null,
        fromPageId: req.body.fromPageId ?? null, // #229: seed from a page ("duplicate", view-gated)
        templateId: req.body.templateId ?? null, // #250: seed from a template snapshot (view-gated)
      })
      return reply.code(201).send(page)
    },
  )

  // Move/reorder a page. parentId null = top level; afterId null = first child of
  // the target parent. spaceId moves the page (and its subtree) to another space
  // (3b ②); when parentId is given, the parent's space is authoritative.
  app.patch<{ Params: { pageId: string }; Body: { parentId?: string | null; afterId?: string | null; spaceId?: string | null } }>(
    '/pages/:pageId/move', async (req) => {
      return movePage(req.db, app.fga, app.searchDriver, {
        pageId: req.params.pageId,
        userId: req.user.sub,
        parentId: req.body.parentId ?? null,
        afterId: req.body.afterId ?? null,
        spaceId: req.body.spaceId ?? null,
      })
    },
  )

  // The space page tree — for a member, or a space-link guest (#104). A guest's token is
  // bound to THIS space (resource.type=space, id=spaceId), and listPages only returns the
  // published pages the guest may view (leak-safe). View is the floor (no comment/edit needed).
  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/pages', { config: { guest: 'view' } }, async (req, reply) => {
    let subject: string
    let context: { current_time: string } | undefined
    if (req.user) {
      subject = `user:${req.user.sub}`
    } else if (req.guest) {
      if (req.guest.resource.type !== 'space' || req.guest.resource.id !== req.params.spaceId) {
        return reply.code(403).send({ error: 'forbidden' })
      }
      subject = `share_link:${req.guest.shareLinkId}`
      context = { current_time: new Date().toISOString() }
    } else {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    return listPages(req.db, app.fga, { spaceId: req.params.spaceId, subject, context })
  })

  // #270: the guest reader-chrome's space HEADER (name + public icon only). Guest-capable + resource-bound
  // (same guard as /pages): a member sees any space they can view; a space-link guest ONLY its bound space.
  // No accent/capability/members — getSpaceInfo returns just name + iconImageUrl.
  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/info', { config: { guest: 'view' } }, async (req, reply) => {
    if (!req.user) {
      if (!req.guest || req.guest.resource.type !== 'space' || req.guest.resource.id !== req.params.spaceId) {
        return reply.code(req.guest ? 403 : 401).send({ error: req.guest ? 'forbidden' : 'unauthorized' })
      }
    } else {
      // A member must be able to VIEW the space (existence-hidden 404 otherwise, like the page read path #262).
      if (!(await check(app.fga, `user:${req.user.sub}`, 'view', { type: 'space', id: req.params.spaceId }))) {
        return reply.code(404).send({ error: 'not found' })
      }
    }
    const info = await getSpaceInfo(req.db, req.params.spaceId)
    if (!info) return reply.code(404).send({ error: 'not found' })
    return info
  })

  // Pages overview for space managers (Phase 5 #5) — space#manage gated.
  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/pages-overview', async (req) => {
    return listSpacePagesOverview(req.db, app.fga, { spaceId: req.params.spaceId, userId: req.user.sub })
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

  // Publish the current draft as the new published version (edit-gated). Members or
  // an edit-capable guest (share-link) — same FGA `edit` check either way.
  app.post<{ Params: { pageId: string } }>('/pages/:pageId/publish', { config: { guest: 'edit' } }, async (req) => {
    const p = principalForPage(req, req.params.pageId)
    // Flush the live draft to pages.ydoc BEFORE snapshotting, so a publish issued
    // right after typing (within the collab debounce window) includes those edits and
    // does not leave them behind as "unpublished changes". Best-effort: never blocks
    // longer than the timeout, and is a no-op when collab isn't running (e.g. tests).
    await flushDraft(app.valkey, docName(req.tenant.id, req.params.pageId))
    return publishPage(req.db, app.fga, app.searchDriver, app.storageDriver, { pageId: req.params.pageId, ...p })
  })

  // Toggle a single task checkbox on the published page WITHOUT creating a revision
  // (ADR-019). Edit-gated (FGA bastion) like publish; the client has already flipped
  // the live draft, so flush it first, then fold the one flip into published_md.
  app.post<{ Params: { pageId: string }; Body: { index: number } }>(
    '/pages/:pageId/tasks/toggle', { config: { guest: 'edit' } }, async (req) => {
      const p = principalForPage(req, req.params.pageId)
      await flushDraft(app.valkey, docName(req.tenant.id, req.params.pageId))
      return toggleTask(req.db, app.fga, app.searchDriver, {
        pageId: req.params.pageId, subject: p.subject, createdBy: p.createdBy, index: req.body.index, context: p.context,
      })
    },
  )

  // Read the published content + draft-vs-published state (view-gated). Members or a
  // view-capable guest. The web view surface and guest share routes render this.
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/published', { config: { guest: 'view' } }, async (req) => {
    const { subject, context } = principalForPage(req, req.params.pageId)
    return getPublished(req.db, app.fga, { pageId: req.params.pageId, subject, context })
  })

  // #230: backlinks for a page (member or view-guest). Each returned page is FGA-view-gated for the
  // caller, so this leaks no reference from a page the viewer cannot see.
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/backlinks', { config: { guest: 'view' } }, async (req) => {
    const { subject, context } = principalForPage(req, req.params.pageId)
    return getBacklinks(req.db, app.fga, { pageId: req.params.pageId, subject, context })
  })

  // #224 / ADR-104: the viewer-scoped title dictionary for auto internal links. The :pageId only
  // anchors the guest token binding (a guest may fetch it for the page/space they were shared);
  // the dictionary itself is viewer-scoped (member = own view set / guest = public-only — see
  // getTitleDictionary). Nothing here is per-link display-time authz — the dictionary content IS
  // the defence (Addendum 2 point 1).
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/title-dictionary', { config: { guest: 'view' } }, async (req) => {
    const { subject } = principalForPage(req, req.params.pageId)
    return getTitleDictionary(req.db, app.fga, { subject })
  })

  // #276 / ADR-117: dead-internal-link resolution — "which of these ids can the viewer VIEW?" NEVER "which
  // exist?". The client collects its page's `/p/<id>` link targets and posts them; the subset it gets back
  // is alive, everything else is struck through. Purely a viewability check (filterAuthorized = per-id FGA
  // `view`, no DB existence query), so non-existent / deleted / private / other-space / cross-tenant ids are
  // all uniformly dead and indistinguishable (existence-hiding, #262). Guest-capable (a share-link viewer's
  // dead-set is computed under its own capability). Batch de-duped + capped (anti-test 8).
  app.post<{ Body: { ids?: unknown } }>('/pages/link-status', { config: { guest: 'view' } }, async (req, reply) => {
    const { subject, context } = batchPrincipal(req)
    const raw = Array.isArray(req.body?.ids) ? req.body!.ids : []
    const ids = [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.length > 0))].slice(0, MAX_LINK_STATUS_IDS)
    const viewable = await filterAuthorized(app.fga, subject, 'view', ids, context) // FGA-only; no existence lookup
    return reply.send({ viewable: [...viewable] })
  })

  // #224 / ADR-104 Slice B: the hover-card excerpt — re-confirms `view` at display time (the
  // authoritative check), uniform 404 with getPage/getPublished (existence-hiding, anti-test 5).
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/excerpt', { config: { guest: 'view' } }, async (req) => {
    const { subject, context } = principalForPage(req, req.params.pageId)
    return getExcerpt(req.db, app.fga, { pageId: req.params.pageId, subject, context })
  })

  // External embed resolve (#108 / ADR-071): server-fetch an allowlisted provider URL for a page a
  // viewer can see. page-view gate + provider allowlist + SSRF guard are in resolveEmbed; the
  // allowlist is the tenant setting (default empty ⇒ external embed off). Member or view-guest.
  app.get<{ Params: { pageId: string }; Querystring: { url?: string } }>('/pages/:pageId/embed', { config: { guest: 'view' } }, async (req, reply) => {
    const { subject, context } = principalForPage(req, req.params.pageId)
    const url = req.query?.url
    if (!url) return reply.code(400).send({ error: 'url is required' })
    // #108 bounce: read the CURRENT tenant's row explicitly (not `LIMIT 1`, which reads an arbitrary
    // first row → cross-tenant mixing under a shared table). Defence-in-depth alongside any RLS.
    const [row] = await req.db.sql<{ embed_providers: string[] }[]>`SELECT embed_providers FROM tenant_settings WHERE tenant_id = ${req.tenant.id}`
    try {
      return await resolveEmbed({ fga: app.fga }, { principal: subject, pageId: req.params.pageId, url, allowlist: row?.embed_providers ?? [], context })
    } catch (e) {
      if (e instanceof EmbedDeniedError || (e as { statusCode?: number })?.statusCode === 403) {
        return reply.code(403).send({ error: 'embed not available' }) // uniform — no provider/existence leak
      }
      throw e
    }
  })

  // #108 / ADR-071 (comment 551): the tenant's external-embed host allowlist for the CLIENT-side
  // iframe embed. The approved approach for external URL embeds is a client-direct sandboxed iframe
  // for allowlisted hosts (no server proxy → no SSRF surface for that path); the client needs the
  // allowlist to decide iframe-vs-degrade. Public + host-resolved (the allowlist is operator config,
  // not sensitive); default empty ⇒ no external embed (operator opt-in).
  app.get('/embed/providers', { config: { public: true } }, async (req) => {
    // #108 bounce: scope the read to the CURRENT tenant (not `LIMIT 1`) so a shared tenant_settings
    // table never leaks/mixes another tenant's allowlist.
    const [row] = await req.db.sql<{ embed_providers: string[] }[]>`SELECT embed_providers FROM tenant_settings WHERE tenant_id = ${req.tenant.id}`
    return { providers: row?.embed_providers ?? [] }
  })

  // #108 bounce: write the tenant's external-embed host allowlist. tenant#admin only (same authority
  // as branding/API policy — a non-admin gets 403). Entries are normalised to bare lowercase hostnames
  // (scheme/path/whitespace stripped, deduped, empties dropped) so they match isAllowlistedEmbed's
  // host rule. The app's own origin is NOT a security dependency here — even if an admin adds it, the
  // render guard (isAllowlistedEmbed/buildEmbedElement) degrades a same-origin URL to a link — but the
  // UI discourages it. Scoped to the current tenant (ON CONFLICT tenant_id) so it can't touch another.
  app.put<{ Body: { providers?: unknown } }>('/embed/providers', async (req, reply) => {
    try {
      const providers = await setEmbedProviders(req.db, app.fga, { tenantId: req.tenant.id, userId: req.user.sub, providers: req.body?.providers })
      return { providers }
    } catch (e) {
      if ((e as { statusCode?: number })?.statusCode === 403) return reply.code(403).send({ error: 'forbidden' })
      throw e
    }
  })

  // Internal transclude resolve (#108 / ADR-071): return the REFERENCED page's published content for
  // a viewer who can see it. resolveTranscludeRef re-checks `view` on the REF page itself (the host
  // page's view is NOT enough — monotonic deny) and returns an IDENTICAL 'denied' for unviewable /
  // unpublished / absent (no existence oracle). Host page is :pageId (gates the request); :refId is
  // the transcluded page. Member or view-guest.
  app.get<{ Params: { pageId: string; refId: string } }>('/pages/:pageId/transclude/:refId', { config: { guest: 'view' } }, async (req, reply) => {
    const { subject, context } = principalForPage(req, req.params.pageId)
    const r = await resolveTranscludeRef({ db: req.db, fga: app.fga }, { principal: subject, refPageId: req.params.refId, context })
    if (r.ok) return { content: r.content }
    // denied → 404 (#280/#262 existence-hiding, uniform: unviewable ≡ unpublished ≡ absent ref);
    // cycle/depth → 422 (the host page IS viewable — this is the user's own structure, not a leak).
    return reply.code(r.reason === 'denied' ? 404 : 422).send({ error: 'transclude not available', reason: r.reason })
  })

  // PlantUML render (#140 / ADR-074): host-mediated server render of a plantuml fence's source via
  // the operator's Kroki/PlantUML endpoint. page-view gated (member or view-guest). 200 image/png on
  // success; 204 = degrade-to-source (unconfigured / endpoint failure) so the macro shows the fence.
  app.post<{ Params: { pageId: string }; Body: { source?: string; theme?: string } }>('/pages/:pageId/plantuml/render', { config: { guest: 'view' } }, async (req, reply) => {
    const { subject, context } = principalForPage(req, req.params.pageId)
    await assertPageViewable(app.fga, subject, req.params.pageId, context) // 404 not-found if not a viewer (#280)
    const source = req.body?.source
    if (typeof source !== 'string' || !source.trim()) return reply.code(400).send({ error: 'source is required' })
    const png = await renderPlantuml(source, { dark: req.body?.theme === 'dark' }) // #342: dark → built-in !theme
    if (!png) return reply.code(204).send() // degrade: caller renders the source fence
    return reply.header('content-type', 'image/png').send(png)
  })

  // ── per-page access (manage-gated; member-only, no guest config) ──────────
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/access', async (req) => {
    return listPageAccess(app.fga, req.db, { pageId: req.params.pageId, tenantId: req.tenant.id, userId: req.user.sub })
  })

  // grantee = user:<sub> | group:<id>#member (raw), OR groupName (#163: server resolves to
  // group:<id>#member via groupGrantee → matches #111's sync id exactly).
  app.post<{ Params: { pageId: string }; Body: { grantee?: string; groupName?: string; relation: string } }>('/pages/:pageId/access', async (req, reply) => {
    const grantee = req.body?.groupName ? groupGrantee(req.tenant.id, req.body.groupName) : (req.body?.grantee ?? '')
    await grantPageAccess(req.db, app.fga, app.searchDriver, {
      pageId: req.params.pageId, tenantId: req.tenant.id, userId: req.user.sub,
      grantee, relation: req.body?.relation ?? '', plan: req.tenant.plan,
    })
    return reply.code(204).send()
  })

  app.delete<{ Params: { pageId: string }; Body: { grantee?: string; groupName?: string; relation: string } }>('/pages/:pageId/access', async (req, reply) => {
    const grantee = req.body?.groupName ? groupGrantee(req.tenant.id, req.body.groupName) : (req.body?.grantee ?? '')
    await revokePageAccess(req.db, app.fga, app.searchDriver, {
      pageId: req.params.pageId, tenantId: req.tenant.id, userId: req.user.sub,
      grantee, relation: req.body?.relation ?? '', plan: req.tenant.plan,
    })
    return reply.code(204).send()
  })

  // #109 / ADR-072 monotonic deny — restrict/unrestrict a principal from a page (manage-gated). The
  // deny list is distinct from the grant list; a restricted principal 404s on the page even as a
  // space viewer. principal = user:<sub> | group:<id>#member (raw) OR groupName (#163 resolved).
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/restrict', async (req) => {
    return listPageRestrictions(app.fga, { pageId: req.params.pageId, userId: req.user.sub })
  })
  app.post<{ Params: { pageId: string }; Body: { principal?: string; groupName?: string } }>('/pages/:pageId/restrict', async (req, reply) => {
    const principal = req.body?.groupName ? groupGrantee(req.tenant.id, req.body.groupName) : (req.body?.principal ?? '')
    await restrictPageAccess(req.db, app.fga, app.searchDriver, {
      pageId: req.params.pageId, tenantId: req.tenant.id, userId: req.user.sub, principal, plan: req.tenant.plan,
    })
    return reply.code(204).send()
  })
  app.delete<{ Params: { pageId: string }; Body: { principal?: string; groupName?: string } }>('/pages/:pageId/restrict', async (req, reply) => {
    const principal = req.body?.groupName ? groupGrantee(req.tenant.id, req.body.groupName) : (req.body?.principal ?? '')
    await unrestrictPageAccess(req.db, app.fga, app.searchDriver, {
      pageId: req.params.pageId, tenantId: req.tenant.id, userId: req.user.sub, principal, plan: req.tenant.plan,
    })
    return reply.code(204).send()
  })

  // #109 / ADR-098 — per-page PRIVATE (allowlist) toggle (manage-gated). POST makes the page private
  // (space inheritance cut + public stripped); DELETE clears it (space inheritance resumes). The allow
  // list is the existing grant/revoke path (POST/DELETE /pages/:id/access). GET reports the flag.
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/private', async (req) => {
    return { private: await isPagePrivate(app.fga, { pageId: req.params.pageId, userId: req.user.sub }) }
  })
  app.post<{ Params: { pageId: string } }>('/pages/:pageId/private', async (req, reply) => {
    await setPagePrivate(req.db, app.fga, app.searchDriver, {
      pageId: req.params.pageId, tenantId: req.tenant.id, userId: req.user.sub, plan: req.tenant.plan,
    })
    return reply.code(204).send()
  })
  app.delete<{ Params: { pageId: string } }>('/pages/:pageId/private', async (req, reply) => {
    await unsetPagePrivate(req.db, app.fga, app.searchDriver, {
      pageId: req.params.pageId, tenantId: req.tenant.id, userId: req.user.sub, plan: req.tenant.plan,
    })
    return reply.code(204).send()
  })
  // #253 / ADR-113: per-page anonymous public toggle. GET = current state (manage-gated). POST makes it
  // public — but ONLY while the tenant parent switch is ON (guardrail 1: OFF ⇒ 403, a second layer over the
  // hidden UI so the API is the fortress). DELETE (make non-public) is always allowed — revoking is safe.
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/public', async (req) => {
    // `public` = this page's OWN grant (the toggle's state). #253 review: also report `effectivePublic`
    // whether an anonymous reader can actually reach the page (its own grant OR via a PUBLIC SPACE), so the
    // UI can warn "publicly reachable via space" when the own toggle reads OFF but the page is world-readable.
    const own = await isPagePublic(app.fga, { pageId: req.params.pageId, userId: req.user.sub })
    const effectivePublic = await check(app.fga, 'user:anonymous', 'view', { type: 'page', id: req.params.pageId })
    return { public: own, effectivePublic }
  })
  app.post<{ Params: { pageId: string } }>('/pages/:pageId/public', async (req, reply) => {
    if (!(await publicSurfaceEnabled(req.db))) throw Object.assign(new Error('public surface disabled for this tenant'), { statusCode: 403 })
    await setPagePublic(req.db, app.fga, app.searchDriver, {
      pageId: req.params.pageId, tenantId: req.tenant.id, userId: req.user.sub, plan: req.tenant.plan,
    })
    return reply.code(204).send()
  })
  app.delete<{ Params: { pageId: string } }>('/pages/:pageId/public', async (req, reply) => {
    await unsetPagePublic(req.db, app.fga, app.searchDriver, {
      pageId: req.params.pageId, tenantId: req.tenant.id, userId: req.user.sub, plan: req.tenant.plan,
    })
    return reply.code(204).send()
  })
  // #253 / ADR-113 (guardrail 1): the tenant PARENT SWITCH, admin-only (mirrors /admin/ai-settings). GET =
  // current state (drives the hidden-toggle UI); PUT flips it. The switch is the tenant-wide master gate for
  // the whole anonymous public surface (read-time gate in publicPlugin).
  app.get('/admin/public-settings', async (req, reply) => {
    const ok = await app.fga.check({ user: `user:${req.user.sub}`, relation: 'admin', object: `tenant:${req.tenant.id}` })
    if (!ok.allowed) return reply.code(403).send({ error: 'admin only' })
    return { publicEnabled: await publicSurfaceEnabled(req.db) }
  })
  app.put<{ Body: { enabled?: boolean } }>('/admin/public-settings', async (req, reply) => {
    const ok = await app.fga.check({ user: `user:${req.user.sub}`, relation: 'admin', object: `tenant:${req.tenant.id}` })
    if (!ok.allowed) return reply.code(403).send({ error: 'admin only' })
    if (typeof req.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled (boolean) required' })
    await setTenantPublicEnabled(req.db, req.tenant.id, req.body.enabled)
    return { publicEnabled: req.body.enabled }
  })
}
