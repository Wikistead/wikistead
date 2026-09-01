import * as Y from 'yjs'
import type { Sql } from 'postgres'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, checkRelation, checkMemberAccess, filterAuthorized, writeTuples, deleteTuples, deleteObjectTuples, readObjectTuples, readObjectTuplesPage, readUserTuplesByType, requireTenantAdmin, isAlreadyConverged, runInAuthzScope, SYSTEM_SCOPE, currentAuthzScope } from '@wikistead/authz'
import { emit } from '@wikistead/events'
import { getCachedTitleDict, setCachedTitleDict, titleDictGeneration, beginTitleDictFill, endTitleDictFill } from '../title-dict-cache.js' // #534
import { getTreeConfirm, setTreeConfirm, getCachedBadge, setCachedBadge, invalidatePageBadge } from '../tree-confirm-cache.js' // #541
import { docName } from '@wikistead/types'
import { resolveDirectiveRanges } from '@wikistead/macro-render' // #353: scan `:::query` blocks for the anon snapshot
import { enqueueOutbox, processOutboxAsync } from '../search/index.js'
import { DICT_CHANNEL_PREFIX } from '../search/outbox.js' // #534 the background fill pings clients on the same channel
import type { SearchDriver } from '../search/index.js'
import { resolveAuthorIdentities, authorFields } from '../author-identity.js' // #486 / ADR-150 Addendum 2
import { collectPageViewEvent } from '../analytics/sink.js' // #464 / ADR-175, behind the seam since #688
import { resolveEntitlements } from '@wikistead/entitlements' // #464: EE gate for the analytics dashboard
import type { StorageDriver } from '../storage/index.js'
import { storeRevisionYdoc } from './revision-ydoc.js'
import { resolveTreePlaceholders, resolveGuestPlaceholders, PLACEHOLDER_NODE_MAX, type PlaceholderNode } from './tree-placeholders.js' // #623 / ADR-220 §4, §14
import type { TenantDb } from '../db/index.js'
import { pool, registry, acquireTenantDb, listActiveTenantIds } from '../db/index.js' // #411: cross-tenant trash retention sweep
import { flushDraft } from '../collab-flush.js'
import { countTodoTasks } from '../task-progress.js' // #290: :::todo aggregate for the sidebar ring
import { evaluatePublishAbuse } from '../abuse-filter.js' // #328 / ADR-140: publish-boundary abuse filter
import { getEffectiveAbusePolicyForSpace } from './abuse-config.js' // #509 / ADR-187: tenant floor ⊕ space layer
import { recordAbuseFlag } from './notifications.js' // #326 / ADR-142 Addendum 2: patrol flags at the refusal boundaries

// #326: a flag names its actor the same way every other feed row does — the guest's session pseudonym
// when there is one, else the link. Using the link id alone would both break the join with that
// guest's ordinary activity and make the throttle per-LINK, so one guest's refusal would mute the
// flags of everyone else editing through the same link.
function abuseActor(req: { guest?: { shareLinkId: string; anonId?: string | null } | null }, fallback: string): string {
  const g = req.guest
  if (!g) return fallback
  return g.anonId ?? `guest:${g.shareLinkId}` // the convention guestCreatePublishPage uses (:349)
}
import { guestPublishRateAllowed, guestCreatePageRateAllowed } from '../abuse-rate.js' // #328 / #274: guest publish + create caps
import { groupGrantee, groupNameByFgaId, resolveGroupName } from '../auth/group-sync.js'
import { listAllGroupNames } from './spaces.js' // #623: the one bounded group-name query
import { auditIfEntitled } from '../audit/sink.js'
import { resolveEmbed, EmbedDeniedError } from '../embed-resolve.js'
import { checkFrameability, EmbedFrameabilityDeniedError } from '../embed-frameability.js'
import { resolveTranscludeRef } from '../transclude-resolve.js'
import { renderPlantumlResult } from '../plantuml-render.js'
import { assertPageViewable } from '../page-view-gate.js'
import { revokeResourceShareLinks } from './share-links.js'
import { getTemplate } from './templates.js'
import { getSpaceInfo, searchMemberCandidates } from './spaces.js'
import { deletePinsForResources } from './pins.js'
import { fanOutFeedEvent, sweepWatchesForResources, sweepUnviewableWatches } from './notifications.js'
import { enqueueWebhookOutbox } from './webhooks.js'
import { assertGranteeIsMember } from '../auth/member-principal.js' // #624: a grant names somebody who is here
import { requireBody } from './require-body.js' // #667 a bodyless write is 400, not 500
import { pageEventDisposition } from '../page-disposition.js' // #862 / ADR-108 §G: read before the act destroys the answer

// #108 bounce: normalise an admin-supplied external-embed allowlist into bare, lowercase hostnames —
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
  // Raw FGA check — `admin` on `tenant:` isn't a capability the `check` helper maps; the tenant-admin
  // relation is checked directly. NOT folded into the shared `requireTenantAdmin` (#383) on purpose:
  // this gate returns 'forbidden', not 'admin only' — folding would change the error shape.
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
export interface Page { id: string; tenantId: string; spaceId: string; parentId: string | null; title: string; position: number; createdAt: Date; updatedAt: Date; capability?: 'view' | 'edit'; hasUnpublishedChanges?: boolean; published?: boolean; canManage?: boolean; canModerate?: boolean; canComment?: boolean; private?: boolean; frozen?: 'full' | 'guests' | null; createdBy?: string | null; updatedBy?: string | null; taskDone?: number; taskTotal?: number;
  // #486 / ADR-150 Addendum 2: the author display name/avatar, resolved server-side on this ALREADY
  // view-gated response (getPage is member-only, 404 on deny). `…Name` = override ?? OIDC name (null =
  // un-customized member / cross-tenant / guest author — the client keeps its own short label); `…HasAvatar`
  // drives the uploaded-avatar chip. Present only on getPage (not the tree list, which never selects authors).
  createdByName?: string | null; createdByHasAvatar?: boolean; updatedByName?: string | null; updatedByHasAvatar?: boolean }
function toPage(r: PageRow): Page {
  // hasUnpublishedChanges + published are only present when the SELECT included the
  // columns (listPages); together they drive the sidebar's 3-state badge
  // (Draft / Published / Unpublished changes). `published` is a cheap check
  // (published_at IS NOT NULL) — the heavy published_md is not read for the tree.
  // #222: createdBy/updatedBy (author subs) are present only when the SELECT included them (getPage) —
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

// A gap is COLLAPSED when the midpoint between two neighbours is not STRICTLY between them —
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
  args: { tenantId: string; spaceId: string; userId: string; title?: string; parentId?: string | null; fromPageId?: string | null; templateId?: string | null;
    // #364 / ADR-157: compose an extra write into the SAME create transaction (the space-home endpoint
    // sets `spaces.home_page_id` here so "create the page + point the space at it" is atomic; a throw
    // rolls the page insert back). Runs before the FGA writes; PG-only work belongs here.
    onCreatedInTx?: (tx: Parameters<Parameters<TenantDb['tx']>[0]>[0], pageId: string) => Promise<void> },
): Promise<Page> {
  // Destination gate FIRST: creating a page here needs `edit` on the space. This runs BEFORE any
  // template resolution, so a template-seeded create can never bypass the destination's authz (a
  // non-editor gets 403 regardless of any templateId/fromPageId they pass).
  const canEdit = await check(fga, `user:${args.userId}`, 'edit', { type: 'space', id: args.spaceId })
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  // #399 / ADR-158 §3: the page-creation POLICY knob, checked INSIDE the chokepoint (right after the
  // FGA gate — binding condition) so duplicate/template/import/MCP creates are covered
  // uniformly. RESTRICT-ONLY: 'managers' additionally requires space manage; FGA stays the granter.
  const [policyRow] = await db.sql<[{ page_creation_policy: string }?]>`
    SELECT page_creation_policy FROM spaces WHERE id = ${args.spaceId}`
  if (policyRow?.page_creation_policy === 'managers') {
    const canManage = await check(fga, `user:${args.userId}`, 'manage', { type: 'space', id: args.spaceId })
    if (!canManage) throw Object.assign(new Error('page creation is restricted to space managers'), { statusCode: 403, reason: 'page_creation_policy' })
  }

  // Seed the new page's DRAFT content. Two sources, both view-gated and existence-hidden (404):
  //   #250 templateId — a `templates` snapshot (view = manage or space/tenant audience); title defaults
  //                      to the template name. This is the real template system.
  //   #229 fromPageId — "duplicate a page": any page the creator can VIEW; its PUBLISHED md is the body.
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
    const [p] = await db.sql<{ space_id: string; deleted_at: Date | null }[]>`SELECT space_id, deleted_at FROM pages WHERE id = ${parentId}`
    // A trashed parent is refused with the SAME error as an absent one (#411 — the trash hides existence).
    if (!p || p.deleted_at || p.space_id !== args.spaceId) throw Object.assign(new Error('parent not in space'), { statusCode: 400 })
    // #364 / ADR-157 §3: the space HOME is a LEAF (v1) — no children under it. Keeps the root-listing
    // exclusion trivially sound and the `_home.md` flat export lossless.
    const [homeRow] = await db.sql<[{ home_page_id: string | null }?]>`SELECT home_page_id FROM spaces WHERE id = ${args.spaceId}`
    if (homeRow?.home_page_id === parentId) throw Object.assign(new Error('the space home is a leaf (v1) — pages cannot be created under it'), { statusCode: 400 })
    // #218 / ADR-103 (comment 996 decision 3): cap nesting depth so the inherited-authz parent chain stays
    // resolvable under OpenFGA's resolution-depth limit. The new leaf's depth = parent depth + 1.
    if ((await ancestorDepth(db.sql, parentId)) + 1 > MAX_PAGE_DEPTH) {
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
    if (args.onCreatedInTx) await args.onCreatedInTx(tx, r!.id) // #364: atomic composition (throw → rollback)
    // Visibility gate (Phase 4): a new page is a DRAFT — do NOT link it to its
    // space (no `page#space`), so space members do NOT inherit access. Grant the
    // CREATOR direct `manage` instead. publishPage writes `page#space` to release
    // space inheritance. Until then the draft is visible only to the creator + any
    // explicitly-granted users (page direct grants).
    await writeTuples(fga, [
      // #218 / ADR-103: `manage` is purely computed now → write the creator grant to the manage_direct LEAF.
      { user: `user:${args.userId}`, relation: 'manage_direct', object: `page:${r.id}` },
      // #218 / ADR-103: structural page#parent tuple — the model now cascades private/grants down it. A new
      // page is a leaf, so it can never introduce a parent cycle.
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

// #274 / ADR-135 §3: a space-EDIT-link guest CREATES a page — created PUBLISHED, atomically. The draft
// model makes guest drafts impossible-by-construction (an unpublished draft is creator-only via a
// manage_direct grant, and share_link principals have no manage path and no per-guest identity to grant),
// so the row + `page#space` + the `published` marker pair + an (empty) publish snapshot land in ONE
// operation. The guest then co-edits over the normal collab path and publishes content like any editor.
//   - authz: FGA `edit` on the space (share_link → space#editor, with current_time for expiry) — the
//     exact gate createPage uses for members. No resource pre-binding (#397: FGA is the sole authority).
//   - attribution: pages/revisions record the #331 anon session id (`anon:<12hex>`), never a member sub,
//     so #327 per-actor revert and patrol group the guest's pages exactly like their edits.
//   - NO manage_direct grant: a guest owns nothing — edit flows from space#editor via edit_from_space
//     once page#space exists (which is written here, atomically). Deletion stays manage-gated (ADR §3).
//   - seeds: templateId/fromPageId are member-only (template#view has no share_link path; the route never
//     forwards them for a guest) — a guest page always starts empty.
export async function guestCreatePublishPage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  storage: StorageDriver,
  args: { tenantId: string; spaceId: string; shareLinkId: string; anonId?: string; title?: string; parentId?: string | null },
): Promise<Page> {
  const subject = `share_link:${args.shareLinkId}`
  const createdBy = args.anonId ?? `guest:${args.shareLinkId}`
  const context = { current_time: new Date().toISOString() }
  const canEdit = await check(fga, subject, 'edit', { type: 'space', id: args.spaceId }, context)
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  // #399 / ADR-158 §3: the page-creation policy covers this route too ("by any means") — a space
  // edit share-link (#274/ADR-135) is a live guest CREATE path, and a guest is never a space
  // manager, so 'managers' closes guest creation outright. Same static reason as the member gate.
  const [guestPolicyRow] = await db.sql<[{ page_creation_policy: string }?]>`
    SELECT page_creation_policy FROM spaces WHERE id = ${args.spaceId}`
  if (guestPolicyRow?.page_creation_policy === 'managers') {
    throw Object.assign(new Error('page creation is restricted to space managers'), { statusCode: 403, reason: 'page_creation_policy' })
  }

  const parentId = args.parentId ?? null
  if (parentId) {
    // Same structural rules as the member path (same space, bounded depth) PLUS a guest must be able
    // to VIEW the parent (404 = existence-hiding): without this, a guest could probe/attach under a
    // private or draft page's id that the member path merely requires to exist.
    const canViewParent = await check(fga, subject, 'view', { type: 'page', id: parentId }, context)
    if (!canViewParent) throw Object.assign(new Error('not found'), { statusCode: 404 })
    const [p] = await db.sql<{ space_id: string }[]>`SELECT space_id FROM pages WHERE id = ${parentId}`
    if (!p || p.space_id !== args.spaceId) throw Object.assign(new Error('parent not in space'), { statusCode: 400 })
    if ((await ancestorDepth(db.sql, parentId)) + 1 > MAX_PAGE_DEPTH) {
      throw Object.assign(new Error(`max nesting depth (${MAX_PAGE_DEPTH}) exceeded`), { statusCode: 400 })
    }
  }
  const [{ pos }] = await db.sql<[{ pos: number | null }]>`
    SELECT MAX(position) AS pos FROM pages
    WHERE space_id = ${args.spaceId} AND parent_id IS NOT DISTINCT FROM ${parentId}
  `
  const position = positionBetween(pos, null)

  // S3-FIRST (ADR-062): the empty publish snapshot's revision bytes go to storage before the tx, so a
  // put failure aborts cleanly with no dangling row.
  const emptyYdoc = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()))
  const ydocKey = await storeRevisionYdoc(storage, args.tenantId, emptyYdoc)
  const listSnapshot = JSON.stringify({ v: 1, blocks: [] }) // empty content has no ::: list directives

  let outboxId!: string
  let revisionId!: string
  const row = await db.tx(async (tx) => {
    const [r] = await tx<PageRow[]>`
      INSERT INTO pages (tenant_id, space_id, parent_id, title, position, created_by,
                         published_md, published_at, has_unpublished_changes, task_done, task_total, published_query_snapshot)
      VALUES (${args.tenantId}, ${args.spaceId}, ${parentId}, ${args.title ?? ''}, ${position}, ${createdBy},
              ${''}, now(), false, 0, 0, ${listSnapshot}::jsonb)
      RETURNING id, tenant_id, space_id, parent_id, title, position, created_at, updated_at,
                (published_at IS NOT NULL) AS published, created_by, has_unpublished_changes, task_done, task_total
    `
    const [rev] = await tx<[{ id: string }]>`
      INSERT INTO revisions (tenant_id, page_id, ydoc_key, title, created_by)
      VALUES (${args.tenantId}, ${r.id}, ${ydocKey}, ${r.title}, ${createdBy})
      RETURNING id
    `
    revisionId = rev.id
    await tx`UPDATE pages SET published_revision_id = ${rev.id} WHERE id = ${r.id}`
    // The atomic release: page#space + the published marker pair (+ the structural parent tuple) INSIDE
    // the tx — an FGA failure rolls the row back, so a guest page is never left as an unreachable draft.
    await writeTuples(fga, [
      { user: `space:${args.spaceId}`, relation: 'space', object: `page:${r.id}` },
      ...PUBLISHED_MARKERS(r.id),
      ...(parentId ? [{ user: `page:${parentId}`, relation: 'parent', object: `page:${r.id}` }] : []),
    ])
    outboxId = await enqueueOutbox(tx, { tenantId: args.tenantId, pageId: r.id, operation: 'upsert' })
    // #228 / ADR-108: a guest-created page is published from birth — it is webhook-visible immediately.
    await enqueueWebhookOutbox(tx, { tenantId: args.tenantId, eventType: 'page.published', payload: { pageId: r.id, revisionId: rev.id, actorId: createdBy, occurredAt: new Date().toISOString() } })
    // #320 / ADR-126: feed + watcher fan-out (space watchers learn about the new guest page).
    await fanOutFeedEvent(tx, { tenantId: args.tenantId, eventType: 'page.published', pageId: r.id, spaceId: args.spaceId, actor: createdBy, publishedAt: new Date() })
    return r
  })
  const page = toPage(row as PageRow)
  processOutboxAsync(driver, outboxId, { tenantId: args.tenantId, pageId: page.id, operation: 'upsert' })
  emit({ type: 'page.created', tenantId: args.tenantId, pageId: page.id, spaceId: args.spaceId, actorId: createdBy })
  emit({ type: 'page.published', tenantId: args.tenantId, pageId: page.id, revisionId, actorId: createdBy })
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
  args: { spaceId: string; subject: string; context?: { current_time: string }; firstN?: number },
): Promise<Page[]> {
  // #364 / ADR-157 §4: the home renders AT the space root, so the tree (member AND the shared #245
  // guest route) skips it — the one root-listing exclusion. Pins/search/overview deliberately include it.
  const rows = await db.sql<PageRow[]>`
    SELECT p.id, p.tenant_id, p.space_id, p.parent_id, p.title, p.position, p.created_at, p.updated_at,
           p.has_unpublished_changes, (p.published_at IS NOT NULL) AS published, p.task_done, p.task_total
    FROM pages p JOIN spaces s ON s.id = p.space_id
    WHERE p.space_id = ${args.spaceId} AND p.deleted_at IS NULL
      AND (s.home_page_id IS NULL OR p.id != s.home_page_id)
    ORDER BY p.position, p.created_at
  `
  // #541: the tree is what the sidebar's first paint waits for, so its confirm takes the same bounded
  // lanes the title dictionary does (#534) — 4, clamped in filterAuthorized. A 197-page space is 4
  // batch waves; sequentially that is most of a second on a busy checker, for a surface that IS the
  // boot path (the dictionary at least was only an enhancement).
  //
  // follow-up: the confirm set is also CACHED per (tenant, viewer, space) for a few seconds —
  // the tree-confirm-cache header carries the safety argument (same discipline, same invalidation and
  // generation as the #534 dict cache). Pages the entry has never seen (created since) are confirmed
  // as a DELTA against FGA — never assumed; a cached deny stays hidden for at most the TTL, within the
  // same trusted-invalidation window the dictionary already accepts.
  const tenantId = rows[0]?.tenant_id
  // Design review (#541): GUESTS NEVER RIDE THIS CACHE. A share_link's revoke is one tuple delete and
  // the contract is INSTANT (ADR-028) — but revoke does not travel the reindex outbox, so no
  // invalidation reaches this cache and a revoked link would keep reading the tree for up to the TTL
  // (reproduced in review). The same bypass closes the `non_expired` Condition hole: the cache key
  // carries no current_time, so an expiring link could outlive its clock. Members are covered — their
  // permission changes ride reindex (revoke/restrict/private/member-removal all enqueue), which fires
  // the invalidation below.
  // #637 / ADR-216 §6: NOR DOES A CONFINED PRINCIPAL. This entry is keyed by tenant and subject, and an
  // API key's subject is its OWNER — so a key confined to one space would be handed the answer the owner
  // warmed for the whole tenant, before any primitive is consulted. The same reasoning as the guest line
  // above: a cache that answers "what this principal may see" has to be keyed by everything that changes
  // the answer, and the confinement is not in the key. Not caching is the cheap correct move — a confined
  // key is an integration, not a person clicking around a sidebar.
  const cacheable = !!tenantId && !args.subject.startsWith('share_link:') && !args.context
    && currentAuthzScope()?.restriction == null
  const cached = cacheable ? getTreeConfirm(tenantId!, args.subject, args.spaceId) : undefined
  // #541 (user ruling): the sidebar must not wait for ALL confirms before painting — the cold
  // cost is count-proportional (~7ms × pages) and no supply-side lever moves it. `firstN` asks for a
  // PARTIAL first paint: the first N rows in DISPLAY (DFS) order are confirmed — each id still goes
  // through the same FGA gate, a deny inside the window is dropped, never backfilled — badges are
  // skipped entirely (display glyphs, injected by the full response moments later), and the confirm
  // cache is neither read as authority nor WRITTEN (a partial set must not masquerade as the space's
  // confirm set). One exception: a WARM full cache is cheaper than any partial — serve full instead.
  if (args.firstN != null && !(cached && rows.every((r) => cached.has(r.id)))) {
    const firstIds = dfsOrder(rows).slice(0, Math.max(1, args.firstN))
    const allowedFirst = await filterAuthorized(fga, args.subject, 'view', firstIds, args.context, 'page', 4)
    const visibleFirst = rows.filter((r) => allowedFirst.has(r.id))
    return visibleFirst.map((r) => ({ ...toPage(r), private: false, frozen: null }))
  }
  let allowed: Set<string>
  if (cached) {
    const delta = rows.filter((r) => !cached.has(r.id))
    const deltaAllowed = delta.length > 0
      ? await filterAuthorized(fga, args.subject, 'view', delta.map((r) => r.id), args.context, 'page', 4)
      : new Set<string>()
    for (const r of delta) cached.set(r.id, deltaAllowed.has(r.id))
    allowed = new Set(rows.filter((r) => cached.get(r.id) === true).map((r) => r.id))
  } else {
    const gen = tenantId ? titleDictGeneration(tenantId) : undefined
    allowed = await filterAuthorized(fga, args.subject, 'view', rows.map((r) => r.id), args.context, 'page', 4)
    if (cacheable) setTreeConfirm(tenantId!, args.subject, args.spaceId, new Map(rows.map((r) => [r.id, allowed.has(r.id)])), Date.now(), gen)
  }
  const visible = rows.filter((r) => allowed.has(r.id))
  // #109 Fix B / #329: annotate each visible page with its private flag (lock badge) and freeze level
  // (snowflake). A read fault falls back to "no badge" — never a false lock.
  //
  // #541: these used to be THREE fga.read calls per page (private, frozen, frozen_guests), all fired at
  // once — a 197-page tree put ~600 concurrent point reads on the checker on every sidebar load, which
  // both slowed this response and starved every other authorization consumer of the page-open burst.
  // One read per page now returns the page's whole tuple set and both badges are derived from it, and
  // the fan-out is bounded so the tree never monopolises the store it is reading from.
  // #541 part 6: badge reads ride the same short cache (display-only glyphs — see tree-confirm-cache).
  const badges = await mapBounded(visible, 16, async (r) => {
    const hit = tenantId ? getCachedBadge(tenantId, r.id) : undefined
    if (hit) return hit
    const fresh = await readPageBadges(fga, r.id).catch(() => ({ private: false, frozen: null as PageFreezeLevel | null }))
    if (tenantId) setCachedBadge(tenantId, r.id, fresh)
    return fresh
  })
  return visible.map((r, i) => ({ ...toPage(r), private: badges[i]!.private, frozen: badges[i]!.frozen }))
}

// #541: the sidebar's DISPLAY order — a DFS over the parent tree with siblings in (position,
// created_at) order, which is exactly how the client lays the rows out. "The first N rows" for the
// partial first paint means the first N a user would actually see. Rows whose parent is missing from
// the set (the excluded home page, a deleted ancestor) count as roots, matching the client's fallback.
function dfsOrder(rows: readonly PageRow[]): string[] {
  const byParent = new Map<string | null, PageRow[]>()
  const ids = new Set(rows.map((r) => r.id))
  for (const r of rows) {
    const key = r.parent_id != null && ids.has(r.parent_id) ? r.parent_id : null
    const list = byParent.get(key)
    if (list) list.push(r)
    else byParent.set(key, [r])
  }
  const out: string[] = []
  const walk = (parent: string | null) => {
    for (const r of byParent.get(parent) ?? []) {
      out.push(r.id)
      walk(r.id)
    }
  }
  walk(null)
  return out
}

// Run `fn` over `items` with at most `limit` in flight. Order-preserving. (#541 — the tree's badge
// reads; small and local on purpose, not a new utility surface.)
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// #541: both sidebar badges from ONE paginated read of the page's tuple set (the markers are direct
// tuples on the page object). Answers exactly what readPagePrivate/readPageFrozen answer — user:* private
// marker; frozen beats frozen_guests — without three round-trips per page. Paginated so a page carrying
// many direct grants cannot silently truncate a marker out of the answer.
async function readPageBadges(fga: OpenFgaClient, pageId: string): Promise<{ private: boolean; frozen: PageFreezeLevel | null }> {
  const relations = new Set<string>()
  let continuationToken: string | undefined
  do {
    const res = await fga.read({ object: `page:${pageId}` }, continuationToken ? { continuationToken } : undefined)
    for (const { key } of res.tuples ?? []) {
      if (key) relations.add(`${key.relation}@${key.user}`)
    }
    continuationToken = res.continuation_token || undefined
  } while (continuationToken)
  return {
    private: relations.has('private@user:*'),
    frozen: relations.has('frozen@user:*') ? 'full' : relations.has('frozen_guests@share_link:*') ? 'guests' : null,
  }
}

export async function getPage(db: TenantDb, fga: OpenFgaClient, args: { pageId: string; userId: string }): Promise<Page> {
  // Resolve view AND edit in one batch: the web uses `capability` to decide whether
  // to offer the Edit control. This is convenience only — the collab server is the
  // fortress (it re-derives readOnly from FGA per document, so a forged edit button
  // still cannot write). null = no view access at all → 403.
  const access = await checkMemberAccess(fga, args.userId, { type: 'page', id: args.pageId })
  // #262: existence-hiding on the READ/DISPLAY path — "no view access" and "no such page" return the SAME
  // 404 so a member can't tell a page they lack access to from one that doesn't exist (a "no permission" reply leaks
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
  // #330 / ADR-141: canModerate gates the moderation affordances (freeze control, patrol, revert) for a
  // moderator who is NOT a manager. Convenience only — every moderation route re-checks FGA (requireModerate).
  const canModerate = canManage || (await check(fga, `user:${args.userId}`, 'moderate', { type: 'page', id: args.pageId }))
  // canComment gates the comment COMPOSER (#100, re-ruled by #553/ADR-199): true for an explicit
  // comment grant, manage/moderate, or the comment_open audience — edit alone no longer implies it.
  // comment is a distinct capability the UI needs to show the composer to comment-capable viewers.
  // Convenience only — the comment routes re-check FGA (the fortress), so a forged composer can't post.
  const canComment = await check(fga, `user:${args.userId}`, 'comment', { type: 'page', id: args.pageId })
  // #109 Fix B: private flag drives the lock badge next to the title (visible to any viewer of the page).
  const isPrivate = await readPagePrivate(fga, args.pageId)
  // #329 / ADR-139: freeze level drives the freeze badge + the permissions-dialog control state. Shown to
  // any viewer (freeze only removes access — the flag reveals nothing; non-viewers 404 above). A frozen
  // member's `capability` already resolves to 'view' via checkMemberAccess (the model subtracts edit).
  const frozen = await readPageFrozen(fga, args.pageId)
  // #486 / ADR-150 Addendum 2: attach the author display identity. This is a VIEW-GATED response (the 404
  // above is the fortress), the subs are SERVER-STORED (created_by/updated_by — not client-supplied), and
  // the resolve runs on the caller's RLS handle `db` (cross-tenant/deleted → absent → null). Full
  // resolution (override ?? OIDC name) is correct here; the customized-only rule is only for the arbitrary-
  // sub /members/identities resolver. R3: this is AFTER the access gate, on the single surviving row.
  const authorIds = await resolveAuthorIdentities(db, [row.created_by, row.updated_by].filter((s): s is string => s != null))
  const createdByA = authorFields(authorIds, row.created_by)
  const updatedByA = authorFields(authorIds, row.updated_by)
  return { ...toPage(row), capability: access.readOnly ? 'view' : 'edit', canManage, canModerate, canComment, private: isPrivate, frozen,
    createdByName: createdByA.name, createdByHasAvatar: createdByA.hasAvatar, updatedByName: updatedByA.name, updatedByHasAvatar: updatedByA.hasAvatar }
}

// Update title. Outbox entry written in the same tx as the UPDATE.
export async function updatePage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  // Member (userId) or an EDIT-capability share-link guest (#274 guests create pages named
  // "Untitled", so naming must work for them like it does for members — the same FGA edit gate that
  // already lets them rewrite the whole body, with current_time for expiry; actor attribution = anonId).
  args: { pageId: string; userId?: string; guest?: { shareLinkId: string; anonId?: string }; title: string },
): Promise<Page> {
  const subject = args.userId ? `user:${args.userId}` : `share_link:${args.guest!.shareLinkId}`
  const context = args.userId ? undefined : { current_time: new Date().toISOString() }
  const canEdit = await check(fga, subject, 'edit', { type: 'page', id: args.pageId }, context)
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  // #364 a space HOME's title is derived from the space name and locked — the server is the
  // fortress (the UI also hides the rename affordance, but hiding alone is not a defense). Body,
  // publish, history and collab stay fully regular; the title is the single exception (ADR-157 add.).
  const [homeOf] = await db.sql<[{ id: string }?]>`SELECT id FROM spaces WHERE home_page_id = ${args.pageId}`
  if (homeOf) throw Object.assign(new Error('the home page title is derived from the space name'), { statusCode: 400 })

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
  emit({ type: 'page.renamed', tenantId: page.tenantId, pageId: page.id, actorId: args.userId ?? args.guest!.anonId ?? `guest:${args.guest!.shareLinkId}` })
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
  // #326 / ADR-142 Addendum 2: `onAbuseReject` lets the caller record a patrol flag for a refusal.
  // Optional and best-effort — the 422 is the contract; the flag is a bonus the route wires in.
  args: { pageId: string; subject: string; createdBy: string; context?: { current_time: string }; onAbuseReject?: (reason: string, spaceId: string) => void },
): Promise<{ publishedAt: Date | null; revisionId: string | null; noop: boolean }> {
  // #420 3b: the PUBLISH verb (its edit_live superset feeder keeps every edit holder — member or
  // edit-link guest — publishing exactly as before; publish-only grants now pass too).
  const canPublish = await check(fga, args.subject, 'publish', { type: 'page', id: args.pageId }, args.context)
  if (!canPublish) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  const [draft] = await db.sql<[{ tenant_id: string; space_id: string; ydoc: Buffer | null; title: string; published_md: string | null; published_at: Date | null; published_revision_id: string | null }]>`
    SELECT tenant_id, space_id, ydoc, title, published_md, published_at, published_revision_id FROM pages WHERE id = ${args.pageId}
  `
  if (!draft) throw Object.assign(new Error('not found'), { statusCode: 404 })
  const md = decodeYdocContent(draft.ydoc)

  // #328 / ADR-140 + #509 / ADR-187: the publish-boundary abuse filter. The edit gate above has passed; now
  // check the CONTENT against the EFFECTIVE moderation policy = tenant floor ⊕ this space's ADDITIVE layer
  // (banned words UNIONed, shrink ratio the STRICTER of the two — a space can never weaken the floor).
  // Defaults are all-permissive, so this stays a no-op (two cheap SELECTs) until someone opts in. A
  // rejection is a 422 with a STATIC reason code — the CRDT/Y.Text is never touched (decide-only).
  const effective = await getEffectiveAbusePolicyForSpace(db, draft.space_id)
  if (effective.shrinkRatio != null || effective.bannedWords.length > 0) {
    const verdict = evaluatePublishAbuse(draft.published_md, md, effective)
    if (!verdict.ok) {
      // #326: a refused publish is exactly what patrol wants to see — repeated refusals are the vandal
      // signature the ruling asked to surface. Recorded before the throw, from the route's sink, so the
      // 422 the caller receives is unchanged whether or not the flag lands.
      args.onAbuseReject?.(verdict.reason, draft.space_id)
      throw Object.assign(new Error('publish rejected by the abuse filter'), { statusCode: 422, reason: verdict.reason })
    }
  }

  // #353→#370 / ADR-145: bake the anonymous static snapshot for this page's `:::tagged`/`:::children` blocks. Resolved
  // as `user:anonymous` (member-only pages dropped by the per-item view-filter — never in the public snapshot).
  // Refreshed on EVERY publish (incl. the no-op path below): the resolved list depends on OTHER pages' publish/
  // grant state, so a re-publish is the natural refresh point even when THIS page's text is unchanged. Computed
  // BEFORE the tx (like storeRevisionYdoc) — it reads only already-committed pages, never this in-flight update.
  const listSnapshot = JSON.stringify(await bakeListSnapshot(db, fga, { pageId: args.pageId, md }))

  // No-op guard (server is the accurate gate): if the draft text equals what is
  // already published, do NOT create a revision — that would be meaningless history.
  // The UI's enable/disable uses the cheap over-approximated flag; this is the exact
  // check. Reconcile the cheap flag to false so a spurious "unpublished" badge clears.
  // Still RELEASE space inheritance (idempotent) — covers a re-publish and the
  // repair case where a prior publish's page#space write failed; reindex if it wrote.
  if (md === draft.published_md) {
    await db.sql`UPDATE pages SET has_unpublished_changes = false, published_query_snapshot = ${listSnapshot}::jsonb WHERE id = ${args.pageId}`
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
        has_unpublished_changes = false, updated_by = ${args.createdBy.replace(/^user:/, '')},
        task_done = ${tp.done}, task_total = ${tp.total}, published_query_snapshot = ${listSnapshot}::jsonb
      WHERE id = ${args.pageId}
      RETURNING published_at
    `
    publishedAt = p.published_at
    // #322 / ADR-133 §6: refresh this page's outbound link edges from the newly published content, in-tx
    // (derived index moves atomically with published_md). Inert — nothing reads page_links yet.
    await syncPageLinks(tx, draft.tenant_id, args.pageId, md)
    // #370 / ADR-145: refresh the frontmatter-tag projection from the newly published content, in-tx
    // (same discipline — the derived index moves atomically with published_md).
    await syncPageTags(tx, draft.tenant_id, args.pageId, md)
    outboxId = await enqueueOutbox(tx, { tenantId: draft.tenant_id, pageId: args.pageId, operation: 'upsert' })
    // #228 / ADR-108: enqueue the page.published webhook IN this tx (reliable — a commit-then-crash still
    // delivers). Thin payload (ids/actor only). The drain applies the private/draft existence-hiding
    // filter at send time (by then page#space is written below, so a published page is deliverable).
    await enqueueWebhookOutbox(tx, { tenantId: draft.tenant_id, eventType: 'page.published', payload: { pageId: args.pageId, revisionId, actorId: args.createdBy, occurredAt: new Date().toISOString() } })
    // #320 / ADR-126: in-tx feed event + notification fan-out to watchers (page-watch OR space-watch), actor
    // excluded. publishedAt is non-null here (we just published), so the emission guard passes. Set-based, capped.
    await fanOutFeedEvent(tx, { tenantId: draft.tenant_id, eventType: 'page.published', pageId: args.pageId, spaceId: draft.space_id, actor: args.createdBy, publishedAt })
  })
  // AFTER the DB commit (fail-closed: a tx failure above leaves the page gated):
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
  // #830: `to` is the state the caller believes the box is moving TO. Named for that and not `checked`,
  // because the widget's own `checked` is the PRE-click state and one inverted reading is all this
  // comparison would need to go quietly wrong. Optional, so a client that predates this behaves as it
  // did — see the refusal below for what it buys.
  args: { pageId: string; subject: string; createdBy: string; index: number; to?: boolean; context?: { current_time: string } },
): Promise<{ publishedAt: Date | null }> {
  const canEdit = await check(fga, args.subject, 'edit', { type: 'page', id: args.pageId }, args.context)
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  // #361 read → guard → fold now run inside ONE transaction under a per-page advisory lock.
  // With the client no longer serializing toggles (that wait was the sluggishness the owner
  // reported), two folds can overlap; reading the draft OUTSIDE the write would let the slower one
  // commit a snapshot taken before its sibling's fold and silently drop that flip (published loses a
  // tick the user already saw, and the page is left dirty). Serialized here, the second fold re-reads
  // AFTER the first committed and simply finds nothing left to do (a `task_burst` no-op).
  let tenantId!: string
  let draftMd!: string
  let draftStates!: boolean[]
  let outboxId!: string
  let publishedAt!: Date
  await db.tx(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`task:${args.pageId}`})::bigint)`
    const [page] = await tx<[{ tenant_id: string; ydoc: Buffer | null; published_md: string | null; published_at: Date | null }]>`
      SELECT tenant_id, ydoc, published_md, published_at FROM pages WHERE id = ${args.pageId}
    `
    if (!page) throw Object.assign(new Error('not found'), { statusCode: 404 })
    if (page.published_md == null) throw Object.assign(new Error('not published'), { statusCode: 409 })
    tenantId = page.tenant_id
    draftMd = decodeYdocContent(page.ydoc)
    const publishedMd = page.published_md

    // Structural guard: the ONLY difference may be a single checkbox flip at `index`.
    // Equal skeletons ⇒ identical prose AND identically-positioned task items; then the
    // state arrays align 1:1 and only state chars can differ.
    // #361 the two 409s carry DISTINCT static `code`s (the field Fastify's default error
    // serializer already emits, and apiErrorFrom already maps onto ApiError.code — no new plumbing).
    // They share a status but tell different stories: `task_draft_dirty` means real unpublished prose
    // is in the way ("publish first" is the honest advice), while `task_burst` only means a faster
    // click already folded this flip — a transient the client resolves by resyncing, never a reason
    // to undo what the user just saw. Static codes only (the caller already holds edit).
    if (taskSkeleton(draftMd) !== taskSkeleton(publishedMd)) {
      throw Object.assign(new Error('draft has non-checkbox changes; publish them first'), { statusCode: 409, code: 'task_draft_dirty' })
    }
    // #361 (P1, enabled because P0 needs it): the fold takes EVERY pending checkbox flip, not
    // exactly one. Its actual job — stated when it was written — is "no non-checkbox content rides
    // into published without a revision", and the skeleton equality above already guarantees exactly
    // that. The count restriction only ever encoded "one click at a time", which a fast clicker
    // legitimately breaks; rejecting the whole burst would undo flips the user already saw. The
    // claimed index must still be among the diffs, so a stale or fabricated index is still refused.
    draftStates = taskStates(draftMd)
    const pubStates = taskStates(publishedMd)
    const diff = draftStates.reduce<number[]>((acc, st, i) => (st !== pubStates[i] ? [...acc, i] : acc), [])
    if (diff.length === 0 || !diff.includes(args.index)) {
      // #830: this state has TWO causes and they need different answers, because one of them is a
      // reader looking at a tick that does not exist.
      //
      // `task_burst` was written for the fast clicker: a sibling request already folded this flip, so
      // the draft and the published snapshot agree about it and the client is told to keep what the
      // user is looking at. Correct — the flip IS published.
      //
      // The other cause is that the flip never reached the persisted draft at all. The client writes
      // it into the live document and the collaboration server persists it; with that socket dead the
      // write goes nowhere, the draft still holds the old state, and the two snapshots agree for the
      // opposite reason. Measured in a real browser with the socket refused: the box stayed ticked on
      // screen and `published_md` still read `- [ ] ship it`.
      //
      // The two are indistinguishable from the snapshots alone — both are "draft and published agree
      // here" — so the caller says which state it is moving TO. If that is what published already holds,
      // somebody folded it (burst). If it is the opposite, nothing was folded and nothing arrived, and
      // the client has to put the checkbox back.
      //
      // A caller that sends no `to` gets the old answer, so a tab left open across a deploy keeps
      // today's behaviour rather than a code it has never heard of.
      const publishedHere = pubStates[args.index]
      if (args.to !== undefined && publishedHere !== undefined && publishedHere !== args.to) {
        throw Object.assign(new Error('the flip never reached the draft; nothing was published'), { statusCode: 409, code: 'task_not_stored' })
      }
      throw Object.assign(new Error('the claimed checkbox is not flipped in the draft'), { statusCode: 409, code: 'task_burst' })
    }

    // Fold into the published snapshot. NO revision insert (the whole point); draft == published
    // again ⇒ not dirty. Reindex like publish (published text changed).
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
    // principal (`user:`/`guest:` = createdBy), matching the attribution label revisions store —
    // NOT the FGA `subject` (`share_link:`), which is the authz check identity only.
    // #481: ONE ROW PER FOLDED FLIP, not one per request. The fold takes every pending flip,
    // so a fast clicker publishes N changes through a single call — and the ledger recorded only the
    // index that happened to arrive with it, silently losing the rest. `diff` is exactly the set that
    // moved, and it is computed above from the same two snapshots this UPDATE just published, so the
    // log cannot disagree with the state.
    for (const index of diff) {
      await tx`
        INSERT INTO checkbox_events (tenant_id, page_id, actor, checkbox_index, checked)
        VALUES (${page.tenant_id}, ${args.pageId}, ${args.createdBy}, ${index}, ${draftStates[index]!})
      `
    }
  })
  processOutboxAsync(driver, outboxId, { tenantId, pageId: args.pageId, operation: 'upsert' })
  return { publishedAt }
}

// Release space inheritance for a page: write `page#space` if absent (idempotent —
// OpenFGA rejects duplicate writes, so we check first). Returns whether it wrote.
// #218 / ADR-103 addendum: also write the `published` marker PAIR (draft gate — lets the page RECEIVE
// folder-inherited grants). Both are keyed off "is this page published"; write them together so a page is
// never space-linked without the published marker (or vice versa). Each is written only if absent. Once
// published a page stays published (no publish→draft reversion), so there is no deletion counterpart — a
// cross-space move keeps both (marker is space-independent); deletePage sweeps all page tuples.
async function ensurePageSpaceLink(fga: OpenFgaClient, pageId: string, spaceId: string): Promise<boolean> {
  const tuples = await readObjectTuples(fga, `page:${pageId}`) // #574: paginated — a truncated read re-writes a tuple that already exists
  const has = (relation: string, user: string) => tuples.some((t: { relation: string; user: string }) => t.relation === relation && t.user === user)
  const writes = [
    ...(has('space', `space:${spaceId}`) ? [] : [{ user: `space:${spaceId}`, relation: 'space', object: `page:${pageId}` }]),
    ...PUBLISHED_MARKERS(pageId).filter((m) => !has(m.relation, m.user)),
  ]
  if (writes.length === 0) return false
  await writeTuples(fga, writes)
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
): Promise<{ title: string; isHome: boolean; publishedMd: string | null; publishedAt: Date | null; hasUnpublishedChanges: boolean; canComment: boolean }> {
  const canView = await check(fga, args.subject, 'view', { type: 'page', id: args.pageId }, args.context)
  // #262: existence-hiding — view-denied returns the SAME 404 as a missing page (a "published" read is a
  // display path). Uniform 404 with getPage + the public surface.
  if (!canView) throw Object.assign(new Error('not found'), { statusCode: 404 })
  // #318: title rides along so a view-capable GUEST (whose only page read is this route) can render the
  // title band. Minimal-field policy (the #270 space-info precedent): nothing beyond what the surface
  // shows — no space/creator/member data is added here.
  // #364 whether this page is its space's HOME rides along too — a BOOLEAN, not the space name.
  // The guest band has to label a home page the way every other surface does ("<Space> Home"), and
  // migration 077 already set a home page's title to the bare space name, so the label can be built
  // from the title the guest is being shown anyway. Sending the space name instead would disclose the
  // space behind a single-page share link, which is a wider surface than this fix needs.
  const [row] = await db.sql<[{ title: string; is_home: boolean; published_md: string | null; published_at: Date | null; ydoc: Buffer | null; published_query_snapshot: string | null }]>`
    SELECT p.title, p.published_md, p.published_at, p.ydoc, p.published_query_snapshot,
           EXISTS (SELECT 1 FROM spaces s WHERE s.home_page_id = p.id) AS is_home
    FROM pages p WHERE p.id = ${args.pageId}
  `
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
  const hasUnpublishedChanges = decodeYdocContent(row.ydoc) !== (row.published_md ?? '')
  // #353→#370 / ADR-145: a GUEST (share_link principal) gets the same anonymous static list snapshot as the
  // public surface — a guest NEVER triggers a live per-viewer reverse-lookup (the #244 re-entry class). A
  // MEMBER (user:<sub>) keeps the literal `:::tagged`/`:::children` so the editor's macro resolves it live
  // and viewer-scoped via the member-only /list route. So substitute the baked list ONLY for guests.
  const isGuest = args.subject.startsWith('share_link:')
  const publishedMd = isGuest && row.published_md != null
    ? substituteListSnapshots(row.published_md, row.published_query_snapshot ? (JSON.parse(row.published_query_snapshot) as ListSnapshot) : null)
    : row.published_md
  // canComment (#100): does THIS principal (member or view-guest) have the comment capability on the
  // page (comment_open on + view, an explicit comment grant, or edit)? The guest page uses it to show
  // the comment composer. Convenience only — the comment routes re-check FGA (fortress).
  const canComment = await check(fga, args.subject, 'comment', { type: 'page', id: args.pageId }, args.context)
  return { title: row.title, isHome: row.is_home, publishedMd, publishedAt: row.published_at, hasUnpublishedChanges, canComment }
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
// #330 / ADR-141 adds `moderate` — a direct per-page moderation grant (the ruling: the only way to
// appoint a moderator onto a PRIVATE page, whose space inheritance is private-guarded).
// #420 / ADR-164 increment 1 adds the four SPLIT capabilities — delete/share/settings (admin-class,
// manage stays their superset) and publish (edit-class superset feeder) — as grantable leaves for the
// custom-role expansion (and for direct grants).
export type PageRelation = 'view' | 'comment' | 'edit' | 'manage' | 'moderate' | 'delete' | 'share' | 'settings' | 'publish'
const PAGE_RELATIONS: PageRelation[] = ['view', 'comment', 'edit', 'manage', 'moderate', 'delete', 'share', 'settings', 'publish']

// capability → FGA relation to WRITE. #218 / ADR-103: member/group/link direct grants go to the `*_direct`
// LEAVES (view_direct / edit_direct / manage_direct) so they cascade down the parent chain; `edit`/`manage` are
// purely computed now (a direct write to them fails "type not allowed"). #411 / ADR-153: `comment` joined
// them — the trash subtraction made it computed, so direct comment grants write the NEW `comment_direct`
// leaf (existing tuples migrated by infra/openfga/migrate-comment-direct.ts). `moderate` (#330) keeps its
// own direct type on the relation itself ([user, group#member]) — no leaf split needed (it does not
// cascade down parents; a per-page appointment is deliberate and page-scoped).
export function fgaRelationForCap(cap: PageRelation): 'view_direct' | 'comment_direct' | 'edit_direct' | 'manage_direct' | 'moderate' | 'delete_direct' | 'share_direct' | 'settings_direct' | 'publish_direct' {
  if (cap === 'view') return 'view_direct'
  if (cap === 'edit') return 'edit_direct'
  if (cap === 'manage') return 'manage_direct'
  if (cap === 'moderate') return 'moderate'
  // #420 / ADR-164: the split verbs follow the same leaf pattern (cascading *_direct write targets).
  if (cap === 'delete') return 'delete_direct'
  if (cap === 'share') return 'share_direct'
  if (cap === 'settings') return 'settings_direct'
  if (cap === 'publish') return 'publish_direct'
  return 'comment_direct'
}
// FGA relation (as stored/read) → user-facing capability; null for non-grant relations (space/parent/
// comment_open/view/view_base). The `*_direct` leaves surface as their capability.
function capForFgaRelation(rel: string): PageRelation | null {
  if (rel === 'view_direct') return 'view'
  if (rel === 'edit_direct') return 'edit'
  if (rel === 'manage_direct') return 'manage'
  if (rel === 'comment_direct') return 'comment'
  if (rel === 'moderate') return 'moderate'
  if (rel === 'delete_direct') return 'delete'
  if (rel === 'share_direct') return 'share'
  if (rel === 'settings_direct') return 'settings'
  if (rel === 'publish_direct') return 'publish'
  return null
}

function validateGrant(grantee: string, relation: string): asserts relation is PageRelation {
  if (!PAGE_RELATIONS.includes(relation as PageRelation)) {
    throw Object.assign(new Error('relation must be one of view, comment, edit, manage, moderate, delete, share, settings, publish'), { statusCode: 400 })
  }
  // Only real principals: a member or a group's member-set. NOT share_link, user:*,
  // page:, space: — those are not hand-grantable per-page access.
  if (!/^user:[^*\s]+$/.test(grantee) && !/^group:[^\s]+#member$/.test(grantee)) {
    throw Object.assign(new Error('grantee must be user:<sub> or group:<id>#member'), { statusCode: 400 })
  }
}

// #420 / ADR-164 Addendum 3 (ruled, the STRICT fork): the GRANT RELATION CEILING. With the
// grant gate lowered from manage to the share verb (increment 3b), an uncapped grant would let a
// share-only principal write manage_direct to THEMSELVES — full escalation. The ceiling: a share
// holder may grant/revoke only the READER/WRITER class (view/comment/edit, plus share links);
// granting/revoking ANY admin-class relation — manage, moderate, delete, settings, publish, and
// share ITSELF (delegation is manage-only, the stricter ruled fork) — requires `manage`.
const ADMIN_CLASS_RELATIONS = new Set<PageRelation>(['manage', 'moderate', 'delete', 'share', 'settings', 'publish'])

async function requireGrantAuthority(fga: OpenFgaClient, userId: string, pageId: string, relation: PageRelation): Promise<void> {
  await requireVerb(fga, userId, pageId, 'share')
  if (ADMIN_CLASS_RELATIONS.has(relation)) {
    // manage passes via its own relation (not the share superset arm) — the ceiling check.
    await requireManage(fga, userId, pageId)
  }
}

// #399 / ADR-158 §1: read the page's OWN comment_open wildcard tuples (the override state; the
// effective audience is this OR the space's — the model's monotonic union).
async function readPageCommentAudience(fga: OpenFgaClient, pageId: string): Promise<{ guests: boolean; members: boolean }> {
  // #574 review: the same lesson as isPagePublic, applied rather than repeated. `comment_open`
  // accepts [user:*, share_link:*] directly (model.fga:265) and everything else it unions is computed,
  // which a filtered Read does not expand — so this is bounded at TWO tuples and needs one round trip.
  // Scanning every tuple on the page was the pessimisation I had to withdraw once already.
  // fga-read-ok: comment_open accepts only the two wildcards directly (model.fga:265) — at most two tuples.
  const { tuples } = await fga.read({ object: `page:${pageId}`, relation: 'comment_open' })
  let guests = false, members = false
  for (const t of tuples ?? []) {
    const key = t.key
    if (key?.relation !== 'comment_open') continue
    if (key.user === 'share_link:*') guests = true
    else if (key.user === 'user:*') members = true
  }
  return { guests, members }
}

async function requireManage(fga: OpenFgaClient, userId: string, pageId: string): Promise<void> {
  const canManage = await check(fga, `user:${userId}`, 'manage', { type: 'page', id: pageId })
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
}

// #420 / ADR-164 increment 3b: the split-verb route gates. Checking the VERB (not manage) admits
// capability-granted principals; manage still passes every one via the model's superset arm — no
// double check needed. 403 shape matches requireManage (the pre-split behaviour for managers).
async function requireVerb(fga: OpenFgaClient, userId: string, pageId: string, verb: 'delete' | 'share' | 'settings' | 'publish'): Promise<void> {
  const ok = await check(fga, `user:${userId}`, verb, { type: 'page', id: pageId })
  if (!ok) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
}

// Rider 2: the model deliberately keeps the ADMIN verbs alive on a TRASHED page (delete is
// the restore/purge authority), so SHARE/SETTINGS routes must themselves refuse trashed pages with
// a 404 — no grant surgery on trash. Precision (reviewer nit): an UNAUTHORIZED caller gets 403 from
// the verb gate for absent and trashed pages alike (no leak); only an AUTHORIZED share holder — who
// already knows the page — can tell trashed (404) from live.
async function requireNotTrashed(db: TenantDb, pageId: string): Promise<void> {
  const [row] = await db.sql<[{ deleted_root_id: string | null }?]>`SELECT deleted_root_id FROM pages WHERE id = ${pageId}`
  if (!row || row.deleted_root_id) throw Object.assign(new Error('not found'), { statusCode: 404 })
}

// #330 / ADR-141: the MODERATION gate — `moderate` OR `manage` passes. `moderate` does not imply page-level
// manage (a page creator's manage_direct is not a moderator), and manage_direct holders are not in
// space#moderator, so BOTH relations are checked. Used by the moderation verbs (freeze C-4, per-actor revert
// C-2, patrol C-1) — never by grants/delete/settings, which stay requireManage (moderate ≠ manage).
export async function requireModerate(fga: OpenFgaClient, userId: string, pageId: string): Promise<void> {
  const target = { type: 'page' as const, id: pageId }
  const [canModerate, canManage] = await Promise.all([
    check(fga, `user:${userId}`, 'moderate', target),
    check(fga, `user:${userId}`, 'manage', target),
  ])
  if (!canModerate && !canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
}

export async function grantPageAccess(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; tenantId: string; userId: string; grantee: string; relation: string; plan?: string },
): Promise<void> {
  validateGrant(args.grantee, args.relation)
  await requireGrantAuthority(fga, args.userId, args.pageId, args.relation as PageRelation) // #420 Addendum 3: the ceiling — admin-class grants need manage
  await requireNotTrashed(db, args.pageId) // Rider 2: no share surgery on a trashed page (uniform 404)
  // #536 review point 3: the same mechanism as the space grant — a page grant IS a role assignment with the
  // builtin_capability column set, so it participates in the reference count that decides whether a leaf
  // shared with a page-scope custom-role assignment may be deleted. Before this, revoking either one took
  // the other's access with it, exactly the defect item ① fixed for spaces.
  const { assignRoleInTx } = await import('./roles.js')
  await assignRoleInTx(db, fga, driver, {
    tenant: { id: args.tenantId, plan: args.plan ?? '' },
    roleId: null,
    builtinCapability: args.relation,
    capabilities: [args.relation as never],
    resourceType: 'page',
    resourceId: args.pageId,
    principal: args.grantee,
    actorSub: args.userId,
    onDuplicate: 'ignore',
    auditAction: 'page.access_granted',
    skipAudit: args.plan === undefined,
  })
  emit({ type: 'page.access_granted', tenantId: args.tenantId, pageId: args.pageId, grantee: args.grantee, relation: args.relation, actorId: args.userId })
}

export async function revokePageAccess(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; tenantId: string; userId: string; grantee: string; relation: string; plan?: string },
): Promise<{ stillCovered: { capability: string; via?: string }[] }> {
  validateGrant(args.grantee, args.relation)
  await requireGrantAuthority(fga, args.userId, args.pageId, args.relation as PageRelation) // #420 Addendum 3: the ceiling — admin-class grants need manage
  await requireNotTrashed(db, args.pageId) // Rider 2: no share surgery on a trashed page (uniform 404)
  // #536 review point 3: revoke the ROW when there is one (refcount decides which leaves go); a rowless
  // legacy grant falls back to the direct delete — guarded by the same coverage check as the space path,
  // so it cannot take a live assignment's leaf with it.
  const { unassignRoleInTx, redactCoverage } = await import('./roles.js')
  // #596 review F1: this route's gate is `share`; reading role DEFINITIONS is gated on `manage`
  // (ADR-202 §1). Name the coverage only for a caller who could read those names anyway.
  const mayNameCoverage = await check(fga, `user:${args.userId}`, 'manage', { type: 'page', id: args.pageId })
  const [row] = await db.sql<{ id: string }[]>`
    SELECT id FROM role_assignments
    WHERE builtin_capability = ${args.relation} AND resource_type = 'page' AND resource_id = ${args.pageId} AND principal = ${args.grantee}`
  let stillCovered: { capability: string; via?: string }[] = []
  if (row) {
    const r = await unassignRoleInTx(db, fga, driver, {
      tenant: { id: args.tenantId, plan: args.plan ?? '' },
      assignmentId: row.id, actorSub: args.userId,
      auditAction: 'page.access_revoked', skipAudit: args.plan === undefined,
    })
    stillCovered = redactCoverage(r.stillCovered, mayNameCoverage)
  } else {
    // #596: `via` names what covers the capability, for the refusal body.
    const covering = await db.sql<{ via: string }[]>`
      SELECT COALESCE(r.name, a.builtin_capability) AS via FROM role_assignments a LEFT JOIN roles r ON r.id = a.role_id
      WHERE a.resource_type = 'page' AND a.resource_id = ${args.pageId} AND a.principal = ${args.grantee}
        AND ${args.relation} = ANY(COALESCE(r.capabilities, ARRAY[a.builtin_capability]))`
    // #596: there is no row to delete and the covering assignment keeps the tuple — NOTHING would
    // change. Answering success here wrote an audit line and fired a webhook for a revoke that never
    // happened (the EE ledger is hash-chained: a false entry is a tamper-proof lie). Refuse honestly
    // instead; the remedy is removing the covering assignment, and the body names it.
    if (covering.length > 0) {
      throw Object.assign(new Error('still granted by another assignment'), {
        // #596 review F1: the refusal is the caller's own page, but the NAMES are tenant-wide role
        // information — omitted unless they may read them (ADR-202 §1's line).
        statusCode: 409, code: 'still_covered', coveredBy: mayNameCoverage ? covering.map((c) => c.via) : [],
      })
    }
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
  }
  // #362 E1: revocation watch sweep (post-FGA, best-effort — the display gate is the bastion). Per-watcher
  // view re-check inside, so a watcher whose view survives via another path keeps their watch.
  void sweepUnviewableWatches(db, fga, [args.pageId]).catch(() => {})
  // #596 review F3: `page.access_revoked` means "a principal LOST a relation on a page" (the event
  // catalog's own wording). Firing it while a surviving assignment still confers the relation tells a
  // permission-mirroring consumer to de-provision someone who did not lose access — a false positive
  // with real effects downstream. The row removal is recorded in the audit; the webhook speaks only
  // for the access change, and here there was none.
  if (!stillCovered.some((c) => c.capability === args.relation)) {
    emit({ type: 'page.access_revoked', tenantId: args.tenantId, pageId: args.pageId, grantee: args.grantee, relation: args.relation, actorId: args.userId })
  }
  return { stillCovered }
}

// #109 / ADR-072 monotonic deny: RESTRICT a principal from a page. Writes page#restricted so the
// principal's `view` (= viewable but not restricted) becomes false everywhere — the page 404s for
// them even if they're a space viewer. Manage-gated + audited + reindexed, like grant/revoke. Only a
// real member/group (never share_link / wildcard) is restrictable.
function validateRestrictee(who: string): void {
  // #218 / ADR-103 (A5-2): a specific share_link:<id> is now a valid restrictee — so a folder-share-link guest
  // can be excluded from ONE child page (restricted subtracts from `view` AND `edit`). NOT share_link:* (that
  // over-denies every link). user:* is still forbidden (a public page is toggled off via the public grant).
  if (!/^user:[^*\s]+$/.test(who) && !/^group:[^\s]+#member$/.test(who) && !/^share_link:[^*\s]+$/.test(who)) {
    throw Object.assign(new Error('restrictee must be user:<sub>, group:<id>#member or share_link:<id>'), { statusCode: 400 })
  }
}

export async function restrictPageAccess(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; tenantId: string; userId: string; principal: string; plan?: string },
): Promise<void> {
  validateRestrictee(args.principal)
  await requireVerb(fga, args.userId, args.pageId, 'share') // #420 3b: grants/links/visibility = the share verb (manage passes via the superset)
  await requireNotTrashed(db, args.pageId) // Rider 2: no share surgery on a trashed page (uniform 404)
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
  void sweepUnviewableWatches(db, fga, [args.pageId]).catch(() => {}) // #362 E1 (per-watcher re-check inside)
  emit({ type: 'page.access_restricted', tenantId: args.tenantId, pageId: args.pageId, grantee: args.principal, relation: 'restricted', actorId: args.userId })
}

export async function unrestrictPageAccess(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; tenantId: string; userId: string; principal: string; plan?: string },
): Promise<void> {
  validateRestrictee(args.principal)
  await requireVerb(fga, args.userId, args.pageId, 'share') // #420 3b: grants/links/visibility = the share verb (manage passes via the superset)
  await requireNotTrashed(db, args.pageId) // Rider 2: no share surgery on a trashed page (uniform 404)
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
/** #623: how many of a page's tuples one restriction read may take. */
export const RESTRICTIONS_PAGE_SIZE = 100

export interface PageRestrictionsPage {
  restrictions: { principal: string; displayName?: string | null }[]
  nextCursor: string | null
}

export async function listPageRestrictions(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; userId: string; cursor?: string; pageSize?: number },
): Promise<PageRestrictionsPage> {
  await requireVerb(fga, args.userId, args.pageId, 'share') // #420 3b: grants/links/visibility = the share verb (manage passes via the superset)
  await requireNotTrashed(db, args.pageId) // Rider 2: no share surgery on a trashed page (uniform 404)
  // #574: paginated — `restricted` is PER-PRINCIPAL, so this list silently stopped at fifty.
  //
  // #623: and it then returned every one of them. The bound is FGA's own page, and the marker is its
  // continuation token — there is no timestamp to keyset on here.
  //
  // ⚠️ The relation filter below runs AFTER the read, and a page object carries grants, links and
  // markers alongside restrictions, so a page can hold ZERO restrictions while more follow. The caller
  // must walk on `nextCursor`, never on emptiness (`listAllPageRestrictions` is that walk, written
  // once).
  const { tuples, nextCursor } = await readObjectTuplesPage(fga, `page:${args.pageId}`, {
    pageSize: args.pageSize ?? RESTRICTIONS_PAGE_SIZE,
    ...(args.cursor ? { cursor: args.cursor } : {}),
  })
  const out: { principal: string; displayName?: string | null }[] = []
  for (const key of tuples) {
    if (key.relation === 'restricted' && key.user) out.push({ principal: key.user })
  }
  // #578: a restriction names a person, so it carries a name for the same reason the grant list does —
  // and from the same authorization-bounded set (the `share` verb above), resolved on the caller's RLS
  // handle. Without it the dialog's second list would still print a subject id beside a first list that
  // does not, which is the drift this ticket is about.
  const userSubs = out.filter((r) => r.principal.startsWith('user:')).map((r) => r.principal.slice('user:'.length))
  if (userSubs.length > 0) {
    const ids = await resolveAuthorIdentities(db, userSubs)
    for (const r of out) {
      if (r.principal.startsWith('user:')) r.displayName = ids.get(r.principal.slice('user:'.length))?.displayName ?? null
    }
  }
  return { restrictions: out, nextCursor }
}

/** Every restriction on a page, by walking. The dialog is where one is lifted, so it needs them all. */
export async function listAllPageRestrictions(
  db: TenantDb,
  fga: OpenFgaClient,
  // `pageSize` is a seam for the pin, not a caller knob: the empty-page shape this walk exists to
  // survive only happens when the pages are small enough for the relation filter to empty one.
  args: { pageId: string; userId: string; pageSize?: number },
): Promise<{ principal: string; displayName?: string | null }[]> {
  const out: { principal: string; displayName?: string | null }[] = []
  let cursor: string | undefined
  do {
    const page: PageRestrictionsPage = await listPageRestrictions(db, fga, { ...args, ...(cursor ? { cursor } : {}) })
    out.push(...page.restrictions)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
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
// #218 / ADR-103 addendum (DRAFT GATE): the `published` marker PAIR that lets a page RECEIVE folder-inherited
// grants (`*_inherited = *_from_parent and published`). Written at publish next to page#space; an unpublished
// draft has neither, so a folder grant never reaches it (creator-only until publish). Pair form mirrors
// PRIVATE_MARKERS: user:* matches member principals, share_link:* matches guest/link principals.
const PUBLISHED_MARKERS = (pageId: string) => [
  { user: 'user:*', relation: 'published', object: `page:${pageId}` },
  { user: 'share_link:*', relation: 'published', object: `page:${pageId}` },
]

// Read the private marker WITHOUT a manage gate (#109 Fix B): the lock badge is shown to
// anyone who can already see the page (sidebar + title). Callers who can view a page ARE its
// allowlist when it is private, so exposing the flag to them leaks nothing (non-viewers 404).
// isPagePrivate stays manage-gated for the permission UI's authoritative read.
async function readPagePrivate(fga: OpenFgaClient, pageId: string): Promise<boolean> {
  // fga-read-ok: a MARKER relation — the model's only writers are the wildcard pair (user:* / share_link:*), so at most two tuples exist.
  const { tuples } = await fga.read({ object: `page:${pageId}`, relation: 'private' })
  return (tuples ?? []).some(({ key }) => key?.relation === 'private' && key.user === 'user:*')
}

export async function setPagePrivate(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; tenantId: string; userId: string; plan?: string },
): Promise<void> {
  await requireVerb(fga, args.userId, args.pageId, 'share') // #420 3b: grants/links/visibility = the share verb (manage passes via the superset)
  await requireNotTrashed(db, args.pageId) // Rider 2: no share surgery on a trashed page (uniform 404)
  // #218 / ADR-103 (decision 2b): privatising a FOLDER makes its whole subtree (effective-)private. The
  // `private` marker is written on the ROOT only (the model cascades it down the parent chain), but the
  // public-grant strip, share-link sweep, and reindex must run on EVERY descendant too — the model can't
  // subtract a descendant's DIRECT `view_base@user:*` (public) or its direct share-link grants, so those would
  // survive the inherited private as live holes.
  const subtree = [args.pageId, ...(await descendantIds(db.sql, args.pageId))]
  // ⚠️ #862 / ADR-108 §G: the marker written below is exactly what the webhook drain reads when it
  // asks whether these pages may be spoken of, so after this point the answer is `suppress` for every
  // one of them — which is why `page.made_private` and the `share_link.revoked` events raised here
  // have never been delivered, beside a comment saying a consumer mirroring access has to hear them.
  // Read once per page now, while the pre-privatise state is still there. One extra store read per
  // page on a path that already does several (#788): proportionate, not a new order of magnitude.
  const wasDeliverable = new Map<string, boolean>()
  for (const id of subtree) wasDeliverable.set(id, (await pageEventDisposition(fga, { pageId: id })) === 'deliver')
  const oids = await db.tx(async (tx) => {
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'page.made_private', target: `page:${args.pageId}` })
    }
    const os: string[] = []
    for (const id of subtree) os.push(await enqueueOutbox(tx, { tenantId: args.tenantId, pageId: id, operation: 'upsert' }))
    // marker on the ROOT (cascades to descendants via `private from parent`).
    // #511 IDEMPOTENT. OpenFGA fails the whole batch when a tuple already exists, so privatising an
    // already-private page threw — and a bulk caller saw it reported as a permission skip, which is a lie
    // about why. On that error the pair is retried marker-by-marker rather than swallowed wholesale: a
    // LEGACY page holding only `user:*` (privatised before the #244 backfill) would otherwise fail the batch
    // on the existing marker and never get its `share_link:*` written, leaving the guest hole open.
    try {
      await writeTuples(fga, PRIVATE_MARKERS(args.pageId))
    } catch (e) {
      // #578: asked by CODE. The store's sentence is replaced at the tuple-helper boundary now (an admin
      // must not read FGA's internals), and matching prose somebody else owns is a check that fails
      // silently the day it changes — here, by turning an idempotent re-privatise back into the
      // "reported as a permission skip" lie #511 removed.
      if (!isAlreadyConverged(e)) throw e
      for (const m of PRIVATE_MARKERS(args.pageId)) {
        await writeTuples(fga, [m]).catch((e2) => { if (!isAlreadyConverged(e2)) throw e2 })
      }
    }
    return os
  })
  // public⊥private invariant, over the whole subtree: strip each page's public grant so is_public can't survive
  // privatisation. Per-page delete (a batch fails wholesale if any page isn't public — a public descendant
  // would then keep indexing public). Security-critical + fail-safe: runs AFTER the marker commit.
  //
  // The catch used to swallow EVERYTHING, which made this the quiet half of a leak: `view_base`'s `[user:*]`
  // arm is NOT `but not private` (model.fga) — the invariant holds at the WRITE boundary and nowhere else —
  // so a page whose strip failed stays anonymously world-readable while the caller is told it went private.
  // "Not public to begin with" is convergence and still passes; a real refusal is collected and raised below,
  // after the rest of the fail-safe work has been attempted (aborting mid-sweep would leave the pages behind
  // this one public too).
  const stillPublic: string[] = []
  for (const id of subtree) {
    await deleteTuples(fga, [PUBLIC_GRANT(id)]).catch((e) => { if (!isAlreadyConverged(e)) stillPublic.push(id) })
  }
  // #109 Fix A + ADR-103 2b: revoke the subtree's share links AFTER the marker/strip — the marker + strip +
  // reindex are the security-critical fail-safe part and land first (a revoke failure must NOT roll back them).
  const revoked: { id: string; pageId: string }[] = []
  const failed: unknown[] = []
  for (const id of subtree) {
    const r = await revokeResourceShareLinks(db, fga, { type: 'page', id }, args.tenantId, args.userId)
    revoked.push(...r.revoked); if (r.failed.length) failed.push(...r.failed)
  }
  // Reindex the whole subtree so is_public flips false (view_base@user:* gone) + space members drop from stage-1.
  subtree.forEach((id, i) => processOutboxAsync(driver, oids[i]!, { tenantId: args.tenantId, pageId: id, operation: 'upsert' }))
  void sweepUnviewableWatches(db, fga, [args.pageId]).catch(() => {}) // #362 E1: privatise cuts inherited view
  invalidatePageBadge(args.tenantId, args.pageId) // #541: the lock badge flips immediately
  // comment 785 #2: emit share_link.revoked ONLY after the DB revoke committed (never on a rolled-back tx).
  // BEFORE the raise below (#622 re-review): those links really are revoked in the database, and a consumer
  // mirroring access has to hear about the ones that went even when the strip did not — swallowing them
  // because a different half failed is the same "the ledger does not match the world" defect from the
  // other direction.
  for (const link of revoked) emit({ type: 'share_link.revoked', tenantId: args.tenantId, shareLinkId: link.id, pageId: link.pageId, actorId: args.userId, pageWasDeliverable: wasDeliverable.get(link.pageId) ?? false })
  // Raised after every piece of fail-safe work, and before the success event: the marker landed, but a page
  // whose public grant survived is still readable by anyone, and saying "made private" would be the #596
  // lie about the one thing this call exists to guarantee. Retrying the same call re-attempts the strip
  // (idempotent). The `page.made_private` AUDIT row is already committed at this point — the tx that wrote
  // the marker owns it, and the marker did land — so the ledger says the page was marked private, which is
  // true; what the caller is being told here is that it is marked private AND still public, which the
  // 500 + `public_grant_not_removed` says and the missing event does not contradict.
  if (stillPublic.length) {
    console.error('[setPagePrivate] public grant survived — these pages are still anonymously readable', { pageId: args.pageId, stillPublic })
    throw Object.assign(new Error('the page is marked private, but its public grant could not be removed'), {
      statusCode: 500, code: 'public_grant_not_removed', pages: stillPublic,
    })
  }
  emit({ type: 'page.made_private', tenantId: args.tenantId, pageId: args.pageId, actorId: args.userId, pageWasDeliverable: wasDeliverable.get(args.pageId) ?? false })
  // comment 785 #3: a partial FGA-delete failure is not silent — the page IS private (fail-safe), but these
  // links are still live on FGA until a re-privatise/sweep retries them (they stay revoked_at IS NULL).
  if (failed.length) console.error('[setPagePrivate] subtree share-link revoke incomplete (private applied; links pending FGA delete)', { pageId: args.pageId, failed })
}

export async function unsetPagePrivate(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; tenantId: string; userId: string; plan?: string },
): Promise<void> {
  await requireVerb(fga, args.userId, args.pageId, 'share') // #420 3b: grants/links/visibility = the share verb (manage passes via the superset)
  await requireNotTrashed(db, args.pageId) // Rider 2: no share surgery on a trashed page (uniform 404)
  // #218 / ADR-103: clearing the ROOT marker resumes space inheritance for the WHOLE subtree (private
  // cascaded down; removing the root marker un-inherits it), so the whole subtree must be reindexed (space
  // members re-enter stage-1). We do NOT restore public grants or share-links (safe-side: one-way — a
  // re-publish or explicit public toggle re-adds them per page if desired).
  const subtree = [args.pageId, ...(await descendantIds(db.sql, args.pageId))]
  const oids = await db.tx(async (tx) => {
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'page.made_non_private', target: `page:${args.pageId}` })
    }
    const os: string[] = []
    for (const id of subtree) os.push(await enqueueOutbox(tx, { tenantId: args.tenantId, pageId: id, operation: 'upsert' }))
    // Delete each marker INDEPENDENTLY: a legacy page privatised before the #244 backfill has only user:*, and
    // a single batch delete of a missing share_link:* would fail the whole write and leave the page stuck private.
    await Promise.all(PRIVATE_MARKERS(args.pageId).map((m) => deleteTuples(fga, [m]).catch(() => {})))
    return os
  })
  subtree.forEach((id, i) => processOutboxAsync(driver, oids[i]!, { tenantId: args.tenantId, pageId: id, operation: 'upsert' }))
  invalidatePageBadge(args.tenantId, args.pageId) // #541
  emit({ type: 'page.made_non_private', tenantId: args.tenantId, pageId: args.pageId, actorId: args.userId })
}

// #329 / ADR-139: page FREEZE — a staged edit lock. The model subtracts the markers from the edit chain
// BELOW the manage bypass (`edit = manage or edit_unfrozen`), so writing a marker pair cuts EVERY edit
// path (collab join, publish, checkbox, attachment, MCP edit — they all check(edit)) for everyone below
// manage, with NO per-path code; deleting it restores them all. Freeze is an authz state: no CRDT/history
// touch, and NO reindex — it subtracts edit only, so view/search membership is unchanged (doc-builder
// reads view-side relations). Level exclusivity: a page holds at most one level; setting one clears the
// other. The `frozen` full-lock marker is a PAIR (the #244 typed-wildcard lesson — user:* alone would not
// stop a share-link guest); `frozen_guests` is share_link:* alone by design (members keep editing).
export type PageFreezeLevel = 'full' | 'guests'
const FROZEN_MARKERS = (pageId: string) => [
  { user: 'user:*', relation: 'frozen', object: `page:${pageId}` },
  { user: 'share_link:*', relation: 'frozen', object: `page:${pageId}` },
]
const FROZEN_GUESTS_MARKERS = (pageId: string) => [
  { user: 'share_link:*', relation: 'frozen_guests', object: `page:${pageId}` },
]

// Read WITHOUT a manage gate (the readPagePrivate precedent, #109 Fix B): the lock badge shows to anyone
// who can already see the page — freeze only REMOVES access, so the flag reveals nothing (non-viewers 404
// before they get here). The full-lock pair is kept in sync by the write path, so user:* presence is the
// full-lock predicate (mirroring the private read).
async function readPageFrozen(fga: OpenFgaClient, pageId: string): Promise<PageFreezeLevel | null> {
  const [full, guests] = await Promise.all([
    // fga-read-ok: a MARKER relation — the model's only writers are the wildcard pair (user:* / share_link:*), so at most two tuples exist.
    fga.read({ object: `page:${pageId}`, relation: 'frozen' }),
    // fga-read-ok: a MARKER relation — the model's only writers are the wildcard pair (user:* / share_link:*), so at most two tuples exist.
    fga.read({ object: `page:${pageId}`, relation: 'frozen_guests' }),
  ])
  if ((full.tuples ?? []).some(({ key }) => key?.relation === 'frozen' && key.user === 'user:*')) return 'full'
  if ((guests.tuples ?? []).some(({ key }) => key?.relation === 'frozen_guests' && key.user === 'share_link:*')) return 'guests'
  return null
}

export async function setPageFrozen(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; tenantId: string; userId: string; level: PageFreezeLevel; plan?: string },
): Promise<void> {
  // #330 / ADR-141: freeze is a MODERATION verb — moderate or manage (was manage-only in C-4, the planned widening).
  await requireModerate(fga, args.userId, args.pageId)
  const current = await readPageFrozen(fga, args.pageId)
  if (current === args.level) return // idempotent — re-freezing at the same level is a no-op
  await db.tx(async (tx) => {
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'page.frozen', target: `page:${args.pageId}` })
    }
    // Write the NEW level first, then clear the other level (each delete independent + idempotent).
    // Fail-safe ordering: if the deletes fail we are momentarily at BOTH levels, which resolves to the
    // stricter full lock — freeze never silently under-locks. No outbox: view/search are unaffected.
    await writeTuples(fga, args.level === 'full' ? FROZEN_MARKERS(args.pageId) : FROZEN_GUESTS_MARKERS(args.pageId))
    const other = args.level === 'full' ? FROZEN_GUESTS_MARKERS(args.pageId) : FROZEN_MARKERS(args.pageId)
    await Promise.all(other.map((m) => deleteTuples(fga, [m]).catch(() => {})))
  })
  invalidatePageBadge(args.tenantId, args.pageId) // #541: the badge shows the new level immediately
  emit({ type: 'page.frozen', tenantId: args.tenantId, pageId: args.pageId, level: args.level, actorId: args.userId })
}

export async function unsetPageFrozen(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; tenantId: string; userId: string; plan?: string },
): Promise<void> {
  // #330 / ADR-141: unfreeze is the same moderation verb (moderate or manage).
  await requireModerate(fga, args.userId, args.pageId)
  await db.tx(async (tx) => {
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'page.unfrozen', target: `page:${args.pageId}` })
    }
    // Delete every marker independently (the unsetPagePrivate lesson: a missing tuple in a batch delete
    // fails the whole write and would leave the page stuck frozen).
    await Promise.all(
      [...FROZEN_MARKERS(args.pageId), ...FROZEN_GUESTS_MARKERS(args.pageId)].map((m) => deleteTuples(fga, [m]).catch(() => {})),
    )
  })
  invalidatePageBadge(args.tenantId, args.pageId) // #541
  emit({ type: 'page.unfrozen', tenantId: args.tenantId, pageId: args.pageId, actorId: args.userId })
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
  await requireVerb(fga, args.userId, args.pageId, 'share') // #420 3b: grants/links/visibility = the share verb (manage passes via the superset)
  await requireNotTrashed(db, args.pageId) // Rider 2: no share surgery on a trashed page (uniform 404)
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
    // #362 / ADR-126 addendum: page.made_public feed event, in-tx. published_at is non-NULL here (the
    // published-only 400 above), so the shared guard passes by construction.
    const [sp] = await tx<[{ space_id: string }?]>`SELECT space_id FROM pages WHERE id = ${args.pageId}`
    await fanOutFeedEvent(tx, { tenantId: args.tenantId, eventType: 'page.made_public', pageId: args.pageId, spaceId: sp?.space_id ?? null, actor: `user:${args.userId}`, publishedAt: p.published_at })
    await writeTuples(fga, [PUBLIC_GRANT(args.pageId)]) // view_base@user:* — is_public flips true on reindex
    return o
  })
  // #253 review (TOCTOU self-heal): the pre-write private check (:786) is outside the tx, so a concurrent
  // setPagePrivate could land its markers BETWEEN that check and the grant write above, leaving a private page
  // with a live view_base@user:* (anonymous world-readable, no self-heal — the higher-stakes leak the reviewer
  // flagged). Re-read private AFTER the write; if it is now private, REVOKE the grant we just wrote so
  // private always wins (public⊥private converges without an advisory lock). Idempotent.
  if (await readPagePrivate(fga, args.pageId)) {
    // A swallow here defeated the self-heal it was written for: if this delete fails, the private page keeps
    // the grant we just wrote and is world-readable, and the 409 below would report the tidy outcome ("it
    // stayed private") for the untidy one. Convergence only; a refusal propagates, and the response boundary
    // turns it into authz_store_error rather than a 409 that understates what happened.
    await deleteTuples(fga, [PUBLIC_GRANT(args.pageId)]).catch((e) => { if (!isAlreadyConverged(e)) throw e })
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
  await requireVerb(fga, args.userId, args.pageId, 'share') // #420 3b: grants/links/visibility = the share verb (manage passes via the superset)
  await requireNotTrashed(db, args.pageId) // Rider 2: no share surgery on a trashed page (uniform 404)
  const oid = await db.tx(async (tx) => {
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.userId}`, action: 'page.made_non_public', target: `page:${args.pageId}` })
    }
    const o = await enqueueOutbox(tx, { tenantId: args.tenantId, pageId: args.pageId, operation: 'upsert' })
    // #362 / ADR-126 addendum: page.made_non_public feed event, in-tx (published-only via the shared guard —
    // un-publicing a draft is a no-op event-wise).
    const [pg] = await tx<[{ published_at: Date | null; space_id: string }?]>`SELECT published_at, space_id FROM pages WHERE id = ${args.pageId}`
    await fanOutFeedEvent(tx, { tenantId: args.tenantId, eventType: 'page.made_non_public', pageId: args.pageId, spaceId: pg?.space_id ?? null, actor: `user:${args.userId}`, publishedAt: pg?.published_at ?? null })
    // Remove the anonymous grant (idempotent — the page may not be public). Exactly one tuple, so no orphan.
    // Only convergence is forgiven. Measured with a refusing store before this line changed: the call
    // answered success, wrote `page.made_non_public` to the ledger, fired the webhook — and the page was
    // still readable by anyone, because the public route authorises off this very tuple (routes/public.ts).
    // Inside the tx on purpose: a refusal now rolls the audit row and the outbox intent back with it.
    await deleteTuples(fga, [PUBLIC_GRANT(args.pageId)]).catch((e) => { if (!isAlreadyConverged(e)) throw e })
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
export async function isPagePublic(db: TenantDb, fga: OpenFgaClient, args: { pageId: string; userId: string }): Promise<boolean> {
  await requireVerb(fga, args.userId, args.pageId, 'share') // #420 3b: grants/links/visibility = the share verb (manage passes via the superset)
  await requireNotTrashed(db, args.pageId) // Rider 2: no share surgery on a trashed page (uniform 404)
  // #574 review: I called this the twin of isSpacePublic and it is NOT. Whether a filtered Read
  // can truncate is decided by the relation's DIRECT types in model.fga, not by how the relation reads
  // in prose. `space#viewer` accepts [user, group#member, user:*, share_link…] — per-principal, so the
  // deciding wildcard really can sit past page one (#553, a real bug). `page#view_base` accepts
  // [user:*] and nothing else (model.fga:263); every per-principal leaf lives in `view_direct`, a
  // different relation a filtered Read does not expand. So this answers with at most ONE tuple, and
  // paginating it turned one round trip into three on a page with many grants — a pessimisation
  // bought with no correctness at all. Measured: 120 sibling tuples, filtered read → 1 tuple, no
  // continuation token, the wildcard still visible.
  // fga-read-ok: view_base accepts only user:* directly (model.fga:263) — at most one tuple exists.
  const { tuples } = await fga.read({ object: `page:${args.pageId}`, relation: 'view_base' })
  return (tuples ?? []).some(({ key }) => key?.relation === 'view_base' && key.user === 'user:*')
}

// Is the page private (allowlist mode)? Manage-gated read for the permissions UI.
export async function isPagePrivate(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; userId: string },
): Promise<boolean> {
  await requireVerb(fga, args.userId, args.pageId, 'share') // #420 3b: grants/links/visibility = the share verb (manage passes via the superset)
  await requireNotTrashed(db, args.pageId) // Rider 2: no share surgery on a trashed page (uniform 404)
  // fga-read-ok: a MARKER relation — the model's only writers are the wildcard pair (user:* / share_link:*), so at most two tuples exist.
  const { tuples } = await fga.read({ object: `page:${args.pageId}`, relation: 'private' })
  return (tuples ?? []).some(({ key }) => key?.relation === 'private' && key.user === 'user:*')
}

/** #623: how many of a page's tuples one access read may take. */
export const PAGE_ACCESS_PAGE_SIZE = 100

export interface PageAccessPage {
  grants: { grantee: string; relation: PageRelation; groupName?: string; displayName?: string | null }[]
  nextCursor: string | null
}

export async function listPageAccess(
  fga: OpenFgaClient,
  db: TenantDb,
  args: { pageId: string; tenantId: string; userId: string; cursor?: string; pageSize?: number },
): Promise<PageAccessPage> {
  await requireVerb(fga, args.userId, args.pageId, 'share') // #420 3b: grants/links/visibility = the share verb (manage passes via the superset)
  await requireNotTrashed(db, args.pageId) // Rider 2: no share surgery on a trashed page (uniform 404)
  // #574: paginated — a truncated read under-lists who has access.
  // #623: and it then returned everyone at once. The bound is a page of tuples and the marker is the
  // store's continuation token; there is no timestamp to order these by.
  //
  // ⚠️ The filters below run AFTER the read (relation, principal shape, custom-role expansion), and a
  // page object carries share links and markers too, so a page can hold ZERO grants while more follow.
  // The caller walks on the marker, never on emptiness — `listAllPageAccess` is that walk.
  const { tuples, nextCursor } = await readObjectTuplesPage(fga, `page:${args.pageId}`, {
    pageSize: args.pageSize ?? PAGE_ACCESS_PAGE_SIZE,
    ...(args.cursor ? { cursor: args.cursor } : {}),
  })
  // #163: resolve group grantee ids back to names for display (groupFgaId is one-way).
  // #623: this used to carry its own copy of the group-name query — the fourth in the product. It reads
  // the shared bounded one now, which walks its own pages.
  const byId = groupNameByFgaId(args.tenantId, await listAllGroupNames(db))
  // #582 / ADR-202 §1: a CUSTOM-role assignment expands into the same per-capability tuples a manual
  // grant writes, so without this filter one role renders as several anonymous capability rows for the
  // same principal — the defect #536 (5) was bounced for on the space screen, which fixed it
  // server-side. The page list needs the same half, or the dialog shows a role as its parts.
  //
  // A capability owned by a custom-role row is that row's expansion, not a separate grant — UNLESS the
  // same (principal, capability) also exists as a BUILT-IN row, in which case the tuple is the built-in
  // grant's own face and must stay or its revoke becomes unreachable. `manage` is never filtered: the
  // manager tuple can be the structural owner leaf, which no row represents.
  const customOwned = new Set<string>()
  const builtinOwned = new Set<string>()
  for (const r of await db.sql<{ principal: string; caps: string[] | null; builtin_capability: string | null }[]>`
    SELECT a.principal, COALESCE(r.capabilities, ARRAY[a.builtin_capability]) AS caps, a.builtin_capability
    FROM role_assignments a LEFT JOIN roles r ON r.id = a.role_id
    WHERE a.resource_type = 'page' AND a.resource_id = ${args.pageId}`) {
    for (const c of r.caps ?? []) (r.builtin_capability != null ? builtinOwned : customOwned).add(`${r.principal} ${c}`)
  }
  const out: { grantee: string; relation: PageRelation; groupName?: string; displayName?: string | null }[] = []
  for (const key of tuples) {
    const cap = capForFgaRelation(key.relation)
    if (!cap) continue // maps view_base→view, comment/edit/manage; skips space/view/comment_open
    // Direct member/group grants only — never expose share_link or the space link.
    if (!/^user:[^*\s]+$/.test(key.user) && !/^group:[^\s]+#member$/.test(key.user)) continue
    if (cap !== 'manage' && customOwned.has(`${key.user} ${cap}`) && !builtinOwned.has(`${key.user} ${cap}`)) continue
    const groupName = resolveGroupName(key.user, byId)
    out.push({ grantee: key.user, relation: cap, ...(groupName ? { groupName } : {}) })
  }
  // #578 (review rejection 2026-08-05): the dialog printed 70 characters of hex where a name belongs,
  // because this answer carried no name to print. The space list has resolved names since #523; the page
  // list simply never grew the same half, so the client had nothing to fall back FROM.
  //
  // Same shape, same reasoning as `/spaces/:id/access`: a VIEW-GATED set (the caller passed the `share`
  // verb above), so naming these principals is not a membership oracle — it is the set they already see.
  // Resolved on the caller's RLS handle, so a cross-tenant sub comes back ABSENT and the client says the
  // name is unknown rather than inventing one.
  const userSubs = out.filter((g) => g.grantee.startsWith('user:') && !g.groupName).map((g) => g.grantee.slice('user:'.length))
  if (userSubs.length > 0) {
    const ids = await resolveAuthorIdentities(db, userSubs)
    for (const g of out) {
      if (g.grantee.startsWith('user:') && !g.groupName) g.displayName = ids.get(g.grantee.slice('user:'.length))?.displayName ?? null
    }
  }
  return { grants: out, nextCursor }
}

/**
 * Everyone with a grant on a page, by walking.
 *
 * The permissions dialog is where a grant is taken away, so a short list is access nobody can revoke.
 * `pageSize` is a seam for the pin, not a caller knob: the empty-page shape this walk exists to survive
 * only happens when the pages are small enough for the filters to empty one.
 */
export async function listAllPageAccess(
  fga: OpenFgaClient,
  db: TenantDb,
  args: { pageId: string; tenantId: string; userId: string; pageSize?: number },
): Promise<PageAccessPage['grants']> {
  const out: PageAccessPage['grants'] = []
  let cursor: string | undefined
  do {
    const page: PageAccessPage = await listPageAccess(fga, db, { ...args, ...(cursor ? { cursor } : {}) })
    out.push(...page.grants)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return out
}

// Pages overview for a space (Phase 5 #5). space#manage gated — a manager sees the
// pages ONLY of a space they manage (RLS scopes to the tenant; the space#manage
// check is the authority), so nothing leaks beyond their authority. Per page:
// published state, the cheap unpublished-changes flag, the count of DIRECT page
// grants (user/group only — never share_link/wildcard/the space link), and the
// count of active share links.
export interface PageOverview {
  id: string; title: string; published: boolean; hasUnpublishedChanges: boolean; grantCount: number; linkCount: number
}
// #623 (review ruling): the page a space manager opens grew with the space. Every page came back in
// one response, each one costing an FGA read, and the screen drew all of them — so a space with a thousand
// pages was a thousand rows and a thousand reads.
//
// LIMIT with a CURSOR, not OFFSET: pages move (that is what `position` is for), and an offset silently
// skips or repeats a row when the list shifts under the reader. The cursor carries the tiebreaker the
// ORDER BY needs — `position` is not unique, so two pages sharing one would straddle a page boundary
// forever without the id.
//
// The search moves with it, in the same change. Filtering on the client while the server pages would turn
// "find a page in this space" into "find a page among the ones already fetched" — the same words, a
// quietly different question, and no way for the reader to tell.
export const PAGES_OVERVIEW_LIMIT = 50

export interface PageOverviewPage { items: PageOverview[]; nextCursor: string | null }

/** `position|id` — opaque to the client, which only ever hands it back. */
const encodeCursor = (position: number, id: string): string => `${position}|${id}`
const decodeCursor = (c: string | undefined): { position: number; id: string } | null => {
  const at = c?.lastIndexOf('|') ?? -1
  if (at == null || at <= 0) return null
  const position = Number(c!.slice(0, at))
  return Number.isFinite(position) ? { position, id: c!.slice(at + 1) } : null
}

/** #623 / ADR-220 §1: how many children one branch response may carry. */
export const BRANCH_PAGE_LIMIT = 100

export interface BranchPage { pages: Page[]; nextCursor: string | null }

/**
 * One BRANCH of the page tree: the children of one parent, ordered `position, created_at`.
 *
 * ADR-220 §1. The unit is a branch rather than a window over the whole space, because a DFS cursor
 * would encode a position in a traversal that changes whenever the reader opens a node — a cursor that
 * means something different on each request, which is the shape #574 called silent truncation.
 *
 * §8 — THE CURSOR NAMES THE ANCHOR ROW BY ID, and this resolves its `(position, created_at)` here.
 * `position` is user-controlled, not monotonic and NOT unique, and `rebalanceSiblings` rewrites every
 * sibling's position when a gap collapses; a renumber moves rows across a literal cursor value in both
 * directions, so rows can be SKIPPED — the direction that hides. A rebalance preserves visible order,
 * so an anchor resolved after one lands in the same place. An anchor that no longer exists restarts the
 * branch from the top rather than guessing, and the caller is told which it got.
 *
 * §2 — the caller NAMES the parent, which is new attack surface. `view` is confirmed on the parent
 * itself, and absent / another tenant's / another space's / invisible all answer ONE identical 404. Four
 * different answers would make the tree a membership oracle for page ids.
 *
 * §3 — parent visibility implies nothing about a child: a direct grant cascades down but a public grant
 * does not, and `private` propagates independently. Every row is confirmed on its own, and a row the
 * reader cannot see is ABSENT with no gap to infer it from.
 */
// #903: the root branch's gate, corrected. `space#viewer` is NOT the one relation every principal who
// may browse the tree holds — ADR-135 deliberately keeps a space EDIT share-link on `space#editor`
// alone (never `viewer`/`viewer_member`), so a share-link-only guest with an edit link never leaks the
// space's templates (`viewer_member` is what `template#view` reads). That split is correct for
// templates and wrong for the tree: an edit-link guest may edit — and therefore browse — every
// published, non-private page in the space, exactly as `page#edit_from_space` already grants per page.
// Checked as two relations rather than widening `viewer` itself, so the template boundary this exists
// to protect is untouched.
async function canOpenSpaceRoot(
  fga: OpenFgaClient, subject: string, spaceId: string, context?: { current_time: string },
): Promise<boolean> {
  if (await checkRelation(fga, subject, 'viewer', { type: 'space', id: spaceId }, context)) return true
  return checkRelation(fga, subject, 'editor', { type: 'space', id: spaceId }, context)
}

export async function listBranch(
  db: TenantDb,
  fga: OpenFgaClient,
  args: {
    spaceId: string
    parentId: string | null
    subject: string
    context?: { current_time: string }
    limit?: number
    cursor?: string
    // #903 / ADR-220 §14: a side channel, never a return field. `/pages/branch` returns this function's
    // result directly to the wire (member AND guest), so the invisible complement this callback exposes
    // must be structurally impossible to serialize — a function argument cannot appear in Fastify's JSON
    // output, where a `BranchPage` field could leak it by a caller simply forgetting to strip it.
    onInvisible?: (ids: string[]) => void
  },
): Promise<BranchPage & { restarted: boolean }> {
  const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 })
  const limit = Math.min(500, Math.max(1, args.limit ?? BRANCH_PAGE_LIMIT))

  // §2. The ROOT branch is gated on the space; a named parent is gated on itself, and every refusal
  // below answers the same 404 — including "this page is in a different space", which a caller could
  // otherwise use to test whether an id belongs here.
  if (args.parentId === null) {
    if (!(await canOpenSpaceRoot(fga, args.subject, args.spaceId, args.context))) {
      throw notFound()
    }
  } else {
    const [row] = await db.sql<[{ space_id: string; deleted_at: Date | null }?]>`
      SELECT space_id, deleted_at FROM pages WHERE id = ${args.parentId}`
    // absent, trashed, or in another space — one answer, and the tenant boundary is the RLS handle's
    if (!row || row.deleted_at || row.space_id !== args.spaceId) throw notFound()
    if (!(await checkRelation(fga, args.subject, 'view', { type: 'page', id: args.parentId }, args.context))) {
      throw notFound()
    }
  }

  // §8: resolve the anchor. A cursor naming a row that is gone restarts the branch — said out loud in
  // the answer, because the caller has to REPLACE what it holds rather than append to it.
  // ⚠️ The anchor's instant comes back as an EPOCH, not a Date. Handing the driver a timestamp loses
  // its microseconds, and pages created in one action are microseconds apart — measured right here: the
  // walk returned three children twice before this line said `extract(epoch …)`. Same defect this
  // ticket found in five other routes, made once more while fixing them.
  let anchor: { position: number; at: string } | null = null
  let restarted = false
  if (args.cursor) {
    const [row] = await db.sql<[{ position: number; at: string }?]>`
      SELECT position, extract(epoch from created_at)::text AS at FROM pages
       WHERE id = ${args.cursor} AND space_id = ${args.spaceId} AND deleted_at IS NULL`
    if (row) anchor = row
    else restarted = true
  }

  // §1: the home-page exclusion is a predicate on EVERY row, not a root-only filter — an implementer
  // reading an abridged version of this query would re-introduce the space home into the tree.
  const rows = await db.sql<PageRow[]>`
    SELECT p.id, p.tenant_id, p.space_id, p.parent_id, p.title, p.position, p.created_at, p.updated_at,
           p.has_unpublished_changes, (p.published_at IS NOT NULL) AS published, p.task_done, p.task_total
    FROM pages p JOIN spaces s ON s.id = p.space_id
    WHERE p.space_id = ${args.spaceId} AND p.deleted_at IS NULL
      AND (s.home_page_id IS NULL OR p.id != s.home_page_id)
      AND ${args.parentId === null ? db.sql`p.parent_id IS NULL` : db.sql`p.parent_id = ${args.parentId}`}
      ${anchor ? db.sql`AND (p.position, p.created_at) > (${anchor.position}, to_timestamp(${anchor.at}::numeric))` : db.sql``}
    ORDER BY p.position, p.created_at
    LIMIT ${limit + 1}
  `
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  // THE CURSOR COMES FROM THE LAST SQL ROW, NOT THE LAST VISIBLE ONE. The confirm below removes rows,
  // so a full page can yield none the reader may see; taking the anchor from the filtered result would
  // leave the walk with nothing to resume from and every child after it unreachable.
  const lastRow = page[page.length - 1]
  const nextCursor = hasMore && lastRow ? lastRow.id : null

  // #623 ①: which rows get a CHEVRON — "has a child THIS READER can see", one level down. The
  // child ids ride the SAME batchCheck as the rows (no new round trip); a row whose children are all
  // invisible answers "no children", which is the corrected reading of the leak: what must not be
  // told is "something you cannot see is here", and an invisible child reported as ABSENT tells
  // nothing. Capped per row: the cap's false negative (a visible child hiding behind CHEVRON_PROBE_CAP
  // invisible siblings) draws no chevron — accepted by the ruling, and strictly quieter than the lie
  // it replaces.
  const kids = page.length
    ? await db.sql<{ id: string; parent_id: string }[]>`
        SELECT id, parent_id FROM (
          SELECT p.id, p.parent_id,
                 ROW_NUMBER() OVER (PARTITION BY p.parent_id ORDER BY p.position, p.created_at) AS rn
          FROM pages p JOIN spaces s ON s.id = p.space_id
          WHERE p.parent_id = ANY(${page.map((r) => r.id)}) AND p.space_id = ${args.spaceId}
            AND p.deleted_at IS NULL AND (s.home_page_id IS NULL OR p.id != s.home_page_id)
        ) x WHERE rn <= ${CHEVRON_PROBE_CAP}`
    : []

  // §3: every row on its own — and now the probe children fold in. ONE batchCheck for both questions.
  const checked = new Set(await filterAuthorized(
    fga, args.subject, 'view', [...page.map((r) => r.id), ...kids.map((k) => k.id)], args.context))
  const visible = new Set(page.map((r) => r.id).filter((id) => checked.has(id)))
  const expandable = new Set(kids.filter((k) => checked.has(k.id)).map((k) => k.parent_id))

  // §4 placeholders are NOT resolved here any more (②): a rare feature must not tax every load.
  // The branch answers immediately; `/pages/tree-placeholders` serves the chains as a follow-up the
  // screen requests after painting. The invisible-children seeds it needs are re-derived there.
  //
  // #974: the lock/freeze glyphs (#109 Fix B / #329) never rode this route — `listBranch` backs both
  // `/pages/paint` and `/pages/branch` (the #623 lazy-tree split), and unlike `listPages` (the retired
  // whole-space read this replaced) it returned no badge at all, so every row's `private` was
  // `undefined` → the tree's lock badge could never appear even though `usePage`'s title badge (a
  // different endpoint, GET /pages/:id) computed it correctly. Same cache and invalidation as there
  // (`invalidatePageBadge` on every write) — a badge here is a display glyph, not an access decision.
  const visiblePages = page.filter((r) => visible.has(r.id))
  // #903 / ADR-220 §14: `page` (not `kids`) — the chevron probe's 3-per-row sample is a display hint,
  // not this branch's real child set, and would under-report the invisible complement the guest walk
  // needs to find hidden-behind-invisible-parent descendants.
  args.onInvisible?.(page.filter((r) => !visible.has(r.id)).map((r) => r.id))
  const badges = await mapBounded(visiblePages, 16, async (r) => {
    const hit = getCachedBadge(r.tenant_id, r.id)
    if (hit) return hit
    const fresh = await readPageBadges(fga, r.id).catch(() => ({ private: false, frozen: null as PageFreezeLevel | null }))
    setCachedBadge(r.tenant_id, r.id, fresh)
    return fresh
  })
  return {
    pages: visiblePages.map((r, i) => ({
      ...toPage(r), hasChildren: expandable.has(r.id), private: badges[i]!.private, frozen: badges[i]!.frozen,
    })),
    nextCursor,
    restarted,
  }
}

/**
 * How many siblings one level of the path walk may examine, shared across the whole chain.
 *
 * The rank query is a window function over ONE branch, so the cost is that branch's width. A budget
 * rather than a per-level cap because a chain of twelve 200-wide branches should not cost twelve times
 * what the ADR bounded; when it runs out the answer says `exhausted` and the sidebar stays put, which
 * is the state ADR-238 §2.3 already defined.
 */
export const PATH_SCAN_MAX = 2_000

/** One level of the path: the branch to fetch, and the cursor that puts the target's row inside it. */
export interface PagePathLevel {
  parentId: string | null
  /** null = the target is in the branch's FIRST window, which is what the paint already fetched. */
  cursor: string | null
}

/**
 * ADR-238 §2: WHERE is this row? Answered in one round trip, so the client never reads until it finds.
 *
 * The sidebar's problem is not that it cannot reach a deep row — `paintTree` already fetches the branch
 * of every ancestor. It is that each of those branches comes back as its FIRST window, and the row the
 * reader opened may be the 400th child. The naive fix is a client loop over `more:` until the row shows
 * up, which is unbounded in exactly the shape #705 / #710 ruled against, and the cost lands on whoever
 * was merely sent a link. The server already knows the ordering, so it can say which window to ask for.
 *
 * ⚠️ THE RANK IS COUNTED OVER THE UNFILTERED SQL ORDERING, not over the rows the reader may see, because
 * that is what `listBranch` pages over: it takes `limit + 1` SQL rows and only then drops the ones the
 * reader cannot view. A rank computed after the authorization filter would name a window that does not
 * contain the target — and would do it only for readers who cannot see some of its siblings, which is the
 * hardest kind of bug to be told about.
 *
 * ⚠️ The cursor may therefore name a row the caller cannot view — and this is NOT a new disclosure:
 * `listBranch` already hands back `nextCursor` taken from the last SQL row rather than the last visible
 * one, for the same reason (a cursor from the filtered set leaves the walk unable to resume). This route
 * says nothing a branch fetch would not have said, which is the property ADR-238 §2.2 requires.
 *
 * The refusals are `listBranch`'s, unchanged: a page that is absent, trashed, in another space, or one
 * the caller cannot view all answer ONE 404, so the route cannot be used to test whether an id exists.
 */
export async function pathToPage(
  db: TenantDb,
  fga: OpenFgaClient,
  args: {
    spaceId: string
    pageId: string
    subject: string
    context?: { current_time: string }
    limit?: number
    /**
     * The scan budget, so the bound can be MEASURED with a small fixture rather than by reading
     * `PATH_SCAN_MAX`. The route never sets it; a pin that asserted the constant would still pass on
     * an implementation that scanned the whole branch and then compared.
     */
    scanMax?: number
  },
): Promise<{ levels: PagePathLevel[]; exhausted: boolean }> {
  const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 })
  // The same clamp `listBranch` applies, because the cursor is only correct for the window size the
  // client will actually ask for. A path computed for 30 and fetched with 100 lands short.
  const limit = Math.min(500, Math.max(1, args.limit ?? BRANCH_PAGE_LIMIT))

  const [target] = await db.sql<[{ space_id: string; deleted_at: Date | null }?]>`
    SELECT space_id, deleted_at FROM pages WHERE id = ${args.pageId}`
  if (!target || target.deleted_at || target.space_id !== args.spaceId) throw notFound()
  if (!(await checkRelation(fga, args.subject, 'view', { type: 'page', id: args.pageId }, args.context))) {
    throw notFound()
  }

  // The ancestors, root-first, inside this space — the same recursive walk and the same depth cap
  // `paintTree` uses. Reusing the bound is the point: ADR-238 §2.3 chose not to invent a second one.
  const rows = await db.sql<{ id: string; parent_id: string | null; depth: number }[]>`
    WITH RECURSIVE anc AS (
      SELECT id, parent_id, 0 AS depth FROM pages
       WHERE id = ${args.pageId} AND space_id = ${args.spaceId} AND deleted_at IS NULL
      UNION ALL
      SELECT p.id, p.parent_id, anc.depth + 1 FROM pages p
        JOIN anc ON p.id = anc.parent_id
       WHERE p.space_id = ${args.spaceId} AND p.deleted_at IS NULL AND anc.depth < ${MAX_PAGE_DEPTH}
    )
    SELECT id, parent_id, depth FROM anc ORDER BY depth DESC
  `
  // The walk stopped at the cap while a parent was still named: the chain we hold does not reach the
  // root, so the levels below are un-fetchable and the honest answer is "as far as I got".
  // A chain that does not reach the root cannot be anchored: the branch holding its topmost row is one
  // we never found, so there is no first level to hand the client. Saying `exhausted` with no levels is
  // the honest answer, and it is the state §2.3 already defines — the sidebar leaves the reader put.
  const top = rows[0]
  if (!top || top.parent_id) return { levels: [], exhausted: true }
  // Root-first. Level i fetches the branch of chain[i-1] (the root branch for i = 0) and wants chain[i]
  // inside its window.
  const chain = rows.map((r) => r.id)

  const levels: PagePathLevel[] = []
  let exhausted = false
  let budget = Math.max(1, args.scanMax ?? PATH_SCAN_MAX)
  for (let i = 0; i < chain.length; i++) {
    const childId = chain[i]!
    const parentId = i === 0 ? null : chain[i - 1]!
    // The branch's own gate, identical to `listBranch`'s §2 — an ancestor the reader cannot view
    // truncates the path rather than failing it, exactly as `paintTree` truncates its paint.
    const ok = parentId === null
      ? await canOpenSpaceRoot(fga, args.subject, args.spaceId, args.context)
      : await checkRelation(fga, args.subject, 'view', { type: 'page', id: parentId }, args.context)
    if (!ok) { exhausted = true; break }
    if (budget <= 0) { exhausted = true; break }
    // `sib` is the branch exactly as `listBranch` reads it — same predicates, same order, home page
    // excluded on every row. `t` is the target's 0-based rank; the cursor is the LAST row of the window
    // before the target's, because the branch cursor is exclusive.
    const [found] = await db.sql<[{ rank: string; cursor: string | null }?]>`
      WITH sib AS (
        SELECT p.id, ROW_NUMBER() OVER (ORDER BY p.position, p.created_at) - 1 AS rn
        FROM pages p JOIN spaces s ON s.id = p.space_id
        WHERE p.space_id = ${args.spaceId} AND p.deleted_at IS NULL
          AND (s.home_page_id IS NULL OR p.id != s.home_page_id)
          AND ${parentId === null ? db.sql`p.parent_id IS NULL` : db.sql`p.parent_id = ${parentId}`}
        ORDER BY p.position, p.created_at
        LIMIT ${budget}
      ), t AS (SELECT rn FROM sib WHERE id = ${childId})
      SELECT t.rn::text AS rank,
             (SELECT s2.id FROM sib s2 WHERE s2.rn = (t.rn / ${limit}) * ${limit} - 1) AS cursor
        FROM t`
    // Not inside the scanned prefix: the row is further out than the walk is allowed to look, so the
    // chain stops here rather than pointing the client at a window that does not hold it.
    if (!found) { exhausted = true; break }
    budget -= Number(found.rank) + 1
    levels.push({ parentId, cursor: found.cursor })
  }
  return { levels, exhausted }
}

/**
 * #623 ②: §4's placeholder chains, as a FOLLOW-UP — never on the paint path.
 *
 * Resolving them inline read a creator's whole grant roster on every branch of every cold open
 * (728 tuples measured on dev) for a feature that is rare in the data. The screen paints first and
 * then asks this; the unnamed rows arrive a beat later. §2's gate is unchanged — the caller still
 * names a parent, and every refusal is the same 404 the branch route answers.
 */
export async function branchPlaceholders(
  db: TenantDb,
  fga: OpenFgaClient,
  args: {
    spaceId: string
    parentId: string | null
    subject: string
    tenantId: string
    groups: string[]
    context?: { current_time: string }
  },
): Promise<{ placeholders: PlaceholderNode[]; placeholdersExhausted: boolean }> {
  const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 })
  if (args.parentId === null) {
    if (!(await canOpenSpaceRoot(fga, args.subject, args.spaceId, args.context))) {
      throw notFound()
    }
  } else {
    const [row] = await db.sql<[{ space_id: string; deleted_at: Date | null }?]>`
      SELECT space_id, deleted_at FROM pages WHERE id = ${args.parentId}`
    if (!row || row.deleted_at || row.space_id !== args.spaceId) throw notFound()
    if (!(await checkRelation(fga, args.subject, 'view', { type: 'page', id: args.parentId }, args.context))) {
      throw notFound()
    }
  }
  // Path 2's seeds, re-derived: the branch's direct children the reader cannot view. The derivation
  // spends the same budget the resolver walks with, so "seed finding" cannot become an unmetered walk.
  const budget = { left: PLACEHOLDER_NODE_MAX }
  const rows = await db.sql<{ id: string }[]>`
    SELECT p.id FROM pages p JOIN spaces s ON s.id = p.space_id
    WHERE p.space_id = ${args.spaceId} AND p.deleted_at IS NULL
      AND (s.home_page_id IS NULL OR p.id != s.home_page_id)
      AND ${args.parentId === null ? db.sql`p.parent_id IS NULL` : db.sql`p.parent_id = ${args.parentId}`}
    ORDER BY p.position, p.created_at
    LIMIT ${PLACEHOLDER_NODE_MAX}`
  budget.left -= rows.length
  const seen = new Set(await filterAuthorized(fga, args.subject, 'view', rows.map((r) => r.id), args.context))
  return resolveTreePlaceholders(db, fga, {
    spaceId: args.spaceId, tenantId: args.tenantId, branchParentId: args.parentId,
    subject: args.subject, groups: args.groups,
    invisibleChildIds: rows.filter((r) => !seen.has(r.id)).map((r) => r.id),
    budget,
    ...(args.context ? { context: args.context } : {}),
    toPage: (row) => toPage(row as unknown as PageRow) as unknown as { id: string },
  })
}

/**
 * #623 ①: how many children one row's chevron probe may examine. The probe rides the row
 * batchCheck (~23ms/id measured), so this bounds the paint's extra cost at rows×cap in the worst
 * case and ~1×rows in the common one (most rows have few children).
 */
export const CHEVRON_PROBE_CAP = 3

export interface PaintedBranch { parentId: string | null; pages: Page[]; nextCursor: string | null }

/**
 * The FIRST PAINT: the root branch, plus the branches along the path to the page the reader has open.
 *
 * ADR-220 §5. Opening a page deep in a tree must not require walking down to it, and no mechanism for
 * this existed — there are ancestor CTEs for watches and for depth, but no "path to page" tree read.
 *
 * ⚠️ `open` is a HINT, never an argument. The sidebar knows the open page id, but the space it pairs it
 * with comes from localStorage and can disagree until the page loads. A page in another space, a page
 * that is gone, a page the reader cannot see — all yield THE ROOT BRANCH ALONE. Never an error, never a
 * different shape: a hint that 404s is an oracle for page ids.
 *
 * Every branch here is the same bounded, individually-confirmed read as §1's, so the response grows with
 * the DEPTH of the open page (bounded by MAX_PAGE_DEPTH) rather than with the size of the space.
 */
export async function paintTree(
  db: TenantDb,
  fga: OpenFgaClient,
  args: {
    spaceId: string
    subject: string
    context?: { current_time: string }
    open?: string | undefined
    limit?: number
  },
): Promise<{ branches: PaintedBranch[] }> {
  // #623 ②: the paint resolves NO placeholder chains — that walk read a creator's whole grant
  // roster (728 tuples, measured) on every cold open, for a feature that is rare in the data. The
  // screen asks `/pages/tree-placeholders` AFTER painting; nothing visible waits for it.
  const one = async (parentId: string | null): Promise<PaintedBranch> => {
    const b = await listBranch(db, fga, {
      spaceId: args.spaceId, parentId, subject: args.subject,
      ...(args.context ? { context: args.context } : {}),
      ...(args.limit != null ? { limit: args.limit } : {}),
    })
    return { parentId, pages: b.pages, nextCursor: b.nextCursor }
  }

  const branches: PaintedBranch[] = [await one(null)]
  if (!args.open) return { branches }

  // The ancestors of the open page, nearest-first, INSIDE this space.
  //
  // ⚠️ The space predicates here are the SECOND layer and cannot be broken to red on their own —
  // measured. Remove both and a cross-space ancestor still never reaches the answer, because `one()`
  // goes through `listBranch`, whose §2 parent check refuses a page in another space with the same 404
  // every other refusal gets. They stay because the walk should not travel outside the space it was
  // asked about even for a row it will then discard; the guarantee itself is pinned one layer down, on
  // the branch route.
  const rows = await db.sql<{ id: string }[]>`
    WITH RECURSIVE anc AS (
      SELECT id, parent_id, 0 AS depth FROM pages
       WHERE id = ${args.open} AND space_id = ${args.spaceId} AND deleted_at IS NULL
      UNION ALL
      SELECT p.id, p.parent_id, anc.depth + 1 FROM pages p
        JOIN anc ON p.id = anc.parent_id
       WHERE p.space_id = ${args.spaceId} AND p.deleted_at IS NULL AND anc.depth < ${MAX_PAGE_DEPTH}
    )
    SELECT id FROM anc WHERE depth > 0 ORDER BY depth DESC
  `
  // Each ancestor's OWN branch — the reader needs its siblings to see where they are. The open page's
  // own children are not painted: it may be a leaf, and expanding it is a branch request like any other.
  for (const r of rows) {
    // §2 lives inside listBranch: an ancestor the reader cannot view throws, and a hint must not. So a
    // refusal here truncates the painted path rather than failing the paint.
    try {
      branches.push(await one(r.id))
    } catch {
      break
    }
  }
  return { branches }
}

/**
 * #623 / ADR-220 §6.2: how many rows a GUEST's whole-space tree may show.
 *
 * The guest shell draws this list unvirtualised and fully expanded, so it is the surface where an
 * enormous tree actually costs the reader something. The cap comes with a visible state — never a quiet
 * cut — because a link whose tree is too large to draw should say so rather than look complete.
 */
export const GUEST_TREE_CAP = 500

/**
 * #903 / ADR-220 §13: the guest whole-space read, bounded by TREE CLOSURE rather than a flat slice.
 *
 * The shipped cap (§6.2) sliced `listPages`'s output AFTER `listPages` had already run a `view` Check
 * (and a badge read) on every non-deleted page in the space — a 5,000-page space paid 5,000 Checks to
 * show 500 rows, on every load. A flat SQL `LIMIT` is not a safe fix: `dfsOrder` re-parents a row whose
 * parent fell outside the cut to the ROOT, a wrong tree shown quietly — worse than a loud cap.
 *
 * This walks the tree in DFS pre-order (roots and their subtrees before later siblings, matching the
 * client's layout) one BRANCH at a time via `listBranch` — reusing §1-3's already-reviewed shape
 * (parent-confirm, per-node confirm, home-page exclusion) rather than inventing a new authz pattern —
 * and stops the instant `GUEST_TREE_CAP` VISIBLE pages have been confirmed. A page is pushed to
 * `visible` before its own children are ever fetched, so the ancestor-inclusion invariant ("a page's
 * ancestors are included whenever the page is") holds structurally. A subtree behind a page whose
 * CHEVRON probe found no visible child (`hasChildren` false) is never walked, so an entirely-invisible
 * subtree costs nothing beyond the one batched check that found it so.
 *
 * `truncated` is computed from the closure exhausting its budget — the walk keeps looking for exactly
 * one more CONFIRMED-VISIBLE page after the cap-th, and only reports truncation if it finds one. A tree
 * with precisely `GUEST_TREE_CAP` visible pages and nothing past them is NOT truncated; a flat length
 * compare cannot tell the two apart, which is the quiet lie this section exists to avoid.
 */
export async function listPagesGuestBounded(
  db: TenantDb,
  fga: OpenFgaClient,
  // `cap` defaults to the shipped GUEST_TREE_CAP; a caller (the pin) may override it to exercise the
  // truncation arithmetic against a small, cheap-to-build fixture without changing the shipped constant.
  // `placeholderBudget` defaults to the shipped PLACEHOLDER_NODE_MAX for the same reason (§14 below).
  args: { spaceId: string; subject: string; context?: { current_time: string }; cap?: number; placeholderBudget?: number },
): Promise<{ pages: Page[]; truncated: boolean }> {
  const cap = args.cap ?? GUEST_TREE_CAP
  const visible: Page[] = []
  let truncated = false
  // #903 / ADR-220 §14: a SEPARATE budget from `cap`. `cap` bounds what the tree DISPLAYS (confirmed
  // VISIBLE rows); this bounds what the walk may EXAMINE while descending through invisible territory
  // looking for more of them — the same two-dimension split §4.3 already draws for the member path.
  // Conflating them would let one all-draft space with a deep visible leaf spend the whole display cap
  // just walking invisible parents, before a single real row is shown.
  const placeholderBudget = { left: args.placeholderBudget ?? PLACEHOLDER_NODE_MAX }
  let placeholdersExhausted = false
  const toTreePage = (row: unknown) => toPage(row as PageRow) as unknown as { id: string; [k: string]: unknown }

  const walk = async (parentId: string | null): Promise<void> => {
    let cursor: string | undefined
    const invisibleIds: string[] = []
    for (;;) {
      if (truncated) return
      const branch = await listBranch(db, fga, {
        spaceId: args.spaceId, parentId, subject: args.subject, context: args.context, cursor, limit: BRANCH_PAGE_LIMIT,
        onInvisible: (ids) => invisibleIds.push(...ids),
      })
      for (const p of branch.pages) {
        if (visible.length >= cap) { truncated = true; return }
        visible.push(p)
        // #903 design-review NOT gated on `hasChildren`. That flag is `listBranch`'s CHEVRON
        // probe (CHEVRON_PROBE_CAP = 3 children) — a display hint whose false negative was accepted by
        // #623 because the cost was "no expand arrow drawn". Using it to decide whether to
        // recurse turns that same false negative into a dropped, CONFIRMED-VISIBLE page: a parent with
        // 4+ children whose first 3 (by position) are all invisible reports `hasChildren: false` even
        // when its 4th child is visible, and the old code never looked past that. Every visible page's
        // children are walked unconditionally; a subtree that turns out to have no visible descendant
        // costs one more (typically empty) `listBranch` call, not a budget slot — §13(a)'s own
        // condition ("a page whose subtree is entirely invisible must not consume closure budget
        // without producing a visible row") is about the CAP counter, not query count.
        await walk(p.id)
        if (truncated) return
      }
      if (!branch.nextCursor) break
      cursor = branch.nextCursor
    }
    if (truncated || !invisibleIds.length) return
    // #903 / ADR-220 §14: path 2 only, volunteered flat in THIS response — the defect ADR-220
    // §4.4's "the guest tree still re-roots (#245)" promised and §13(a)'s closure walk broke, because it
    // can never descend past a parent it is not allowed to view. `parentId` here is every invisible id
    // this branch's own read just found (the seeds), never re-derived by a second query.
    if (placeholderBudget.left <= 0) { placeholdersExhausted = true; return }
    const { pages: found, exhausted } = await resolveGuestPlaceholders(db, fga, {
      spaceId: args.spaceId, subject: args.subject, context: args.context,
      invisibleChildIds: invisibleIds, toPage: toTreePage, budget: placeholderBudget,
    })
    if (exhausted) placeholdersExhausted = true
    for (const pg of found) {
      if (visible.length >= cap) { truncated = true; return }
      visible.push(pg as unknown as Page)
      await walk(pg.id as string)
      if (truncated) return
    }
  }

  try {
    await walk(null)
  } catch (err) {
    // `listBranch`'s root check 404s for ITS OWN callers (§2's uniform-404 — a named branch id must not
    // become a membership oracle), but the whole-space route this feeds has always answered 200 with an
    // empty (or partial) list for a guest whose grant does not reach the root at all — an expired or
    // revoked link, most commonly. Reproducing a 404 here would be a NEW, stricter failure mode nothing
    // asked for; catching it and reporting "nothing visible" matches what the per-page confirm loop this
    // replaced would have answered anyway (every page denied, zero rows), just without paying for it.
    // Scoped to the ROOT specifically (nothing fetched yet) — a 404 reached after some pages were
    // already found is a genuine anomaly (e.g. a page deleted mid-walk) and propagates as one, the same
    // as it would from a direct `listBranch` caller.
    if ((err as { statusCode?: number }).statusCode !== 404 || visible.length > 0) throw err
    return { pages: visible, truncated: false }
  }
  // #903 / ADR-220 §14: placeholder-budget exhaustion folds into the SAME `truncated` flag — §6.2's
  // "never a quiet cut" applies to this failure mode too, and the guest shell has exactly one signal
  // for "this tree may be incomplete" already; a second wire field for the same idea is not warranted.
  return { pages: visible, truncated: truncated || placeholdersExhausted }
}

/** #623 / ADR-220 §6.1: how many pages one FLAT listing may carry. */
export const FLAT_PAGES_LIMIT = 200

/**
 * The space's pages as a FLAT list, bounded and keyset-paged.
 *
 * ADR-220 §6.1. The MCP `list_pages` tool reads the tree as a flat full listing, and branch paging is
 * meaningless to it — a bound bolted onto that shape would be exactly the silent truncation this ticket
 * exists to remove. So it keeps the flat contract and gets an explicit bound WITH a cursor, and the
 * tool's answer says when there is more.
 *
 * The anchor is a ROW ID whose `(position, created_at)` is resolved per request, for §8's reason:
 * `position` is user-controlled and a sibling renumber crosses a literal cursor in both directions.
 */
export async function listPagesFlat(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { spaceId: string; subject: string; context?: { current_time: string }; limit?: number; cursor?: string },
): Promise<{ pages: Page[]; nextCursor: string | null }> {
  const limit = Math.min(1000, Math.max(1, args.limit ?? FLAT_PAGES_LIMIT))
  let anchor: { position: number; at: string } | null = null
  if (args.cursor) {
    const cursor = args.cursor
    const [row] = await db.sql<[{ position: number; at: string }?]>`
      SELECT position, extract(epoch from created_at)::text AS at FROM pages
       WHERE id = ${cursor} AND space_id = ${args.spaceId} AND deleted_at IS NULL`
    if (row) anchor = row
  }
  const rows = await db.sql<PageRow[]>`
    SELECT p.id, p.tenant_id, p.space_id, p.parent_id, p.title, p.position, p.created_at, p.updated_at,
           p.has_unpublished_changes, (p.published_at IS NOT NULL) AS published, p.task_done, p.task_total
    FROM pages p JOIN spaces s ON s.id = p.space_id
    WHERE p.space_id = ${args.spaceId} AND p.deleted_at IS NULL
      AND (s.home_page_id IS NULL OR p.id != s.home_page_id)
      ${anchor ? db.sql`AND (p.position, p.created_at) > (${anchor.position}, to_timestamp(${anchor.at}::numeric))` : db.sql``}
    ORDER BY p.position, p.created_at
    LIMIT ${limit + 1}
  `
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  // The anchor comes from the last SQL row, not the last VISIBLE one: the confirm below removes rows,
  // so a full page can yield none the caller may see — and resuming from the filtered result would
  // leave everything after it unreachable.
  const lastRow = page[page.length - 1]
  const visible = new Set(await filterAuthorized(fga, args.subject, 'view', page.map((r) => r.id), args.context))
  return {
    pages: page.filter((r) => visible.has(r.id)).map(toPage),
    nextCursor: hasMore && lastRow ? lastRow.id : null,
  }
}

export async function listSpacePagesOverview(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { spaceId: string; userId: string; limit?: number; cursor?: string; q?: string },
): Promise<PageOverviewPage> {
  const canManage = await check(fga, `user:${args.userId}`, 'manage', { type: 'space', id: args.spaceId })
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  const limit = Math.min(200, Math.max(1, args.limit ?? PAGES_OVERVIEW_LIMIT))
  const after = decodeCursor(args.cursor)
  const q = (args.q ?? '').trim()
  // one row past the limit answers "is there more" without a second count query
  const rows = await db.sql<{ id: string; title: string; published: boolean; has_unpublished_changes: boolean; link_count: number; position: number }[]>`
    SELECT p.id, p.title, (p.published_at IS NOT NULL) AS published, p.has_unpublished_changes, p.position,
           count(sl.id) FILTER (WHERE sl.revoked_at IS NULL)::int AS link_count
    FROM pages p
    LEFT JOIN share_links sl ON sl.resource_type = 'page' AND sl.resource_id = p.id
    WHERE p.space_id = ${args.spaceId} AND p.deleted_at IS NULL
      ${q ? db.sql`AND p.title ILIKE ${'%' + q + '%'}` : db.sql``}
      ${after ? db.sql`AND (p.position, p.id) > (${after.position}, ${after.id})` : db.sql``}
    GROUP BY p.id, p.title, p.published_at, p.has_unpublished_changes, p.position, p.created_at
    ORDER BY p.position, p.id
    LIMIT ${limit + 1}
  `
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const out: PageOverview[] = []
  for (const r of page) {
    const tuples = await readObjectTuples(fga, `page:${r.id}`) // #574: paginated — this number is "who can reach this page"
    let grantCount = 0
    for (const key of tuples) {
      // #218 / ADR-103: direct member/group grants live on the *_direct leaves now (+ comment). capForFgaRelation
      // recognises exactly those grant relations (null for space/parent/private/restricted/view_base@user:*).
      if (!key || capForFgaRelation(key.relation) === null) continue
      if (!/^user:[^*\s]+$/.test(key.user) && !/^group:[^\s]+#member$/.test(key.user)) continue
      grantCount++
    }
    out.push({ id: r.id, title: r.title, published: r.published, hasUnpublishedChanges: r.has_unpublished_changes, grantCount, linkCount: r.link_count })
  }
  const last = page[page.length - 1]
  return { items: out, nextCursor: hasMore && last ? encodeCursor(last.position, last.id) : null }
}

// All descendant page ids of root (RLS-scoped to the tenant), via the parent_id tree.
// #218 / ADR-103: a dummy subject for `check(private)` — private is `[user:*, ...] or private from parent`, so
// ANY user matches iff the page (or an ancestor) is effectively private. Used to detect a move's private change.
const MOVE_PRIVATE_PROBE = 'user:__move_private_probe__'

// #218 / ADR-103 Addendum 3: the move write-boundary. When a move makes the subtree (effective-)private, strip
// each descendant's DIRECT public grant + sweep its share-links (the model can't subtract those, so they'd
// survive the inherited private as live holes). When the effective-private state changed either way, reindex
// the subtree (the search denorm/is_public depends on it). `alreadyReindexed` skips the reindex for the
// cross-space path (which reindexes for the space-denorm change already).
async function applyMovePrivacyBoundary(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { rootId: string; tenantId: string; userId: string; stripSweep: boolean; reindex: boolean; wasDeliverable?: Map<string, boolean> },
): Promise<void> {
  const subtree = [args.rootId, ...(await descendantIds(db.sql, args.rootId))]
  let unremoved: string[] = []
  if (args.stripSweep) {
    // Same rule as setPagePrivate's strip: "was not public" is convergence, a refusal is not. The move has
    // made this subtree effectively private, and `view_base`'s `[user:*]` arm is not private-guarded, so a
    // survivor here is a page the move was supposed to close and did not — the caller has to hear it.
    const stillPublic: string[] = []
    for (const id of subtree) {
      await deleteTuples(fga, [PUBLIC_GRANT(id)]).catch((e) => { if (!isAlreadyConverged(e)) stillPublic.push(id) })
    }
    for (const id of subtree) {
      const { revoked } = await revokeResourceShareLinks(db, fga, { type: 'page', id }, args.tenantId, args.userId)
      // ⚠️ #862 / ADR-108 §G: the same defect as setPagePrivate's, one step further back — the MOVE is
      // what made this subtree private, and it has already landed by the time this runs, so nothing
      // here could read the pre-move answer. The caller takes it before the move and hands it down.
      for (const link of revoked) emit({ type: 'share_link.revoked', tenantId: args.tenantId, shareLinkId: link.id, pageId: link.pageId, actorId: args.userId, pageWasDeliverable: args.wasDeliverable?.get(link.pageId) ?? false })
    }
    // Remembered, not thrown yet: the reindex below is part of the fail-safe work, and #622's re-review
    // caught this raise jumping over it — the search denorm would have kept the pre-move state for a
    // subtree whose move DID happen. Read-time re-checks mean that was staleness rather than a leak, but
    // "raise only after everything that can still be done, has been" is the rule the sibling path follows
    // and this one now follows it too.
    unremoved = stillPublic;
  }
  if (args.reindex) {
    const oids = await db.tx(async (tx) => {
      const os: string[] = []
      for (const id of subtree) os.push(await enqueueOutbox(tx, { tenantId: args.tenantId, pageId: id, operation: 'upsert' }))
      return os
    })
    subtree.forEach((id, i) => processOutboxAsync(driver, oids[i]!, { tenantId: args.tenantId, pageId: id, operation: 'upsert' }))
  }
  if (unremoved.length) {
    console.error('[applyMovePrivacyBoundary] public grant survived — these pages are still anonymously readable', { rootId: args.rootId, stillPublic: unremoved })
    throw Object.assign(new Error('the move made this subtree private, but a public grant could not be removed'), {
      statusCode: 500, code: 'public_grant_not_removed', pages: unremoved,
    })
  }
}

// #689: every parent-chain CTE in this family carries a depth guard, and hitting it is an ERROR, not a
// clamp. A parent cycle — the concurrent-move TOCTOU movePage now locks against, or direct SQL outside
// the API — made these walks spin forever: one ancestorDepth query was measured running for 5 days,
// holding its pooled connection, and each request touching the cyclic family eats another connection
// until the tenant starves. A silent clamp would be worse than the error: these walks feed the
// create/move depth guards, and a truncated answer makes those guards approve what they should refuse.
// Legal trees stay strictly below the cap (a page holds at most MAX_PAGE_DEPTH ancestors), so the only
// way to reach it is structural corruption — say so, loudly.
// (PAGE_TREE_WALK_CAP is declared just under MAX_PAGE_DEPTH below — it is derived from it, and these
// functions only read it at call time.)

function pageTreeCorrupt(where: string, id: string): Error {
  console.error('[pageTreeWalk] parent chain exceeded PAGE_TREE_WALK_CAP — the page tree is corrupt (parent cycle or over-deep rows)', { where, id })
  return Object.assign(new Error('page tree is corrupt — a parent walk exceeded the structural cap'), {
    statusCode: 500, code: 'page_tree_corrupt',
  })
}

// The Sql-tag parameter (not TenantDb): movePage calls these INSIDE its serializing transaction, so the
// walk and the UPDATE it protects read the same snapshot under the same advisory lock (#689).
export async function descendantIds(sql: Sql, rootId: string): Promise<string[]> {
  const rows = await sql<{ id: string; depth: number }[]>`
    WITH RECURSIVE d AS (
      SELECT id, 1 AS depth FROM pages WHERE parent_id = ${rootId}
      UNION ALL
      SELECT p.id, d.depth + 1 FROM pages p JOIN d ON p.parent_id = d.id
       WHERE d.depth < ${PAGE_TREE_WALK_CAP}
    )
    SELECT id, depth FROM d
  `
  if (rows.some((r) => r.depth >= PAGE_TREE_WALK_CAP)) throw pageTreeCorrupt('descendantIds', rootId)
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

// #689: the walk cap the three parent-chain CTEs above/below refuse at. +2 is margin, not headroom —
// rows deeper than MAX_PAGE_DEPTH but under the cap (pre-guard data) still answer rather than 500, while
// a cycle always reaches the cap. ONE derived constant so the write-boundary cap and the walk cap cannot
// drift apart.
export const PAGE_TREE_WALK_CAP = MAX_PAGE_DEPTH + 2

// Depth of a page = its number of ancestors (0 for a top-level page). Walks parent_id up to the root.
export async function ancestorDepth(sql: Sql, id: string): Promise<number> {
  const rows = await sql<{ parent_id: string | null; depth: number }[]>`
    WITH RECURSIVE anc AS (
      SELECT parent_id, 0 AS depth FROM pages WHERE id = ${id}
      UNION ALL
      SELECT p.parent_id, anc.depth + 1 FROM pages p JOIN anc ON p.id = anc.parent_id
       WHERE anc.parent_id IS NOT NULL AND anc.depth < ${PAGE_TREE_WALK_CAP}
    )
    SELECT parent_id, depth FROM anc
  `
  if (rows.some((r) => r.depth >= PAGE_TREE_WALK_CAP)) throw pageTreeCorrupt('ancestorDepth', id)
  return rows.filter((r) => r.parent_id != null).length
}

// Height of the subtree rooted at `id` = the deepest descendant's distance below it (0 for a leaf).
export async function subtreeHeight(sql: Sql, id: string): Promise<number> {
  const [r] = await sql<[{ h: number }]>`
    WITH RECURSIVE d AS (
      SELECT id, 0 AS lvl FROM pages WHERE id = ${id}
      UNION ALL
      SELECT p.id, d.lvl + 1 FROM pages p JOIN d ON p.parent_id = d.id
       WHERE d.lvl < ${PAGE_TREE_WALK_CAP}
    )
    SELECT COALESCE(MAX(lvl), 0)::int AS h FROM d
  `
  const h = r?.h ?? 0
  if (h >= PAGE_TREE_WALK_CAP) throw pageTreeCorrupt('subtreeHeight', id)
  return h
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
    // #574: paginated — missing the old page#space tuple here silently LEAVES THE PAGE BEHIND on a
    // space move (the write below only fires for pages seen to carry the old link).
    const keys = await readObjectTuples(fga, `page:${id}`)
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
      // #578 leftover, caught by #622's review: this matched FGA's prose, and #578 replaced that prose at
      // the tuple-helper boundary — so the branch became UNREACHABLE and a page whose parent tuple was
      // already gone started failing its move with a 500. Asked by code now, like every other site.
      if (!isAlreadyConverged(err)) throw err
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
  const [page] = await db.sql<(PageRow & { deleted_at: Date | null })[]>`
    SELECT id, tenant_id, space_id, parent_id, title, position, created_at, updated_at, deleted_at
    FROM pages WHERE id = ${args.pageId}
  `
  // Trashed ≡ absent (#411): a trashed page can't be moved (the FGA marker would deny anyway, but a 403
  // there would reveal existence — keep the uniform 404).
  if (!page || page.deleted_at) throw Object.assign(new Error('not found'), { statusCode: 404 })

  const newParent = args.parentId ?? null
  let targetSpace = args.spaceId ?? page.space_id
  if (newParent) {
    const [p] = await db.sql<{ space_id: string; deleted_at: Date | null }[]>`SELECT space_id, deleted_at FROM pages WHERE id = ${newParent}`
    // Trashed ≡ absent (#411): nothing can be moved INTO the trash via a stale parent id.
    if (!p || p.deleted_at) throw Object.assign(new Error('parent not found'), { statusCode: 400 })
    if (args.spaceId != null && p.space_id !== args.spaceId) {
      throw Object.assign(new Error('parent not in target space'), { statusCode: 400 })
    }
    targetSpace = p.space_id // the parent's space is authoritative for the destination
  }
  const crossSpace = targetSpace !== page.space_id

  // #364 / ADR-157 §3: the space HOME is a LEAF (v1). Two refusals, both 400: the home itself cannot be
  // re-parented under anything (it lives at the space root), and nothing can be moved UNDER the home.
  const [homeOfTarget] = await db.sql<[{ home_page_id: string | null }?]>`SELECT home_page_id FROM spaces WHERE id = ${targetSpace}`
  const [homeOfSource] = crossSpace
    ? await db.sql<[{ home_page_id: string | null }?]>`SELECT home_page_id FROM spaces WHERE id = ${page.space_id}`
    : [homeOfTarget]
  if (homeOfSource?.home_page_id === args.pageId && newParent != null) {
    throw Object.assign(new Error('the space home is a leaf (v1) — it cannot be nested'), { statusCode: 400 })
  }
  if (newParent != null && homeOfTarget?.home_page_id === newParent) {
    throw Object.assign(new Error('the space home is a leaf (v1) — pages cannot be moved under it'), { statusCode: 400 })
  }

  // #218 / ADR-103 Addendum 3: a move that CHANGES the page's EFFECTIVE private state — INTO a private folder
  // (implicit privatise) or OUT of one (implicit un-privatise) — is a manage-level act (setPagePrivate is
  // manage-gated), so require `manage`, not just `edit`. The page's OWN marker makes it private regardless of
  // parent; otherwise private is inherited from the (new/old) parent chain. Computed from server state only.
  const wasPrivate = await checkRelation(fga, MOVE_PRIVATE_PROBE, 'private', { type: 'page', id: args.pageId })
  const ownMarker = await readPagePrivate(fga, args.pageId)
  const willBePrivate = ownMarker || (newParent ? await checkRelation(fga, MOVE_PRIVATE_PROBE, 'private', { type: 'page', id: newParent }) : false)
  const effChanged = wasPrivate !== willBePrivate
  // Authorization: cross-space is a structural ownership move; an effective-private change is manage-level.
  if (crossSpace) {
    const [canManage, canEditDest] = await Promise.all([
      check(fga, `user:${args.userId}`, 'manage', { type: 'page', id: args.pageId }),
      check(fga, `user:${args.userId}`, 'edit', { type: 'space', id: targetSpace }),
    ])
    if (!canManage || !canEditDest) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  } else {
    const need = effChanged ? 'manage' : 'edit'
    const ok = await check(fga, `user:${args.userId}`, need, { type: 'page', id: args.pageId })
    if (!ok) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  }

  // ⚠️ #862 / ADR-108 §G: a move INTO a private ancestor revokes the subtree's share links, and the
  // events that say so carry a pageId the new private state hides — so the drain suppresses every one
  // of them. The answer has to be read before the parent tuple is re-pointed, and BELOW the refusals
  // above: it walks the subtree and asks the store once per page, and a caller who is about to get a
  // 403 should not pay for that (finding 3). Only on the transition into private, so an ordinary
  // move pays nothing at all.
  const movePrivatiseWasDeliverable = new Map<string, boolean>()
  if (effChanged && willBePrivate) {
    for (const id of [args.pageId, ...(await descendantIds(db.sql, args.pageId))]) {
      movePrivatiseWasDeliverable.set(id, (await pageEventDisposition(fga, { pageId: id })) === 'deliver')
    }
  }
  // `page.moved` belongs to the same class when the move is what made the page private: the consumer
  // knew this page and is about to stop hearing about it, and the answer to "may we say so" is gone by
  // the time the drain asks. On any other move the field is absent and the drain asks as it always has
  // — including a move OUT of private, where the later answer is the safer one.
  const movedSettled = effChanged && willBePrivate
    ? { pageWasDeliverable: movePrivatiseWasDeliverable.get(args.pageId) ?? false }
    : {}

  // No cycles: a page cannot be nested under itself or its own descendant.
  if (newParent === args.pageId) throw Object.assign(new Error('cannot nest under itself'), { statusCode: 400 })

  // #689: the descendant/depth checks below READ the tree and the UPDATE writes it — run apart, two
  // concurrent moves ("A under B" | "B under A") each pass the read before either write lands, and the
  // commit pair IS a parent cycle (the corruption the walk caps above then 500 on). So the checks, the
  // position computation and the write share ONE transaction under a per-space advisory xact lock (the
  // task-fold tool). Moves within one space serialize; moves in different spaces stay concurrent. A
  // cross-space move locks BOTH spaces in sorted order so two opposite cross-space moves cannot deadlock.
  const lockSpaces = crossSpace ? [page.space_id, targetSpace].sort() : [targetSpace]
  const structuralGuards = async (tx: Sql): Promise<void> => {
    for (const s of lockSpaces) await tx`SELECT pg_advisory_xact_lock(hashtext(${`page-move:${s}`})::bigint)`
    if (newParent) {
      if ((await descendantIds(tx, args.pageId)).includes(newParent)) {
        throw Object.assign(new Error('cannot nest under own descendant'), { statusCode: 400 })
      }
      // #218 / ADR-103 (comment 996 decision 3): the MOVED subtree's deepest node lands at
      // newParent depth + 1 + the subtree's own height — cap it under the resolution-depth limit.
      if ((await ancestorDepth(tx, newParent)) + 1 + (await subtreeHeight(tx, args.pageId)) > MAX_PAGE_DEPTH) {
        throw Object.assign(new Error(`max nesting depth (${MAX_PAGE_DEPTH}) exceeded`), { statusCode: 400 })
      }
    }
  }

  // Position between afterId and the next sibling in the DESTINATION sibling list. Collapsed gap
  // (#118): re-spread the destination sibling group first, then recompute the slot — same tx.
  const computePosition = async (tx: Sql): Promise<number> => {
    const sibs = await tx<{ id: string; position: number }[]>`
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
    if (gapCollapsed(before, after)) {
      const fresh = await rebalanceSiblings(tx, targetSpace, newParent, args.pageId)
      if (args.afterId == null) { before = null; after = fresh[0]?.position ?? null }
      else { const i = fresh.findIndex((s) => s.id === args.afterId); before = fresh[i]!.position; after = fresh[i + 1]?.position ?? null }
    }
    return positionBetween(before, after)
  }

  if (!crossSpace) {
    const r = await db.tx(async (tx) => {
      await structuralGuards(tx)
      const position = await computePosition(tx)
      const [row] = await tx<PageRow[]>`
        UPDATE pages SET parent_id = ${newParent}, position = ${position}, updated_at = now()
        WHERE id = ${args.pageId}
        RETURNING id, tenant_id, space_id, parent_id, title, position, created_at, updated_at
      `
      return row!
    })
    await syncPageParentTuple(fga, args.pageId, page.parent_id, newParent) // #218: re-point the parent tuple (private/grants cascade)
    // #218 / ADR-103: after the parent tuple is set, apply the private write-boundary if the effective private
    // state changed (strip/sweep only on the transition INTO private; reindex either way for the denorm).
    if (effChanged) await applyMovePrivacyBoundary(db, fga, driver, { rootId: args.pageId, tenantId: page.tenant_id, userId: args.userId, stripSweep: willBePrivate, reindex: true, wasDeliverable: movePrivatiseWasDeliverable })
    emit({ type: 'page.moved', tenantId: page.tenant_id, pageId: page.id, actorId: args.userId, ...movedSettled })
    return toPage(r)
  }

  // ── cross-space: subtree follows the page; re-index each; swap space grants ──
  const oldSpace = page.space_id
  const outboxIds: { id: string; pageId: string }[] = []
  const row = await db.tx(async (tx) => {
    await structuralGuards(tx)
    const position = await computePosition(tx)
    const subtree = [args.pageId, ...(await descendantIds(tx, args.pageId))]
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
  await syncPageParentTuple(fga, args.pageId, page.parent_id, newParent) // #218: re-point the parent tuple (private/grants cascade)
  // #218 / ADR-103: strip/sweep on the transition INTO private BEFORE the reindex runs (so is_public reflects
  // the stripped public grant). The subtree reindex is already enqueued above (space-denorm change), so reindex:false.
  if (willBePrivate && effChanged) await applyMovePrivacyBoundary(db, fga, driver, { rootId: args.pageId, tenantId: page.tenant_id, userId: args.userId, stripSweep: true, reindex: false, wasDeliverable: movePrivatiseWasDeliverable })
  for (const o of outboxIds) processOutboxAsync(driver, o.id, { tenantId: page.tenant_id, pageId: o.pageId, operation: 'upsert' })
  emit({ type: 'page.moved', tenantId: page.tenant_id, pageId: page.id, actorId: args.userId, ...movedSettled })
  return toPage(row as PageRow)
}

// Delete order: FGA first → outbox + DB in same tx.
// Outbox 'delete' entry ensures Meili doc is removed even if Meili is temporarily down.
// ── #411 / ADR-153: page trash (soft delete) ─────────────────────────────────
//
// Trash = write the FGA `trashed` marker PAIR on the whole subtree (view/edit/comment go dark through the
// existing per-item checks — uniform 404, byte-identical to absent) + stamp the rows
// (deleted_at/deleted_by/deleted_root_id) for the trash UI and the retention sweep. Every underlying
// grant tuple SURVIVES: restore = delete the pair + clear the stamps, and access comes back exactly as it
// was. manage is NOT subtracted by the marker — it is the trash-listing/restore/purge authority.
// Open collab sessions follow the freeze (#329) posture: the marker cuts `edit`, so writes/reconnects are
// refused at the collab layer's FGA checks; no forced disconnect broadcast in v1.

export const TRASH_RETENTION_DAYS = 30 // fixed in v1 (approval ruling); a tenant setting is a later seam

// #437 / ADR-167: delete_mode — which deletion PATHWAYS exist (a reversibility policy). It never
// changes WHO may delete: the delete-verb gates (#420 3b) hold unchanged in every mode, and the
// mode gate always runs AFTER the FGA gate so the policy 400 can never become an existence or
// permission oracle. Resolution: space override ?? tenant default ?? 'trash_only' (#411 as shipped).
export type DeleteMode = 'trash_only' | 'both' | 'direct_only'
export const DELETE_MODES: readonly DeleteMode[] = ['trash_only', 'both', 'direct_only']
export async function resolveDeleteMode(db: TenantDb, spaceId: string): Promise<DeleteMode> {
  const [row] = await db.sql<[{ mode: string | null; tenant_mode: string | null }?]>`
    SELECT s.delete_mode AS mode, (SELECT delete_mode FROM tenant_settings LIMIT 1) AS tenant_mode
    FROM spaces s WHERE s.id = ${spaceId}
  `
  const v = row?.mode ?? row?.tenant_mode ?? 'trash_only'
  return (DELETE_MODES as readonly string[]).includes(v) ? (v as DeleteMode) : 'trash_only'
}

const TRASHED_MARKERS = (pageId: string) => [
  // The #244 typed-wildcard PAIR: a marker must enumerate every principal type it stops.
  { user: 'user:*', relation: 'trashed', object: `page:${pageId}` },
  { user: 'share_link:*', relation: 'trashed', object: `page:${pageId}` },
]

// Move a page (and its whole subtree) to the trash. Marker-FIRST (revoke before anything else — ADR-003
// ordering), then stamp + search-doc removal (the synchronous-reindex class: trash IS a permission
// revocation). If the stamp tx fails the markers are COMPENSATED away (best effort) so no "invisible
// orphan" (view=false, not in the trash) survives a partial failure; the operation is idempotent and
// retryable either way (already-stamped rows are skipped; marker writes tolerate duplicates).
export async function trashPage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; userId: string },
): Promise<void> {
  await requireVerb(fga, args.userId, args.pageId, 'delete') // #420 3b / Rider 1: trash rides the delete verb
  const [meta] = await db.sql<[{ tenant_id: string; space_id: string; deleted_root_id: string | null }?]>`
    SELECT tenant_id, space_id, deleted_root_id FROM pages WHERE id = ${args.pageId}
  `
  if (!meta) throw Object.assign(new Error('not found'), { statusCode: 404 })
  if (meta.deleted_root_id) return // already in the trash (its own root or riding an ancestor's) — no-op
  // #437 / ADR-167: the mode gate runs strictly AFTER the FGA gate (above) — a static reason, no
  // resource detail, so the 400 is policy-only and never an existence/permission oracle.
  if ((await resolveDeleteMode(db, meta.space_id)) === 'direct_only') {
    throw Object.assign(new Error('the trash pathway is disabled by policy'), { statusCode: 400, reason: 'delete_mode' })
  }
  const subtree = [args.pageId, ...(await descendantIds(db.sql, args.pageId))]
  // Idempotent scope: only rows not already claimed by an existing trash entry get stamped/marked —
  // a nested OLDER trash root keeps its own deleted_root_id (restore/purge are keyed by it, ADR §2).
  const fresh = (await db.sql<{ id: string }[]>`
    SELECT id FROM pages WHERE id = ANY(${subtree}) AND deleted_root_id IS NULL
  `).map((r) => r.id)
  if (fresh.length === 0) return
  for (const id of fresh) {
    await writeTuples(fga, TRASHED_MARKERS(id)).catch((e) => {
      // ONLY a duplicate write (retry after a partial failure) is tolerated; anything else must abort —
      // the marker is the authorization change and MUST land before the page "disappears" anywhere else.
      // (Never key on the generic write_failed_due_to_invalid_input code — a model/relation mismatch
      // reports the same code, and swallowing that would trash the row with NO revocation = a leak.)
      // #578 leftover (#622 review): unreachable since the boundary replaced FGA's prose, so a retry after
      // a partial failure could no longer converge — the marker-up/stamp-missing invisible orphan this
      // catch exists to make retryable was stuck. The code carries the fact now.
      if (!isAlreadyConverged(e)) throw e
    })
  }
  try {
    const outboxIds: { id: string; pageId: string }[] = []
    await db.tx(async (tx) => {
      await tx`
        UPDATE pages SET deleted_at = now(), deleted_by = ${args.userId}, deleted_root_id = ${args.pageId}
        WHERE id = ANY(${fresh})
      `
      for (const id of fresh) {
        outboxIds.push({ id: await enqueueOutbox(tx, { tenantId: meta.tenant_id, pageId: id, operation: 'delete' }), pageId: id })
      }
    })
    for (const o of outboxIds) processOutboxAsync(driver, o.id, { tenantId: meta.tenant_id, pageId: o.pageId, operation: 'delete' })
  } catch (e) {
    // Compensate the markers so a stamp failure never leaves an invisible orphan (view=false but absent
    // from the trash). Compensation is best-effort — on failure the op stays retryable end-to-end.
    for (const id of fresh) await deleteTuples(fga, TRASHED_MARKERS(id)).catch(() => {})
    throw e
  }
  emit({ type: 'page.trashed', tenantId: meta.tenant_id, pageId: args.pageId, actorId: args.userId })
}

// Restore a trash ROOT (and the rows that rode into the trash with it — keyed by deleted_root_id, never
// "descendants of"). Marker deletion FIRST: a crash between marker-delete and stamp-clear leaves the row
// still listed in the trash (stamps intact) where a retry heals it; the reverse order could strand a page
// invisible everywhere. A non-existent id, a non-root, or a caller without manage is a uniform 404 (no
// trash-existence oracle).
export async function restorePage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; userId: string },
): Promise<{ reparented: boolean }> {
  const canDelete = await check(fga, `user:${args.userId}`, 'delete', { type: 'page', id: args.pageId })
  if (!canDelete) throw Object.assign(new Error('not found'), { statusCode: 404 }) // #420 3b / Rider 1: restore/purge = delete verb
  const [root] = await db.sql<[{ tenant_id: string; parent_id: string | null; deleted_root_id: string | null }?]>`
    SELECT tenant_id, parent_id, deleted_root_id FROM pages WHERE id = ${args.pageId}
  `
  if (!root || root.deleted_root_id !== args.pageId) throw Object.assign(new Error('not found'), { statusCode: 404 })
  const rows = (await db.sql<{ id: string; published_at: Date | null }[]>`
    SELECT id, published_at FROM pages WHERE deleted_root_id = ${args.pageId}
  `)
  for (const r of rows) {
    await deleteTuples(fga, TRASHED_MARKERS(r.id)).catch((e) => {
      // Idempotent: a retry finds the pair already gone ("did not exist"). Any OTHER failure aborts
      // BEFORE the stamps are cleared — clearing them with markers still up would drop the row from the
      // trash listing while it stays invisible everywhere (the invisible-orphan state trash must never
      // produce); aborting here leaves a retryable half-state (still listed, partially visible).
      // #578 leftover (#622 review): same — unreachable, so a restore retried after a partial failure
      // failed forever instead of converging.
      if (!isAlreadyConverged(e)) throw e
    })
  }
  // Re-parent when the original parent is itself trashed or purged (ADR §2): the restored root moves to
  // the space root; its own descendants keep their structure.
  let reparented = false
  if (root.parent_id) {
    const [p] = await db.sql<[{ deleted_at: Date | null }?]>`SELECT deleted_at FROM pages WHERE id = ${root.parent_id}`
    if (!p || p.deleted_at) reparented = true
  }
  const outboxIds: { id: string; pageId: string }[] = []
  await db.tx(async (tx) => {
    await tx`
      UPDATE pages SET deleted_at = NULL, deleted_by = NULL, deleted_root_id = NULL
      WHERE deleted_root_id = ${args.pageId}
    `
    if (reparented) await tx`UPDATE pages SET parent_id = NULL WHERE id = ${args.pageId}`
    // Published pages return to the search index (the anonymous/public and member candidate sets alike);
    // drafts stay unindexed as always.
    for (const r of rows) {
      if (!r.published_at) continue
      outboxIds.push({ id: await enqueueOutbox(tx, { tenantId: root.tenant_id, pageId: r.id, operation: 'upsert' }), pageId: r.id })
    }
  })
  for (const o of outboxIds) processOutboxAsync(driver, o.id, { tenantId: root.tenant_id, pageId: o.pageId, operation: 'upsert' })
  emit({ type: 'page.trash_restored', tenantId: root.tenant_id, pageId: args.pageId, actorId: args.userId })
  return { reparented }
}

// Permanently delete a trash ROOT — today's physical delete, reachable only THROUGH the trash (the
// DELETE /pages/:id route trashes; purge is explicit or the retention sweep). Uniform 404 for non-root /
// non-manage / absent (deletePage re-checks manage; the marker never cut it).
export async function purgePage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; userId: string },
): Promise<void> {
  const canDelete = await check(fga, `user:${args.userId}`, 'delete', { type: 'page', id: args.pageId })
  if (!canDelete) throw Object.assign(new Error('not found'), { statusCode: 404 }) // #420 3b / Rider 1: restore/purge = delete verb
  const [row] = await db.sql<[{ deleted_root_id: string | null }?]>`SELECT deleted_root_id FROM pages WHERE id = ${args.pageId}`
  if (!row || row.deleted_root_id !== args.pageId) throw Object.assign(new Error('not found'), { statusCode: 404 })
  await deletePage(db, fga, driver, { pageId: args.pageId, userId: args.userId })
}

// The per-space trash listing: ROOT entries only. The space gate is `view` (uniform 404 — a non-member
// cannot probe a space's trash; the route carries no guest config so a share_link token never reaches
// here), then every entry is FGA-`manage`-confirmed for the caller, omit-on-deny — a member who cannot
// manage a trashed page never learns its title or that it existed (no count leak; a private page's entry
// stays allowlist-only automatically since `private` cuts manage_from_space).
export interface TrashEntry { id: string; title: string; deletedAt: string; deletedBy: string | null; descendants: number }

export async function listSpaceTrash(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { spaceId: string; userId: string },
): Promise<TrashEntry[]> {
  const canView = await check(fga, `user:${args.userId}`, 'view', { type: 'space', id: args.spaceId })
  if (!canView) throw Object.assign(new Error('not found'), { statusCode: 404 })
  const rows = await db.sql<{ id: string; title: string; deleted_at: Date; deleted_by: string | null; descendants: number }[]>`
    SELECT p.id, p.title, p.deleted_at, p.deleted_by,
           (SELECT COUNT(*)::int - 1 FROM pages c WHERE c.deleted_root_id = p.id) AS descendants
    FROM pages p
    WHERE p.space_id = ${args.spaceId} AND p.deleted_root_id = p.id
    -- #623: the LIMIT was already here; the tiebreaker was not. Two pages deleted in the same instant
    -- (a subtree goes at once) have no defined order between them, so the boundary is arbitrary.
    ORDER BY p.deleted_at DESC, p.id DESC
    LIMIT 200
  `
  const out: TrashEntry[] = []
  for (const r of rows) {
    // #420 3b / Rider 1: the trash listing filters per-entry on the DELETE verb (the restore/purge
    // authority) — a delete-only role sees its trash; manage still qualifies via the superset.
    if (!(await check(fga, `user:${args.userId}`, 'delete', { type: 'page', id: r.id }))) continue
    out.push({ id: r.id, title: r.title, deletedAt: r.deleted_at.toISOString(), deletedBy: r.deleted_by, descendants: r.descendants })
  }
  return out
}

export async function deletePage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; userId: string },
): Promise<void> {
  const canDelete = await check(fga, `user:${args.userId}`, 'delete', { type: 'page', id: args.pageId })
  if (!canDelete) throw Object.assign(new Error('forbidden'), { statusCode: 403 }) // #420 3b / Rider 1
  await physicalDeletePage(db, fga, driver, { pageId: args.pageId, actorId: args.userId })
}

// #437 / ADR-167: the DIRECT permanent path — offered only under 'both' / 'direct_only'. Order:
// FGA first (unauthorized callers get the uniform verb 403 for absent/live/trashed alike), then
// the trashed/absent 404 (only a delete-capable caller — who already knows the page — reaches it;
// a trashed root's permanent path stays the purge route), then the policy 400 (static reason).
// One deletion implementation: this funnels into the same physicalDeletePage purge uses.
export async function directDeletePage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; userId: string },
): Promise<void> {
  await requireVerb(fga, args.userId, args.pageId, 'delete')
  const [row] = await db.sql<[{ space_id: string; deleted_root_id: string | null }?]>`
    SELECT space_id, deleted_root_id FROM pages WHERE id = ${args.pageId}
  `
  if (!row || row.deleted_root_id) throw Object.assign(new Error('not found'), { statusCode: 404 })
  if ((await resolveDeleteMode(db, row.space_id)) === 'trash_only') {
    throw Object.assign(new Error('direct permanent deletion is disabled by policy'), { statusCode: 400, reason: 'delete_mode' })
  }
  await physicalDeletePage(db, fga, driver, { pageId: args.pageId, actorId: args.userId })
}

// #511 / ADR-185: the selection cap — a body-size bound AND a work bound (the loop below runs a per-page
// authz check + a subtree cascade for every id).
export const BULK_DELETE_CAP = 500
export interface BulkDeleteResult { results: { id: string; ok: boolean; reason?: string }[]; deleted: number; skipped: number }

// #511 / ADR-185: delete a SELECTION of pages in one space. This is explicitly NOT a bulk bypass — every
// page re-runs the SAME per-page authz gate (requireVerb 'delete', inside trashPage / directDeletePage)
// and its own atomic subtree cascade + outbox reindex, exactly as the single-page routes do. A page the
// caller cannot delete is skipped, never touched. Partial success (not all-or-nothing): a per-item verdict
// is returned so the UI can report "N deleted, M skipped (no permission)". The space's delete-mode picks
// trash vs. permanent (the same choice the single-page UI makes). tenant/space binding is enforced by RLS
// on the SELECT below AND by each page's FGA gate — cross-tenant is structurally impossible.
export async function bulkDeletePages(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { spaceId: string; pageIds: string[]; userId: string },
): Promise<BulkDeleteResult> {
  // Existence-hiding: a caller who cannot even view the space gets a uniform 404 for the whole request —
  // never a per-item partial-success map they could read as an oracle. (The per-page FGA gate is still the
  // real authority; this is defense-in-depth + parity with the trash listing.)
  if (!(await check(fga, `user:${args.userId}`, 'view', { type: 'space', id: args.spaceId }))) {
    throw Object.assign(new Error('not found'), { statusCode: 404 })
  }
  const requested = [...new Set(args.pageIds)]
  if (requested.length > BULK_DELETE_CAP) {
    throw Object.assign(new Error(`selection exceeds the ${BULK_DELETE_CAP}-page cap`), { statusCode: 400, reason: 'too_many' })
  }
  // RLS-scoped: only rows the caller can SELECT, in THIS space, still live. Ids that fall out (wrong space,
  // cross-tenant, already trashed) report as skipped 'not_found' — a UNIFORM reason (no existence oracle;
  // the per-page FGA gate below is the authority regardless of what the SELECT returns).
  const live = requested.length
    ? (await db.sql<{ id: string }[]>`
        SELECT id FROM pages
        WHERE id = ANY(${requested}) AND space_id = ${args.spaceId} AND deleted_root_id IS NULL
      `).map((r) => r.id)
    : []
  const liveSet = new Set(live)
  const mode = live.length ? await resolveDeleteMode(db, args.spaceId) : 'both'
  const del = (pageId: string) =>
    mode === 'direct_only'
      ? directDeletePage(db, fga, driver, { pageId, userId: args.userId })
      : trashPage(db, fga, driver, { pageId, userId: args.userId })

  const results: { id: string; ok: boolean; reason?: string }[] = []
  for (const id of requested) {
    if (!liveSet.has(id)) { results.push({ id, ok: false, reason: 'not_found' }); continue }
    try {
      await del(id) // per-page authz re-check + atomic cascade + outbox reindex live INSIDE this call
      results.push({ id, ok: true })
    } catch (e) {
      // Classify without leaking. CRITICAL (no existence oracle): requireVerb throws 403 for a page the
      // caller cannot delete, and the pre-loop SELECT's RLS is tenant-scoped (NOT view-scoped), so a
      // same-space private page the caller cannot even see reaches this catch. Map 403 to the SAME
      // 'not_found' a genuinely absent id gets — else the reason ('error' vs 'not_found') would tell a
      // member holding a UUID whether that page exists-but-is-forbidden vs. does-not-exist. A 400 is the
      // delete-mode policy skip (static reason, no resource detail). Anything else is a real per-item
      // error, still skipped so one bad page never aborts the batch (partial success). A page cascaded
      // into the trash by an ancestor earlier in the SAME batch is a no-op on its own turn (trashPage
      // early-returns), reported ok — it IS deleted.
      const status = (e as { statusCode?: number })?.statusCode
      const reason = status === 404 || status === 403 ? 'not_found' : status === 400 ? ((e as { reason?: string }).reason ?? 'policy') : 'error'
      results.push({ id, ok: false, reason })
    }
  }
  const deleted = results.filter((r) => r.ok).length
  return { results, deleted, skipped: results.length - deleted }
}

export const BULK_PUBLISH_CAP = 500
export interface BulkPublishResult { results: { id: string; ok: boolean; reason?: string }[]; published: number; skipped: number }

// #511 / ADR-185 (slice 2): publish a SELECTION of pages in one space. Like bulk delete, this is NOT a bulk
// bypass — every page re-runs the SAME per-page `publish` FGA gate (inside publishPage) and its own atomic
// revision + outbox reindex + anonymous list snapshot, exactly as the single-page /publish route does. A page
// the caller cannot publish is skipped, never touched; a page whose content the effective abuse filter refuses
// is skipped with the static reason. Partial success (not all-or-nothing): a per-item verdict is returned so
// the UI can report "N published, M skipped". Member-only (the Pages tab; no guest config). tenant/space
// binding is enforced by RLS on the SELECT AND by each page's FGA gate — cross-tenant is structurally
// impossible. `flush` (the route wires flushDraft) drains each page's live collab draft first so a publish
// issued right after an edit includes it — best-effort, a no-op when collab isn't running (e.g. tests).
export async function bulkPublishPages(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  storage: StorageDriver,
  args: { spaceId: string; pageIds: string[]; userId: string; flush?: (pageId: string) => Promise<void> },
): Promise<BulkPublishResult> {
  // Existence-hiding: a caller who cannot even view the space gets a uniform 404 for the whole request —
  // never a per-item partial-success map they could read as an oracle (defense-in-depth + parity with delete).
  if (!(await check(fga, `user:${args.userId}`, 'view', { type: 'space', id: args.spaceId }))) {
    throw Object.assign(new Error('not found'), { statusCode: 404 })
  }
  const requested = [...new Set(args.pageIds)]
  if (requested.length > BULK_PUBLISH_CAP) {
    throw Object.assign(new Error(`selection exceeds the ${BULK_PUBLISH_CAP}-page cap`), { statusCode: 400, reason: 'too_many' })
  }
  // RLS-scoped: only rows the caller can SELECT, in THIS space, still live. Ids that fall out (wrong space,
  // cross-tenant, trashed) report as skipped 'not_found' — a UNIFORM reason (no existence oracle; the per-page
  // FGA gate inside publishPage is the authority regardless of what the SELECT returns).
  const live = requested.length
    ? (await db.sql<{ id: string }[]>`
        SELECT id FROM pages
        WHERE id = ANY(${requested}) AND space_id = ${args.spaceId} AND deleted_root_id IS NULL
      `).map((r) => r.id)
    : []
  const liveSet = new Set(live)

  const results: { id: string; ok: boolean; reason?: string }[] = []
  for (const id of requested) {
    if (!liveSet.has(id)) { results.push({ id, ok: false, reason: 'not_found' }); continue }
    try {
      await args.flush?.(id) // best-effort collab flush so publish includes the latest live edits
      // per-page authz re-check ('publish' gate) + abuse filter + revision + outbox reindex live INSIDE this call
      await publishPage(db, fga, driver, storage, { pageId: id, subject: `user:${args.userId}`, createdBy: `user:${args.userId}` })
      results.push({ id, ok: true })
    } catch (e) {
      // Classify without leaking. CRITICAL (no existence oracle): publishPage throws 403 for a page the caller
      // cannot publish, and the pre-loop SELECT's RLS is tenant-scoped (NOT view-scoped), so a same-space
      // private page the caller cannot even see reaches this catch. Map 403 to the SAME 'not_found' a genuinely
      // absent id gets — else the reason would tell a member holding a UUID whether that page exists-but-is-
      // forbidden vs. does-not-exist. 422 is the abuse-filter CONTENT verdict (static reason code, no content).
      // A 400 is a static policy skip. Anything else is a real per-item error, still skipped so one bad page
      // never aborts the batch (partial success).
      const status = (e as { statusCode?: number })?.statusCode
      const reason = status === 404 || status === 403 ? 'not_found'
        : status === 422 ? ((e as { reason?: string }).reason ?? 'abuse')
        : status === 400 ? ((e as { reason?: string }).reason ?? 'policy') : 'error'
      results.push({ id, ok: false, reason })
    }
  }
  const published = results.filter((r) => r.ok).length
  return { results, published, skipped: results.length - published }
}

// #511 / ADR-185 (slice 3): bulk VISIBILITY — make a selection private, or clear private. Third verb, same
// shape as delete and publish deliberately: every page goes through the SINGLE-page primitive, so the
// `share` gate, the private marker PAIR (user:* + share_link:* — a lone user:* leaves guests a way in,
// #244), the subtree cascade, the public-grant strip and the outbox reindex are the exact same code the
// per-page route runs. A bulk endpoint that reimplemented any of that would be a second authorizer.
//
// #511 (correction): that reindex is a TRUSTED path, not a synchronous one — the outbox row commits
// inside the page's transaction and is then fired inline, with the drain worker retrying what the inline
// call misses (search/outbox.ts). Search never depends on it for safety: a revoked page that is still in
// the index is cut at read time by the FGA re-check before results are shown.
export const BULK_VISIBILITY_CAP = 500
// `changed` counts pages this call actually MUTATED. A page already in the requested state is `ok` with
// `noop: true` and counted in `unchanged` — never in `skipped`, which means "the caller could not touch it".
export interface BulkVisibilityResult {
  results: { id: string; ok: boolean; noop?: boolean; reason?: string }[]
  changed: number
  unchanged: number
  skipped: number
}

export async function bulkSetPageVisibility(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { spaceId: string; pageIds: string[]; makePrivate: boolean; tenantId: string; userId: string; plan?: string },
): Promise<BulkVisibilityResult> {
  // Existence-hiding: a caller who cannot view the space gets a uniform 404 for the whole request, never a
  // per-item map they could read as an oracle (parity with delete/publish).
  if (!(await check(fga, `user:${args.userId}`, 'view', { type: 'space', id: args.spaceId }))) {
    throw Object.assign(new Error('not found'), { statusCode: 404 })
  }
  const requested = [...new Set(args.pageIds)]
  if (requested.length > BULK_VISIBILITY_CAP) {
    throw Object.assign(new Error(`selection exceeds the ${BULK_VISIBILITY_CAP}-page cap`), { statusCode: 400, reason: 'too_many' })
  }
  // RLS-scoped: rows the caller can SELECT, in THIS space, still live. Anything else reports the UNIFORM
  // 'not_found' — the per-page FGA gate inside the primitive stays the authority either way.
  const live = requested.length
    ? (await db.sql<{ id: string }[]>`
        SELECT id FROM pages
        WHERE id = ANY(${requested}) AND space_id = ${args.spaceId} AND deleted_root_id IS NULL
      `).map((r) => r.id)
    : []
  const liveSet = new Set(live)

  // #511 which of these pages ALREADY carry their own private marker. The predicate is the page's
  // OWN marker (what this verb writes), not effective privacy — a child of a private folder inherits
  // privacy, but writing its own marker still changes something (it survives the parent being cleared).
  //
  // Read PER SELECTED PAGE, never store-wide. The first cut of this asked FGA for every `private` marker
  // in the store and intersected the answer with the selection: correct, but its cost scaled with the
  // TENANT rather than with the request, so privatising one page in a large tenant paid for a full
  // paginated scan. That is the FGA cliff #499 and #500 were both about. `readPagePrivate` over the
  // RLS-scoped live rows is bounded by the selection (≤ the 500-page cap) and is the shape the page tree
  // already uses for its lock badges. A read fault falls back to "not already private", which only costs
  // a truthful `changed` label — the per-page `share` gate inside the primitive is untouched either way.
  const liveIds = [...liveSet]
  const privateFlags = await Promise.all(liveIds.map((id) => readPagePrivate(fga, id).catch(() => false)))
  const alreadyPrivate = new Set(liveIds.filter((_, i) => privateFlags[i]))

  const results: { id: string; ok: boolean; noop?: boolean; reason?: string }[] = []
  for (const id of requested) {
    if (!liveSet.has(id)) { results.push({ id, ok: false, reason: 'not_found' }); continue }
    // Already in the requested state: still run the primitive (it is idempotent, and its `share` gate must
    // decide — reporting ok without checking would leak "this page exists and is already private" to someone
    // who may not touch it), but report it as a no-op so the toast cannot blame permissions for it.
    const noop = alreadyPrivate.has(id) === args.makePrivate
    try {
      const call = args.makePrivate ? setPagePrivate : unsetPagePrivate
      // per-page `share` gate + trashed guard + marker pair + subtree reindex all live INSIDE this call
      await call(db, fga, driver, { pageId: id, tenantId: args.tenantId, userId: args.userId, plan: args.plan })
      results.push(noop ? { id, ok: true, noop: true } : { id, ok: true })
    } catch (e) {
      // Classify without leaking (the hole, kept closed): the pre-loop SELECT is RLS/tenant-scoped, NOT
      // view-scoped, so a same-space page the caller cannot see still reaches this catch and throws 403. Map it
      // to the SAME 'not_found' an absent id gets, or the reason would tell a member holding a UUID whether the
      // page exists-but-is-forbidden. One bad page never aborts the batch (partial success).
      const status = (e as { statusCode?: number })?.statusCode
      const reason = status === 404 || status === 403 ? 'not_found'
        : status === 400 ? ((e as { reason?: string }).reason ?? 'policy') : 'error'
      results.push({ id, ok: false, reason })
    }
  }
  const ok = results.filter((r) => r.ok)
  const unchanged = ok.filter((r) => r.noop).length
  return { results, changed: ok.length - unchanged, unchanged, skipped: results.length - ok.length }
}


// #511 / ADR-185 (slice 5): bulk MOVE — relocate a selection into another space. Same shape as the other
// verbs: every page goes through the SINGLE-page primitive (`movePage`), so the cycle guard, the depth cap,
// the space-home leaf rule, the subtree relocation and the outbox reindex are the exact code the per-page
// route runs, and a bulk call cannot become a bulk bypass.
//
// One thing is NOT delegated, on purpose. The approved decision is that a move requires `manage` on
// BOTH sides, but `movePage`'s cross-space gate asks for `manage` on the page and only `edit` on the
// destination space. Delegating alone would therefore ship a WEAKER destination gate than the one approved,
// so the destination's `manage` is checked here, once, before anything moves. Raising `movePage`'s own gate
// would change the single-page contract and is not this slice's call to make.
export const BULK_MOVE_CAP = 500
// `movedWithAncestor` marks a page that travelled inside its selected parent's subtree rather than being
// moved in its own right — it IS at the destination, so it is `ok`, but it was never a separate move.
export interface BulkMoveResult {
  results: { id: string; ok: boolean; reason?: string; movedWithAncestor?: boolean }[]
  moved: number
  skipped: number
}

export async function bulkMovePages(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { spaceId: string; targetSpaceId: string; pageIds: string[]; userId: string },
): Promise<BulkMoveResult> {
  // Existence-hiding on the SOURCE space, exactly as the other verbs (never a per-item map that could be
  // read as an oracle).
  if (!(await check(fga, `user:${args.userId}`, 'view', { type: 'space', id: args.spaceId }))) {
    throw Object.assign(new Error('not found'), { statusCode: 404 })
  }
  if (args.targetSpaceId === args.spaceId) {
    throw Object.assign(new Error('the destination is the current space'), { statusCode: 400, reason: 'same_space' })
  }
  // The destination must be in THIS tenant. The FGA store is shared across tenants, so a caller who manages
  // a space elsewhere passes the relation check — and the move then died on the composite foreign key deep
  // inside the loop, reporting `error` where every other unreachable destination reports the same uniform
  // 404 (#511). RLS is the tenant boundary, so ask the tenant-scoped handle first: another tenant's
  // space simply is not there.
  const [destRow] = await db.sql<{ id: string }[]>`SELECT id FROM spaces WHERE id = ${args.targetSpaceId}`
  // The destination gate. 404 rather than 403: a caller who cannot manage the target must not learn from the
  // status code whether that space exists — and the picker only ever offers spaces they manage, so a request
  // that lands here did not come from the UI.
  if (!destRow || !(await check(fga, `user:${args.userId}`, 'manage', { type: 'space', id: args.targetSpaceId }))) {
    throw Object.assign(new Error('not found'), { statusCode: 404 })
  }
  const requested = [...new Set(args.pageIds)]
  if (requested.length > BULK_MOVE_CAP) {
    throw Object.assign(new Error(`selection exceeds the ${BULK_MOVE_CAP}-page cap`), { statusCode: 400, reason: 'too_many' })
  }
  const live = requested.length
    ? (await db.sql<{ id: string }[]>`
        SELECT id FROM pages
        WHERE id = ANY(${requested}) AND space_id = ${args.spaceId} AND deleted_root_id IS NULL
      `).map((r) => r.id)
    : []
  const liveSet = new Set(live)

  // #511 the parent chain must be read for the WHOLE SPACE, not just the selection. Reading only the
  // selected rows made the walk stop at the first unselected parent, so P > M > C with only P and C picked
  // walked C -> M, found M unknown, and treated C as unrelated — it moved to the destination root and the
  // hierarchy flattened anyway. The Pages tab does not show nesting, so nobody could see that M sat in
  // between. Whole-space is bounded by the space and is the same read the tree already does.
  const spaceRows = await db.sql<{ id: string; parent_id: string | null }[]>`
    SELECT id, parent_id FROM pages WHERE space_id = ${args.spaceId} AND deleted_root_id IS NULL
  `
  const parentOf = new Map(spaceRows.map((r) => [r.id, r.parent_id]))

  // The NEAREST selected ancestor, or null. A page with one is carried by that ancestor's move rather than
  // moved in its own right — every move lands at the destination root, so moving both would place the
  // descendant beside its ancestor and silently flatten what the confirm promises to keep. Same rule slice 1
  // applies to delete, where a page already trashed by an ancestor is a no-op on its own turn.
  const nearestSelectedAncestor = (id: string): string | null => {
    const seen = new Set<string>()
    let cur = parentOf.get(id) ?? null
    while (cur && !seen.has(cur)) {
      if (liveSet.has(cur)) return cur
      seen.add(cur)
      cur = parentOf.get(cur) ?? null
    }
    return null
  }
  const depthOf = (id: string): number => {
    const seen = new Set<string>()
    let d = 0
    let cur = parentOf.get(id) ?? null
    while (cur && !seen.has(cur)) { d++; seen.add(cur); cur = parentOf.get(cur) ?? null }
    return d
  }

  // #511 the space HOME cannot leave its space. movePage only forbids NESTING the home (the leaf
  // rule), so a root-level move slipped past — and `spaces.home_page_id` keeps pointing at the page after it
  // lands elsewhere, so the source space has a home it no longer contains and cannot make a new one (the
  // create path 409s while that row is alive). The overview list, unlike the page tree, does not hide the
  // home, so select-all reaches it.
  const [srcHome] = await db.sql<{ home_page_id: string | null }[]>`SELECT home_page_id FROM spaces WHERE id = ${args.spaceId}`
  const homePageId = srcHome?.home_page_id ?? null

  // Ancestors first, so a descendant's outcome can depend on whether its ancestor ACTUALLY moved. Reported
  // in the caller's original order below.
  const byId = new Map<string, { id: string; ok: boolean; reason?: string; movedWithAncestor?: boolean }>()
  const arrived = new Set<string>()   // pages now at the destination, whether moved directly or carried
  const ordered = [...requested].sort((a, b) => depthOf(a) - depthOf(b))

  for (const id of ordered) {
    if (!liveSet.has(id)) { byId.set(id, { id, ok: false, reason: 'not_found' }); continue }
    if (id === homePageId) { byId.set(id, { id, ok: false, reason: 'space_home' }); continue }
    const anc = nearestSelectedAncestor(id)
    if (anc) {
      // #511 this used to assert `ok` on the ASSUMPTION the ancestor moved. When the ancestor was
      // skipped — a private page the caller cannot manage, say — the descendant never went anywhere and was
      // still reported as a success. Report what actually happened: it arrived only if its ancestor did.
      if (arrived.has(anc)) { arrived.add(id); byId.set(id, { id, ok: true, movedWithAncestor: true }) }
      else byId.set(id, { id, ok: false, reason: byId.get(anc)?.reason ?? 'not_found' })
      continue
    }
    try {
      // Land at the destination's ROOT: a bulk selection has no single sensible parent, and moving under one
      // would silently re-nest pages the caller never pointed at. The page's own subtree travels with it.
      await movePage(db, fga, driver, { pageId: id, userId: args.userId, parentId: null, afterId: null, spaceId: args.targetSpaceId })
      arrived.add(id)
      byId.set(id, { id, ok: true })
    } catch (e) {
      // Same anti-oracle fold as the other verbs: a page the caller cannot move (403) reports what an absent
      // id reports, so the reason can never distinguish forbidden-but-real from does-not-exist. A 400 is a
      // structural refusal (depth cap, the space-home leaf rule) and keeps its static reason.
      const status = (e as { statusCode?: number })?.statusCode
      const reason = status === 404 || status === 403 ? 'not_found'
        : status === 400 ? ((e as { reason?: string }).reason ?? 'policy') : 'error'
      byId.set(id, { id, ok: false, reason })
    }
  }
  const results = requested.map((id) => byId.get(id)!)

  // `moved` counts real moves. A page that rode along inside its selected parent is `ok` but was never a
  // move of its own, and counting it would report more relocations than happened.
  const ok = results.filter((r) => r.ok)
  const moved = ok.filter((r) => !r.movedWithAncestor).length
  return { results, moved, skipped: results.length - ok.length }
}

// #411 / ADR-153: the gate-free physical delete — callers authorize (deletePage/purgePage: caller manage;
// retention sweep: system context, the trash entry itself is the authority). Never routed directly.
async function physicalDeletePage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; actorId: string },
): Promise<void> {
  const [meta] = await db.sql<[{ tenant_id: string }]>`SELECT tenant_id FROM pages WHERE id = ${args.pageId}`
  const tenantId = meta?.tenant_id ?? ''

  // ON DELETE CASCADE removes the subtree in the DB, but FGA grants + search docs
  // for descendants must be cleaned too (else ghost auth / stale search). Sweep
  // the page AND all descendants. FGA-first (ADR-003): if a tuple sweep fails the
  // DB row is untouched and the op is retryable.
  const ids = [args.pageId, ...(await descendantIds(db.sql, args.pageId))]
  // ⚠️ #862 / ADR-108 §G: read whether this page could be spoken of BEFORE the sweep below removes the
  // tuples that answer it. The webhook drain asks the same question at delivery, finds nothing, and
  // has answered `not-ready` for every `page.deleted` ever enqueued — six retries over 930 s and then
  // dropped, per purge. `not-ready` here means a draft, and a purged draft can never become linked, so
  // it settles as "do not deliver" rather than as something to retry.
  const wasDeliverable = (await pageEventDisposition(fga, { pageId: args.pageId })) === 'deliver'
  for (const id of ids) await deleteObjectTuples(fga, `page:${id}`)

  // #437 / ADR-167 §3: permanent deletion is exactly where attribution matters most — EE tenants
  // get an in-tx ledger row for EVERY physical delete (explicit purge, the retention sweep, and the
  // direct path all funnel through here). Plan read from the global registry (no RLS on tenants).
  const [tenantRow] = await pool<[{ plan: string }?]>`SELECT plan FROM tenants WHERE id = ${tenantId}`
  const auditActor = args.actorId.includes(':') ? args.actorId : `user:${args.actorId}`

  const outboxIds: { id: string; pageId: string }[] = []
  await db.tx(async (tx) => {
    for (const id of ids) {
      outboxIds.push({ id: await enqueueOutbox(tx, { tenantId, pageId: id, operation: 'delete' }), pageId: id })
    }
    // #284 / ADR-119: best-effort pin cleanup (page + descendants). The pin display
    // gate drops orphans regardless — this is row hygiene, not correctness.
    await deletePinsForResources(tx, ids)
    await sweepWatchesForResources(tx, ids) // #320 / ADR-126: same row-hygiene sweep for watches (display gate is the backstop)
    // #536 review point 4: assignment rows (custom-role AND built-in grant rows) go with the pages. FGA is
    // the authz truth so orphans confer nothing — row hygiene, same as pins and watches above.
    await tx`DELETE FROM role_assignments WHERE resource_type = 'page' AND resource_id = ANY(${ids})`
    await auditIfEntitled(tx, { id: tenantId, plan: tenantRow?.plan ?? '' }, { actor: auditActor, action: 'page.purged', target: `page:${args.pageId}` })
    await tx`DELETE FROM pages WHERE id = ${args.pageId}` // cascade deletes descendants
  })
  for (const o of outboxIds) processOutboxAsync(driver, o.id, { tenantId, pageId: o.pageId, operation: 'delete' })
  emit({ type: 'page.deleted', tenantId, pageId: args.pageId, actorId: args.actorId, pageWasDeliverable: wasDeliverable })
}

// #411 / ADR-153: purge trash entries older than TRASH_RETENTION_DAYS, across all tenants. Same
// cross-tenant enumeration as sweepShareLinkRevokeFailures (tenants registry has no RLS); each tenant's
// rows are read/deleted under its own TenantDb. System context: the expired trash entry IS the deletion
// authority (the trashing member already held manage at trash time) — no user gate re-check.
//
// The sweep doubles as the trash's CRASH RECONCILIATION (ADR-153 §3): a crash between trashPage's marker
// write and its stamp tx (with the inline compensation ALSO lost) leaves an "invisible orphan" — view=false
// but in neither the tree nor the trash. Each pass re-stamps any page carrying a `trashed` marker with a
// NULL deleted_at (as its own root, starting its retention clock, search doc dropped), so the state
// self-heals with no manual repair path.
export async function sweepExpiredTrash(fga: OpenFgaClient, driver: SearchDriver): Promise<number> {
  // All trashed markers, read ONCE (the store spans tenants; RLS scopes the row work per tenant below).
  // #788: ask the store for the `trashed` markers rather than for every `user:*` tuple on every page.
  // The set is the same — this is the filter that used to run here, moved to where the rows are —
  // and the cost stops scaling with how much the workspace has PUBLISHED. Measured before: 41,257
  // tuples read in 43 seconds to find the one marker that mattered, on every sweep.
  const marked = (await readUserTuplesByType(fga, 'user:*', 'page:', 'trashed'))
    .map((t) => t.object.slice('page:'.length))
  // ADR-252 §6a ruling 1 (#810): the shared enumeration chokepoint — see db/registry.ts.
  const tenants = await listActiveTenantIds(pool)
  let purged = 0
  for (const { id: tenantId } of tenants) {
    const tenant = await registry.findById(tenantId)
    if (!tenant) continue
    let db: TenantDb | null = null
    try {
      db = await acquireTenantDb(tenant)
      // Reconciliation: marker present, stamp missing → re-stamp into the trash (own root).
      if (marked.length > 0) {
        const orphans = (await db.sql<{ id: string }[]>`
          SELECT id FROM pages WHERE id = ANY(${marked}) AND deleted_at IS NULL
        `).map((r) => r.id)
        for (const id of orphans) {
          const outboxIds: string[] = []
          await db.tx(async (tx) => {
            await tx`
              UPDATE pages SET deleted_at = now(), deleted_by = 'system:trash-reconcile', deleted_root_id = ${id}
              WHERE id = ${id} AND deleted_at IS NULL
            `
            outboxIds.push(await enqueueOutbox(tx, { tenantId, pageId: id, operation: 'delete' }))
          })
          for (const o of outboxIds) processOutboxAsync(driver, o, { tenantId, pageId: id, operation: 'delete' })
        }
      }
      // ROOTS only — physicalDeletePage cascades their subtrees; a nested older root that already
      // expired is picked up by its own row (deleted_root_id = itself) on this or a later pass.
      const roots = await db.sql<{ id: string }[]>`
        SELECT id FROM pages
        WHERE deleted_root_id = id AND deleted_at < now() - make_interval(days => ${TRASH_RETENTION_DAYS})
      `
      for (const r of roots) {
        await physicalDeletePage(db, fga, driver, { pageId: r.id, actorId: 'system:trash-retention' })
        purged++
      }
    } catch {
      // Leave this tenant's expired rows for the next sweep (transient DB/FGA failure).
    } finally {
      await db?.release().catch(() => {})
    }
  }
  return purged
}

// Start the daily retention sweep (server entry only, NOT buildApp — tests drive sweepExpiredTrash
// directly). Idempotent across instances: the row-existence check inside physicalDeletePage and the
// `deleted_at <` predicate make a concurrent double-purge a no-op race, not a fault.
export function startTrashRetentionWorker(fga: OpenFgaClient, driver: SearchDriver, intervalMs = 60 * 60 * 1000): () => void {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      // #637 / ADR-216 §2: not on behalf of a request, and it SAYS so. An explicit unrestricted scope,
      // rather than arriving with none — which in a process that declared the requirement is a crash, and
      // in one that has not is indistinguishable from a request path where somebody forgot.
      await runInAuthzScope(SYSTEM_SCOPE, () => sweepExpiredTrash(fga, driver))
    } catch {
      /* next tick retries */
    } finally {
      running = false
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

// Resolve the request principal (member OR guest) for a page action. Returns the FGA subject,
// the attribution id, and (guests) the time context for the share_link condition.
//
// Guest tokens carry NO resource pre-binding here (#397; #218/): the token proves WHO
// (share_link:<id>, tenant-checked + capability-checked in the auth hook), and each route's FGA check
// decides WHAT — a page token reaches its own page + published descendants (the #218 folder cascade),
// a space token (#104) the space's published pages; anything else resolves to the normal deny (read
// paths hide existence with a uniform 404, edit actions 403). Expiry rides on the returned context.
export function principalForPage(req: FastifyRequest, pageId: string): { subject: string; createdBy: string; context?: { current_time: string } } {
  if (req.user) {
    return { subject: `user:${req.user.sub}`, createdBy: `user:${req.user.sub}` }
  }
  if (req.guest) {
    // #397 (#218/): NO resource-id pre-binding — OpenFGA is the sole authority, exactly like the
    // attachment routes and batchPrincipal. The old exact-match bind (`r.id === pageId` for a page token)
    // pre-dated folder links and 403'd a FOLDER link's guest on every DESCENDANT page even though the model
    // cascades the grant (`*_direct from parent`) — the ruling says a folder link covers its subtree.
    // Delegating means: the token proves WHO (share_link:<id>, tenant-checked in the auth hook); the route's
    // FGA check (with current_time for expiry) decides WHAT — an unrelated page resolves to a uniform 404 at
    // the view gate (existence-hiding), a revoked link loses everything (tuple gone). No new authority: the
    // link's tuples only ever grant its own resource + descendants.
    return {
      subject: `share_link:${req.guest.shareLinkId}`,
      // #331 / ADR-138 (C-6): attribute the revision/feed to the pseudonymous per-session id (unforgeable — it
      // comes from the verified token, not client awareness). Falls back to the share-link id for an older token
      // minted before anonId existed. authz `subject` is unchanged (the anonId is never an authority).
      createdBy: req.guest.anonId ?? `guest:${req.guest.shareLinkId}`,
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
// and an explicit markdown link to `/p/<id>`. (The #224 title-match auto-links are display-only —
// never in the source — so they are out of scope here and follow #224's finalisation.)
// Security: the SQL LIKE only prefilters candidates that mention the id string; each candidate is then
// (a) confirmed to hold a REAL reference (precise regex, not a coincidental substring) and (b) gated
// by an FGA `view` check for the viewer — so a backlink from a page the viewer can't see is never
// leaked ("confirm via OpenFGA before display", like listSpaces / the search stage-2 guard).
// #370 `depth` (0-based) nests a `:::children` result under its nearest VISIBLE ancestor in the
// descendant tree; absent (backlinks / tagged / pre-tree snapshots) reads as 0 = flat.
export interface Backlink { id: string; title: string; depth?: number }

// #353 / ADR-027 (authorized-hit gap, Hole C): the reverse-lookup lists (backlinks / tag / children) must not
// DROP viewable results at the raw-fetch boundary. The naive shape — `LIMIT N` raw → per-item view-filter —
// silently loses authorized rows when the first N by rank include non-viewable ones (safe = no leak, but the
// list is short of N genuine hits). Fix: OVER-FETCH by rank well past the display cap, view-filter in rank
// order, and stop at the display cap — so the list is the "top DISPLAY_N VIEWABLE by rank", not "the viewable
// subset of the top-N raw". The per-item FGA loop early-exits at DISPLAY_N (rank-ordered → the rest are lower
// rank and would not display anyway), so the cost stays ~DISPLAY_N checks, not the whole over-fetch.
const QUERY_DISPLAY_N = 200 // the visible cap (unchanged from the prior raw LIMIT — the displayed count)
const QUERY_OVER_FETCH = 600 // rank-ordered candidates fetched so view-filtering still yields up to DISPLAY_N

export async function getBacklinks(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; subject: string; context?: { current_time: string } },
): Promise<Backlink[]> {
  // #307 / view-gate the TARGET page itself. This endpoint is now callable with an ARBITRARY target
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
      AND deleted_at IS NULL
      AND published_md IS NOT NULL
      AND published_md LIKE ${'%' + args.pageId + '%'}
    ORDER BY updated_at DESC, id DESC
    LIMIT ${QUERY_OVER_FETCH}
  `
  // #623: the confirm is ONE batched question, not one per candidate. The rank-ordered loop it replaces
  // asked FGA serially and early-exited at the display cap, so a page with many backlinks spent up to 200
  // SEQUENTIAL round-trips before the panel appeared — the same shape #534 measured as the editor's
  // fourteen seconds. Batched it is at most twelve requests for the whole over-fetch, four in flight.
  // The semantics are unchanged: still "the top DISPLAY_N VIEWABLE by rank" (Hole C), because the rank
  // order is preserved through the filter rather than being recovered from the answer set.
  const candidates = rows.filter((r) => refRe.test(r.published_md))
  const viewable = await filterAuthorized(
    fga, args.subject, 'view', candidates.map((r) => r.id), args.context, 'page', 4,
  )
  return candidates.filter((r) => viewable.has(r.id)).slice(0, QUERY_DISPLAY_N)
    .map((r) => ({ id: r.id, title: r.title }))
}

// #322 / ADR-133 §6: the internal-link EDGE INDEX (page_links). A DERIVED index of the outbound page
// references a page's PUBLISHED content makes — the persistent backing for the future 2-hop "Related"
// query + graph view (cheaper than getBacklinks' on-the-fly LIKE/regex scan). INERT for now: nothing
// reads page_links yet, so this slice adds NO read/authz surface (the view-filtered 2-hop query is the
// next slice; there both endpoints are view-filtered → a dead/non-viewable target yields no node).
export type PageLinkType = 'link' | 'embed'
export interface PageLinkEdge { toId: string; type: PageLinkType }

// A page's own id is a v4-style UUID. Word-boundary the tail so `/p/<uuid>#frag` still captures the id and
// a longer token isn't half-matched.
const PAGE_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const LINK_REF_RE = new RegExp(`/p/(${PAGE_UUID})(?![0-9a-f-])`, 'gi')
// A `:::embed-page` block whose body line IS the target id (mirrors getBacklinks' embed reference shape).
const EMBED_REF_RE = new RegExp(`:::embed-page[^\\n]*\\n\\s*(${PAGE_UUID})\\s*(?:\\n|$)`, 'gi')

// Extract the DISTINCT internal references `md` makes: `/p/<id>` links (type 'link') and `:::embed-page`
// bodies (type 'embed'). Self-references are dropped. The #224 title-match auto-links are display-only
// (never in the source), so they are out of scope (a future 'autolink' derived edge — ADR-133 §6).
export function extractPageLinks(md: string, selfId: string): PageLinkEdge[] {
  const edges = new Map<string, PageLinkEdge>()
  const add = (toId: string, type: PageLinkType) => {
    const id = toId.toLowerCase()
    if (id && id !== selfId.toLowerCase()) edges.set(`${id}\x00${type}`, { toId: id, type })
  }
  for (const m of md.matchAll(LINK_REF_RE)) add(m[1], 'link')
  for (const m of md.matchAll(EMBED_REF_RE)) add(m[1], 'embed')
  return [...edges.values()]
}

// Replace a page's outbound edges with the set derived from its just-published markdown. DERIVED +
// idempotent (delete-then-insert), called INSIDE the publish tx so the index moves with the published
// content atomically. `md === null` (unpublish) clears the page's edges. A page DELETE cascades its rows
// away via the from_page_id FK, so no explicit cleanup is needed there.
export async function syncPageLinks(tx: Sql, tenantId: string, fromPageId: string, md: string | null): Promise<void> {
  await tx`DELETE FROM page_links WHERE from_page_id = ${fromPageId}`
  const edges = md ? extractPageLinks(md, fromPageId) : []
  for (const e of edges) {
    await tx`
      INSERT INTO page_links (tenant_id, from_page_id, to_page_id, type)
      VALUES (${tenantId}, ${fromPageId}, ${e.toId}, ${e.type})
      ON CONFLICT DO NOTHING
    `
  }
}

// ── #370 / ADR-145: frontmatter tags ─────────────────────────────────────────

// A page's tags live in its leading YAML frontmatter block (`---\ntags: [a, b]\n---`) — plain text inside
// the single Y.Text (Open formats; every SSG reads it). This extracts them with a deliberately MINIMAL
// YAML subset (no YAML dependency): the `tags:` field as an inline array, a dash list, or a single scalar.
// Tag identity is case-insensitive (user ruling): `tag` is the lowercased key, `display` the first-seen
// original casing. Anything unparseable yields no tags — authoring free-text never errors.
export interface PageTag { tag: string; display: string }

const TAG_MAX_LEN = 100
const TAGS_MAX_COUNT = 50

// The leading frontmatter block of `md`: full fence bounds + inner lines, or null when the document does
// not START with a `---` fence line (frontmatter is position-0-only, like every SSG).
export function parseFrontmatterBlock(md: string): { from: number; to: number; inner: string } | null {
  if (!/^---[ \t]*(\r?\n|$)/.test(md)) return null
  const lines = md.split('\n')
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)[ \t]*\r?$/.test(lines[i]!)) {
      const from = 0
      const to = lines.slice(0, i + 1).join('\n').length
      const inner = lines.slice(1, i).join('\n')
      return { from, to, inner }
    }
  }
  return null // unterminated fence → not frontmatter
}

function cleanTag(raw: string): string {
  let s = raw.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim()
  return s.slice(0, TAG_MAX_LEN)
}

export function extractFrontmatterTags(md: string): PageTag[] {
  const fm = parseFrontmatterBlock(md)
  if (!fm) return []
  const lines = fm.inner.split('\n')
  const raw: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^tags[ \t]*:[ \t]*(.*)$/.exec(lines[i]!)
    if (!m) continue
    const rest = m[1]!.trim()
    if (rest.startsWith('[')) {
      // inline array — tolerate a missing `]` (take the rest of the line)
      const inner = rest.endsWith(']') ? rest.slice(1, -1) : rest.slice(1)
      raw.push(...inner.split(','))
    } else if (rest === '') {
      // dash list on the following lines
      for (let j = i + 1; j < lines.length; j++) {
        const dm = /^[ \t]*-[ \t]+(.*)$/.exec(lines[j]!)
        if (!dm) break
        raw.push(dm[1]!)
      }
    } else {
      raw.push(rest) // single scalar
    }
    break // first `tags:` wins
  }
  const out: PageTag[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    const display = cleanTag(r)
    if (!display) continue
    const tag = display.toLowerCase()
    if (seen.has(tag)) continue
    seen.add(tag)
    out.push({ tag, display })
    if (out.length >= TAGS_MAX_COUNT) break
  }
  return out
}

// Replace a page's tag rows with the set derived from its just-published markdown. DERIVED + idempotent
// (delete-then-insert), called INSIDE the publish tx next to syncPageLinks so the projection moves with
// published_md atomically. The projection is a stage-1 candidate set ONLY — every read view-confirms each
// page at display time (ADR-145 §4).
export async function syncPageTags(tx: Sql, tenantId: string, pageId: string, md: string | null): Promise<void> {
  await tx`DELETE FROM page_tags WHERE page_id = ${pageId}`
  const tags = md ? extractFrontmatterTags(md) : []
  for (const t of tags) {
    await tx`
      INSERT INTO page_tags (tenant_id, page_id, tag, display)
      VALUES (${tenantId}, ${pageId}, ${t.tag}, ${t.display})
      ON CONFLICT DO NOTHING
    `
  }
}

// #322 / ADR-133 §2/§3: 2-hop RELATED pages. Intermediates = the pages the target P links to; related pages
// = OTHER pages that ALSO link to the same intermediate, grouped by that shared link (Scrapbox-style). Both
// endpoints (the intermediate AND the related page) are view-filtered for the caller in a SINGLE pass, so a
// group whose shared link the caller cannot see — or a related page they cannot see — simply does not appear
// (existence-hiding, exactly like getBacklinks / search stage-2). Count / group / rank run ONLY over the
// view-filtered set (review §3 — computing "N pages link to X" before filtering would leak a count).
// MEMBER-only (the route carries no guest config); the public reader gets Related in a later increment (§3).
export interface RelatedGroup { intermediate: { id: string; title: string }; pages: { id: string; title: string }[] }
export interface RelatedResult { groups: RelatedGroup[]; truncated: boolean }

const RELATED_OVER_FETCH = 600    // rank-ordered candidate edges fetched so view-filtering still yields groups
const RELATED_DISPLAY_GROUPS = 20 // max intermediate groups shown
const RELATED_PER_GROUP = 12      // max related pages per group

export async function getRelatedPages(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; subject: string; context?: { current_time: string } },
): Promise<RelatedResult> {
  // View-gate the TARGET itself first: a non-viewable OR non-existent target is a uniform 404 so its
  // existence / neighbourhood can't be probed (same guard as getBacklinks, #307/).
  if (!(await check(fga, args.subject, 'view', { type: 'page', id: args.pageId }, args.context))) {
    throw Object.assign(new Error('not found'), { statusCode: 404 })
  }
  // Candidate edges: OTHER pages (from ≠ P) linking to an intermediate P also links to. Over-fetched by
  // related-page recency so the post-filter still yields up to the display caps (ADR-027 boundary-drop fix).
  const rows = await db.sql<{ mid: string; mid_title: string; related: string; related_title: string }[]>`
    WITH mids AS (SELECT DISTINCT to_page_id AS mid FROM page_links WHERE from_page_id = ${args.pageId})
    SELECT pl.to_page_id AS mid, mp.title AS mid_title, pl.from_page_id AS related, rp.title AS related_title
    FROM page_links pl
    JOIN mids ON mids.mid = pl.to_page_id
    JOIN pages mp ON mp.id = pl.to_page_id AND mp.deleted_at IS NULL
    JOIN pages rp ON rp.id = pl.from_page_id AND rp.deleted_at IS NULL
    WHERE pl.from_page_id <> ${args.pageId}
    ORDER BY rp.updated_at DESC, pl.from_page_id DESC, pl.to_page_id DESC
    LIMIT ${RELATED_OVER_FETCH}
  `
  if (rows.length === 0) return { groups: [], truncated: false }
  // SINGLE-PASS view-filter over BOTH endpoints, THEN count/group/rank (never before — §3).
  const nodeIds = [...new Set(rows.flatMap((r) => [r.mid, r.related]))]
  const viewable = await filterAuthorized(fga, args.subject, 'view', nodeIds, args.context)
  const edges = rows.filter((r) => viewable.has(r.mid) && viewable.has(r.related))
  if (edges.length === 0) return { groups: [], truncated: false }
  // A related page's rank key = how many of P's (viewable) intermediates it shares (shared-intermediate count).
  const sharedCount = new Map<string, number>()
  for (const e of edges) sharedCount.set(e.related, (sharedCount.get(e.related) ?? 0) + 1)
  // Group by intermediate (the shared link word); edges arrive in related-recency order (preserved by Map).
  const byMid = new Map<string, { title: string; pages: Map<string, string> }>()
  for (const e of edges) {
    let g = byMid.get(e.mid)
    if (!g) { g = { title: e.mid_title, pages: new Map() }; byMid.set(e.mid, g) }
    if (!g.pages.has(e.related)) g.pages.set(e.related, e.related_title)
  }
  const groupsAll = [...byMid.entries()].map(([mid, g]) => ({
    intermediate: { id: mid, title: g.title },
    pages: [...g.pages.entries()]
      .map(([id, title]) => ({ id, title }))
      // shared-intermediate count desc; ties keep the DB recency order (stable sort).
      .sort((a, b) => sharedCount.get(b.id)! - sharedCount.get(a.id)!)
      .slice(0, RELATED_PER_GROUP),
  }))
  // Rank groups by their related-page count (desc), then cap the number of groups shown.
  groupsAll.sort((a, b) => b.pages.length - a.pages.length)
  const groups = groupsAll.slice(0, RELATED_DISPLAY_GROUPS)
  return { groups, truncated: groupsAll.length > groups.length }
}

// #394 / ADR-147 (ADR-133 §6 increment ③a): the LOCAL GRAPH around one page — the viewer-scoped edge list
// the §6 index schema reserved. depth=1 is the mini graph (edges touching the page); depth=2 is the modal
// (edges touching the page or one of its 1-hop neighbours, including edges AMONG neighbours). The §3/§6
// authz invariant, verbatim: an edge is returned ONLY when the caller can `view` BOTH endpoints, and a page
// the caller cannot see is absent as a NODE entirely — no dangling edge, no title leak. A node reachable
// only THROUGH an unviewable page therefore vanishes with it (it has no surviving edge). The node cap runs
// AFTER the view-filter (a hidden page never occupies cap room and hiddenCount counts only viewable drops);
// over-cap is REPORTED via hiddenCount, never silently truncated. MEMBER-only (the route carries no guest
// config); a public graph over public pages is a later increment (§6).
// #440 / ADR-166: nodes carry spaceId (already joined from pages; getPage exposes it for every
// viewable page, so this is no new exposure) — NEVER a space name: names leave the server only
// through the view-filtered GET /spaces (the existence-hiding boundary for spaces).
export interface LocalGraphNode { id: string; title: string; spaceId: string }
export interface LocalGraphEdge { from: string; to: string; type: PageLinkType }
export interface LocalGraphResult { center: string; nodes: LocalGraphNode[]; edges: LocalGraphEdge[]; hiddenCount: number }

// #440 / ADR-166: depth is selectable 1/2/3 (server-clamped; 4+ is the space-wide graph's surface,
// ADR-147 §③b). Depth 3 doubles the over-fetch so the view-filter can still FILL the larger cap.
// Honest caveat (ADR-027 at scale): hiddenCount counts post-cap node drops only — candidates cut by
// the over-fetch LIMIT are invisible to it, so a dense wiki at depth 3 shows a recency-biased sample.
const GRAPH_OVER_FETCH = { 1: 800, 2: 800, 3: 1600 } as const
const GRAPH_NODE_CAP = { 1: 30, 2: 120, 3: 250 } as const
export type GraphDepth = 1 | 2 | 3

export async function getLocalGraph(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; depth: GraphDepth; subject: string; context?: { current_time: string } },
): Promise<LocalGraphResult> {
  // View-gate the CENTER first: a non-viewable OR non-existent page is a uniform 404 so its existence /
  // neighbourhood can't be probed (same guard as getBacklinks / getRelatedPages).
  if (!(await check(fga, args.subject, 'view', { type: 'page', id: args.pageId }, args.context))) {
    throw Object.assign(new Error('not found'), { statusCode: 404 })
  }
  // Candidate edges (stage 1 — page_links is only ever a candidate source, §6). JOINing pages on BOTH ends
  // drops dangling targets and is tenant-bounded by RLS twice over (page_links AND pages).
  // #440 / ADR-166: one query per depth, each a BOUNDED per-hop frontier (n1, n2 — depth iterations of
  // the same pattern, deliberately NOT an unbounded recursive CTE). The single both-ends view-filter
  // below runs over the final edge set whatever the depth — the authz structure is depth-independent.
  type Row = { from_id: string; to_id: string; type: PageLinkType; from_title: string; to_title: string; from_space: string; to_space: string }
  const overFetch = GRAPH_OVER_FETCH[args.depth]
  const rows = args.depth === 1
    ? await db.sql<Row[]>`
        SELECT pl.from_page_id AS from_id, pl.to_page_id AS to_id, pl.type,
               fp.title AS from_title, tp.title AS to_title, fp.space_id AS from_space, tp.space_id AS to_space
        FROM page_links pl
        JOIN pages fp ON fp.id = pl.from_page_id AND fp.deleted_at IS NULL
        JOIN pages tp ON tp.id = pl.to_page_id AND tp.deleted_at IS NULL
        WHERE pl.from_page_id = ${args.pageId} OR pl.to_page_id = ${args.pageId}
        ORDER BY GREATEST(fp.updated_at, tp.updated_at) DESC
        LIMIT ${overFetch}
      `
    : args.depth === 2
    ? await db.sql<Row[]>`
        WITH n1 AS (
          SELECT DISTINCT CASE WHEN pl.from_page_id = ${args.pageId} THEN pl.to_page_id ELSE pl.from_page_id END AS id
          FROM page_links pl
          WHERE pl.from_page_id = ${args.pageId} OR pl.to_page_id = ${args.pageId}
        )
        SELECT pl.from_page_id AS from_id, pl.to_page_id AS to_id, pl.type,
               fp.title AS from_title, tp.title AS to_title, fp.space_id AS from_space, tp.space_id AS to_space
        FROM page_links pl
        JOIN pages fp ON fp.id = pl.from_page_id AND fp.deleted_at IS NULL
        JOIN pages tp ON tp.id = pl.to_page_id AND tp.deleted_at IS NULL
        WHERE pl.from_page_id = ${args.pageId} OR pl.to_page_id = ${args.pageId}
           OR pl.from_page_id IN (SELECT id FROM n1) OR pl.to_page_id IN (SELECT id FROM n1)
        ORDER BY GREATEST(fp.updated_at, tp.updated_at) DESC
        LIMIT ${overFetch}
      `
    : await db.sql<Row[]>`
        WITH n1 AS (
          SELECT DISTINCT CASE WHEN pl.from_page_id = ${args.pageId} THEN pl.to_page_id ELSE pl.from_page_id END AS id
          FROM page_links pl
          WHERE pl.from_page_id = ${args.pageId} OR pl.to_page_id = ${args.pageId}
        ), n2 AS (
          SELECT DISTINCT CASE WHEN pl.from_page_id IN (SELECT id FROM n1) THEN pl.to_page_id ELSE pl.from_page_id END AS id
          FROM page_links pl
          WHERE pl.from_page_id IN (SELECT id FROM n1) OR pl.to_page_id IN (SELECT id FROM n1)
        )
        SELECT pl.from_page_id AS from_id, pl.to_page_id AS to_id, pl.type,
               fp.title AS from_title, tp.title AS to_title, fp.space_id AS from_space, tp.space_id AS to_space
        FROM page_links pl
        JOIN pages fp ON fp.id = pl.from_page_id AND fp.deleted_at IS NULL
        JOIN pages tp ON tp.id = pl.to_page_id AND tp.deleted_at IS NULL
        WHERE pl.from_page_id = ${args.pageId} OR pl.to_page_id = ${args.pageId}
           OR pl.from_page_id IN (SELECT id FROM n1) OR pl.to_page_id IN (SELECT id FROM n1)
           OR pl.from_page_id IN (SELECT id FROM n2) OR pl.to_page_id IN (SELECT id FROM n2)
        ORDER BY GREATEST(fp.updated_at, tp.updated_at) DESC
        LIMIT ${overFetch}
      `
  // SINGLE-PASS view-filter over every candidate node (stage 2 — the authority), THEN everything else.
  const nodeIds = [...new Set([args.pageId, ...rows.flatMap((r) => [r.from_id, r.to_id])])]
  const viewable = await filterAuthorized(fga, args.subject, 'view', nodeIds, args.context)
  const edges: LocalGraphEdge[] = []
  const titles = new Map<string, string>()
  const spaces = new Map<string, string>() // #440: spaceId per node (name-free — the client resolves names via GET /spaces)
  const seen = new Set<string>()
  for (const r of rows) {
    if (!viewable.has(r.from_id) || !viewable.has(r.to_id)) continue
    const key = `${r.from_id} ${r.to_id} ${r.type}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ from: r.from_id, to: r.to_id, type: r.type })
    titles.set(r.from_id, r.from_title)
    titles.set(r.to_id, r.to_title)
    spaces.set(r.from_id, r.from_space)
    spaces.set(r.to_id, r.to_space)
  }
  // The center is always a node, even when isolated (its title then isn't in any surviving row).
  if (!titles.has(args.pageId)) {
    const [row] = await db.sql<{ title: string; space_id: string }[]>`SELECT title, space_id FROM pages WHERE id = ${args.pageId}`
    titles.set(args.pageId, row?.title ?? '')
    spaces.set(args.pageId, row?.space_id ?? '')
  }
  // Node cap — post-filter (only viewable nodes compete), center always kept, rest ranked by degree so the
  // densest neighbours survive. Edges touching a dropped node are dropped with it; the drop is REPORTED.
  const cap = GRAPH_NODE_CAP[args.depth]
  const degree = new Map<string, number>()
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1)
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
  }
  const others = [...titles.keys()].filter((id) => id !== args.pageId)
  others.sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0))
  const kept = new Set([args.pageId, ...others.slice(0, cap - 1)])
  const nodes: LocalGraphNode[] = [...kept].map((id) => ({ id, title: titles.get(id) ?? '', spaceId: spaces.get(id) ?? '' }))
  return {
    center: args.pageId,
    nodes,
    edges: edges.filter((e) => kept.has(e.from) && kept.has(e.to)),
    hiddenCount: titles.size - kept.size,
  }
}

// #370 / ADR-145: the two read-only DYNAMIC LIST directives (they replace ADR-134's `:::query`):
//   - `:::tagged` — body's first non-empty line is a TAG NAME (a string, never a page id); lists the
//     published pages whose frontmatter `tags` include it (case-insensitive, user ruling).
//   - `:::children` — no body; lists the direct child pages of THIS page in the tree (kept tag-independent,
//     user ruling — the `:::query` teardown does not take it down).
// The body is authoring free-text, so anything unresolvable yields 0 results (never a parse error).
export type ListDirectiveName = 'tagged' | 'children'
export const LIST_DIRECTIVE_NAMES: readonly ListDirectiveName[] = ['tagged', 'children']

export function parseTaggedBody(body: string): string | null {
  const line = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (!line) return null
  const tag = line.toLowerCase().slice(0, TAG_MAX_LEN) // the index key is the lowercased name (user ruling)
  return tag || null
}

// #413 / ADR-145 §5: viewer-scoped TAG SUGGESTIONS for the frontmatter chip editor / `:::tagged` insert.
// SECURITY (the §4/§5 leak class): a tag name used ONLY on pages the caller cannot view must never be
// suggested — the tag string itself is an existence leak. So a tag is offered only when ≥1 of its pages is
// FGA-view-confirmed for the caller: over-fetch candidate (tag, page) rows by prefix, then walk tags in
// order, view-checking their pages (memoized across tags) until one passes. Published-only (draft tags are
// never in page_tags). Member-only route (no guest config). page_tags stays a stage-1 candidate set.
export interface TagSuggestion { tag: string; display: string }

const TAG_SUGGEST_N = 20        // suggestions returned
const TAG_SUGGEST_OVER_FETCH = 400 // candidate rows fetched past the display cap (ADR-027)
const TAG_SUGGEST_CHECKS_MAX = 200 // hard bound on FGA checks per request (existence-hiding stays intact)

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&')

export async function getSuggestedTags(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { q: string; subject: string; context?: { current_time: string } },
): Promise<TagSuggestion[]> {
  const prefix = args.q.trim().toLowerCase().slice(0, TAG_MAX_LEN)
  const rows = await db.sql<{ tag: string; display: string; page_id: string }[]>`
    SELECT pt.tag, pt.display, pt.page_id FROM page_tags pt
    JOIN pages p ON p.id = pt.page_id
    WHERE p.published_at IS NOT NULL
      AND p.deleted_at IS NULL
      AND pt.tag LIKE ${escapeLike(prefix) + '%'}
    ORDER BY pt.tag ASC, pt.page_id ASC
    LIMIT ${TAG_SUGGEST_OVER_FETCH}
  `
  // group candidate pages per tag, first-seen display wins (rows arrive tag-ordered)
  const byTag = new Map<string, { display: string; pages: string[] }>()
  for (const r of rows) {
    let g = byTag.get(r.tag)
    if (!g) { g = { display: r.display, pages: [] }; byTag.set(r.tag, g) }
    g.pages.push(r.page_id)
  }
  const out: TagSuggestion[] = []
  const viewCache = new Map<string, boolean>() // page id → viewable (memoized across tags)
  let checks = 0
  for (const [tag, g] of byTag) {
    if (out.length >= TAG_SUGGEST_N) break
    let visible = false
    for (const pid of g.pages) {
      let ok = viewCache.get(pid)
      if (ok === undefined) {
        if (checks >= TAG_SUGGEST_CHECKS_MAX) break // bounded work; a dropped suggestion is a UX gap, never a leak
        checks++
        ok = await check(fga, args.subject, 'view', { type: 'page', id: pid }, args.context)
        viewCache.set(pid, ok)
      }
      if (ok) { visible = true; break }
    }
    if (visible) out.push({ tag, display: g.display })
  }
  return out
}

// #370 / ADR-145 §4: resolve a dynamic list FOR THE VIEWER. Both branches are view-filtered and
// existence-hiding (the search-leak class, carried over verbatim from ADR-134 §3): the HOST page is
// view-gated first (a caller who can't see the page can't use it as a probe → uniform 404), then every
// candidate is FGA-view-confirmed (omit-on-deny — an unviewable page is absent from list AND count).
// PUBLISHED-only throughout (a draft's tags/children are absent until publish). page_tags is a stage-1
// CANDIDATE set only; the FGA view check here is the authority. Called ONLY from the member route (no
// guest config), so a share_link principal never triggers a live reverse-lookup (the ADR-134 Hole A
// discipline); the anonymous/public surface renders the baked static snapshot instead.
export async function getListResults(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; name: ListDirectiveName; body: string; subject: string; context?: { current_time: string } },
): Promise<Backlink[]> {
  const { pageId, name, body, subject, context } = args
  // View-gate the HOST page (existence-hiding, same as getBacklinks' target gate).
  if (!(await check(fga, subject, 'view', { type: 'page', id: pageId }, context))) {
    throw Object.assign(new Error('not found'), { statusCode: 404 })
  }
  if (name === 'tagged') {
    const tag = parseTaggedBody(body)
    if (!tag) return []
    const rows = await db.sql<{ id: string; title: string }[]>`
      SELECT pt.page_id AS id, p.title FROM page_tags pt
      JOIN pages p ON p.id = pt.page_id
      WHERE pt.tag = ${tag}
        AND pt.page_id <> ${pageId}
        AND p.published_at IS NOT NULL
        AND p.deleted_at IS NULL
      ORDER BY p.updated_at DESC
      LIMIT ${QUERY_OVER_FETCH}
    `
    const out: Backlink[] = []
    for (const r of rows) {
      if (out.length >= QUERY_DISPLAY_N) break // top-N VIEWABLE by rank (Hole C — over-fetch past the display cap)
      if (await check(fga, subject, 'view', { type: 'page', id: r.id }, context)) out.push({ id: r.id, title: r.title })
    }
    return out
  }
  // #370 (user ruling): `children` is the DESCENDANT TREE — grandchildren and deeper included, depth-
  // annotated (pre-order). The recursive walk traverses through UNPUBLISHED / UNVIEWABLE intermediates but
  // never emits them: a node enters the result only when it is published AND FGA-view-confirmed for the
  // caller, and the children of a dropped node RE-ROOT to the nearest emitted ancestor (the GuestSidebar
  // buildTree leak-safe pattern — a visible page is not a leak; an unviewable page's title/existence never
  // appears at any depth, in list OR count). The CTE depth cap (MAX_PAGE_DEPTH, the write-boundary cap)
  // bounds the FETCH against corrupt/deep data; the in-memory walk carries its own visited-set so a
  // parent_id cycle in corrupt data (unreachable via the move/create guards) can never recurse forever.
  // Sibling order is per-level `position`.
  const rows = await db.sql<{ id: string; title: string; parent_id: string; published: boolean; position: number; depth: number }[]>`
    WITH RECURSIVE d AS (
      SELECT id, title, parent_id, position, (published_at IS NOT NULL) AS published, 1 AS depth
        FROM pages WHERE parent_id = ${pageId} AND deleted_at IS NULL
      UNION ALL
      SELECT p.id, p.title, p.parent_id, p.position, (p.published_at IS NOT NULL) AS published, d.depth + 1
        FROM pages p JOIN d ON p.parent_id = d.id
       WHERE p.deleted_at IS NULL AND d.depth < ${MAX_PAGE_DEPTH}
    )
    SELECT id, title, parent_id, published, position, depth FROM d
    ORDER BY depth ASC, position ASC
    LIMIT ${QUERY_OVER_FETCH}
  `
  type ChildRow = { id: string; title: string; parent_id: string; published: boolean; position: number; depth: number }
  const byParent = new Map<string, ChildRow[]>()
  for (const r of rows) {
    const list = byParent.get(r.parent_id) ?? []
    list.push(r)
    byParent.set(r.parent_id, list)
  }
  const out: Backlink[] = []
  const seen = new Set<string>()
  const walk = async (parentId: string, depth: number): Promise<void> => {
    for (const r of byParent.get(parentId) ?? []) {
      if (out.length >= QUERY_DISPLAY_N) return // display cap (pre-order — over-fetch discipline as above)
      if (seen.has(r.id)) continue // corrupt-data cycle guard (see above)
      seen.add(r.id)
      const visible = r.published && (await check(fga, subject, 'view', { type: 'page', id: r.id }, context))
      if (visible) {
        out.push({ id: r.id, title: r.title, depth })
        await walk(r.id, depth + 1)
      } else {
        await walk(r.id, depth) // dropped node: its visible descendants re-root at THIS depth
      }
    }
  }
  await walk(pageId, 0)
  return out
}

// #353→#370 / ADR-145 §4: resolve a dynamic list as the ANONYMOUS principal for a PUBLIC snapshot. The live
// list is MEMBER-only (guest 401) — a per-viewer reverse-lookup is never handed to an anonymous surface
// (that would be the #244 re-entry hole). Instead, at PUBLISH a page's `:::tagged`/`:::children` blocks are
// resolved ONCE as `user:anonymous` and the results are baked into the published page; the public/guest
// reader renders that static snapshot. This is the security-critical primitive: it MUST resolve as the
// anonymous principal (NOT the publisher — resolving with the publisher's grants would leak member-only
// titles into the public snapshot), so the per-item `view` filter drops any page not publicly viewable.
// Same view-filter, existence-hiding, and published-only rules as getListResults; only the subject differs.
export const PUBLIC_ANON_SUBJECT = 'user:anonymous' // user:* in GRANT tuples ≠ user:anonymous in CHECK (public.ts)

export async function resolveAnonymousListSnapshot(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; name: ListDirectiveName; body: string; context?: { current_time: string } },
): Promise<Backlink[]> {
  // Resolve with the anonymous subject: only pages granted `view` to user:anonymous (a `view_base@user:*` grant
  // AND published) survive the per-item filter — a member-only page is dropped, so its title never enters the
  // public snapshot. A non-publicly-viewable HOST page throws the same uniform 404 (no public existence
  // oracle); the caller (the publish baker) treats that as "no snapshot" (empty), never a leak.
  try {
    return await getListResults(db, fga, { pageId: args.pageId, name: args.name, body: args.body, subject: PUBLIC_ANON_SUBJECT, context: args.context })
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode === 404) return [] // host not publicly viewable → empty snapshot
    throw e
  }
}

// The baked snapshot stored on `pages.published_query_snapshot` (#353→#370; the column name predates the
// ADR-145 rename of the directives and is kept to avoid a data migration). One entry per `:::tagged` /
// `:::children` block in the published markdown, IN DOCUMENT ORDER (resolveDirectiveRanges, both names,
// sorted by `from`) — the public route re-scans the SAME published_md and aligns i-th block ↔ i-th snapshot
// entry. `spec` is kept for debuggability only; alignment is positional, so a spec drift can never
// mis-attribute another block's results.
export interface ListSnapshot {
  readonly v: 1
  readonly blocks: { readonly spec: string; readonly results: Backlink[] }[]
}

// The `:::tagged`/`:::children` blocks of `md` in document order — the ONE filter bake and substitute must
// share (positional alignment breaks if they ever diverge).
function listDirectiveRanges(md: string) {
  return resolveDirectiveRanges(md).filter((d) => (LIST_DIRECTIVE_NAMES as readonly string[]).includes(d.name))
}

// Bake the anonymous snapshot for EVERY list block in `md` (any nesting depth), in document order. Called
// at publish (both the real and no-op paths — a re-publish refreshes the public list even when THIS page's text
// is unchanged, since results depend on OTHER pages' publish/grant state). Each block resolves as
// `user:anonymous`, so a member-only match is dropped by the per-item view-filter (never in the public snapshot).
export async function bakeListSnapshot(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; md: string },
): Promise<ListSnapshot> {
  const listDirs = listDirectiveRanges(args.md)
  const blocks: { spec: string; results: Backlink[] }[] = []
  for (const d of listDirs) {
    const body = args.md.slice(d.bodyFrom, d.bodyTo)
    const specLine = `${d.name} ${body.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''}`.trim()
    const results = await resolveAnonymousListSnapshot(db, fga, { pageId: args.pageId, name: d.name as ListDirectiveName, body })
    blocks.push({ spec: specLine, results })
  }
  return { v: 1, blocks }
}

// #85 / ADR-059: the same per-block resolution, but as a NAMED VIEWER. The member read surface keeps the
// literal `:::tagged`/`:::children` and resolves it live through the member-only /list route, so any
// DOM-free render of `published_md` (HTML export — and, since ADR-191, print) saw the unresolved directive
// and emitted an empty box: a page whose body is a dynamic list exported and PRINTED as nothing. Baking the
// ANONYMOUS snapshot in here instead would be the wrong list (a member exporting their own page would get
// the public subset silently), so the viewer's own subject resolves it — the identical call the /list route
// makes, with its host-page view gate and its per-item view filter, so an unviewable page cannot enter an
// export any more than it can enter the on-screen list.
export async function resolveListSnapshotForViewer(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; md: string; subject: string; context?: { current_time: string } },
): Promise<ListSnapshot> {
  const listDirs = listDirectiveRanges(args.md)
  const blocks: { spec: string; results: Backlink[] }[] = []
  for (const d of listDirs) {
    const body = args.md.slice(d.bodyFrom, d.bodyTo)
    const specLine = `${d.name} ${body.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''}`.trim()
    const results = await getListResults(db, fga, {
      pageId: args.pageId, name: d.name as ListDirectiveName, body, subject: args.subject, context: args.context,
    })
    blocks.push({ spec: specLine, results })
  }
  return { v: 1, blocks }
}

// Escape the characters that would break out of a Markdown link's `[text]` label — a page title is arbitrary
// text and must not inject markup into the substituted list (the public render sanitizes HTML too, but keep the
// generated Markdown well-formed). Backslash first, then the brackets that close the label; newlines fold to a
// space. `(`/`)` need no escaping here — they sit in the label, where they cannot start the `(url)` part. The id
// is an internal uuid (safe in the URL).
function escapeMdLinkText(s: string): string {
  return s.replace(/[\\\[\]]/g, '\\$&').replace(/[\r\n]+/g, ' ')
}

// Render one baked block's results as a static Markdown bullet list of internal links (the ADR-145 §3
// "degrade to a static snapshot" form). Empty results → empty string (the block renders NOTHING, matching
// the member read surface — no empty box).
export function renderListSnapshot(results: readonly Backlink[]): string {
  if (results.length === 0) return ''
  // depth (#370) indents a nested `:::children` entry two spaces per level — a standard nested
  // Markdown bullet list, so the public/guest static snapshot renders the same tree the member sees.
  return results.map((r) => `${'  '.repeat(r.depth ?? 0)}- [${escapeMdLinkText(r.title)}](/p/${r.id})`).join('\n')
}

// Substitute every `:::tagged`/`:::children` directive in `md` with its baked anonymous list — the
// public/guest render pipeline calls this so the anonymous surface shows a STATIC list (no live per-viewer
// resolution, the ADR-134 Hole A discipline carried over). Replaces END→START so earlier offsets stay valid.
// Alignment is positional against the SAME md the snapshot was baked from; a missing snapshot, a shorter
// snapshot, or a count mismatch collapses the unmatched block to nothing (fail-safe: a list never renders a
// live/unauthorized list on the public surface). Pure — no I/O.
export function substituteListSnapshots(md: string, snapshot: ListSnapshot | null | undefined): string {
  const listDirs = listDirectiveRanges(md) // same filter+order as bake
  if (listDirs.length === 0) return md
  let out = md
  for (let i = listDirs.length - 1; i >= 0; i--) {
    const d = listDirs[i]!
    const block = snapshot?.v === 1 ? snapshot.blocks[i] : undefined
    const replacement = block ? renderListSnapshot(block.results) : '' // no snapshot / mismatch → render nothing
    out = out.slice(0, d.from) + replacement + out.slice(d.to)
  }
  return out
}

// ── #224 / ADR-104: title dictionary + excerpt (auto internal links) ─────────

export interface TitleDictEntry { id: string; title: string }

// The user-typed "public" principal (same as routes/public.ts): `view_base@user:*` only matches
// user-type principals (#244 typed-wildcard lesson), so this resolves exactly the PUBLIC page set.
const DICT_ANON = 'user:anonymous'
// condition 2: a hard server-side dictionary cap bounds the client's match cost
// (matchTitleLinks is O(dict × visible text)). Overflow is a UX gap, never a leak (absent = safe).
const DICT_CAP = 2000
// #540: OpenFGA's ListObjects answers at most its configured max results — 1000 by default — and says
// NOTHING when it truncates. A response this long is therefore treated as possibly incomplete and the
// dictionary falls back to asking the question the other way around (DB candidates → batch confirm),
// which has no such ceiling. If a deployment ever LOWERS the server-side max below this, truncation
// would go undetected again — this constant must not exceed the deployed listObjects max.
// Exported for the public pages listing (#545), which carries the same ListObjects shape and must
// distrust the same ceiling — one constant, so the two cannot drift.
export const LIST_OBJECTS_TRUNCATION_FLOOR = 1000

// The viewer-scoped title dictionary (ADR-104 Addendum 3 Finding A, shape (ii) DB + ListObjects).
// authz model (Addendum 2 point 1): this dictionary IS the primary defence — it must only ever
// contain titles the caller may view. Two principals:
//   - member  → FGA ListObjects('view') for user:<sub> — the full authoritative view set — then the
//     tenant-scoped (RLS) title join, then the Addendum-3 belt-and-braces filterAuthorized confirm.
//   - share_link guest → **forced to the PUBLIC set via the anonymous user-typed principal** and
//     published-only rows. The share_link principal itself is NEVER given a reverse lookup — that is
//     the binding closing the #244 re-entry (a space-shared non-public title must not leak).
// Existence-hiding needs no 404 here: a non-viewable page is simply absent from the response.
//
// #540: ListObjects is not trusted past its own ceiling. It truncates silently at the server's max
// (1000 by default), and the DB-derived `capped` flag knew nothing about it — so a viewer with more
// than 1000 viewable pages got a dictionary that claimed to be complete (`capped: false`) while titles
// were missing, which reads exactly like existence-hiding. Two shapes now:
//   - result below the floor → it is the complete authoritative view set; keep the original flow. This
//     is the common case, and it is what keeps a low-privilege member of a huge tenant correct: their
//     few viewable pages are found by NAME, not by being among the tenant's newest.
//   - result AT the floor → possibly truncated. Ask the other way around: newest tenant pages from the
//     DB (RLS-scoped) as candidates, then the same fail-closed filterAuthorized confirm decides every
//     entry. No ListObjects ceiling applies, and `capped` means what it says (the candidate window
//     overflowed, so the dictionary MAY be missing older titles).
// #541 confirm `ids` in slices, stopping when the time budget is spent. Every id in the result
// was individually confirmed (same fail-closed filterAuthorized); ids the budget never reached are
// simply ABSENT — never allowed by default. `exhausted` tells the caller the answer is partial.
async function confirmWithinBudget(
  fga: OpenFgaClient,
  principal: string,
  ids: string[],
  budgetMs: number,
  signal?: AbortSignal,
): Promise<{ confirmed: Set<string>; exhausted: boolean }> {
  // Lanes dropped 4 → 1 (measured): dev's FGA datastore and the app DB share one postgres, and
  // a 4-lane wave = 200 concurrent point checks saturated it — endpoints that never touch FGA at all
  // (/me/settings, /pins) measured 2.1s while a dictionary ran. At 1 lane the instantaneous pressure
  // quarters and interactive queries interleave between batches, and the budget above bounds the
  // damage under load instead of the storm.
  //
  // ⚠️ #887: this used to add "an idle box still completes a full 2000-id confirm in ~1-2s". It does
  // not. Measured 2026-08-22 on an idle box against a freshly rotated store (18 tuples, 2,140 with the
  // fixture; `apps/server/measure-surfaces-755.mjs`): 4.9 ms per id at this shape, so 2,000 ids is
  // ~9.7 SECONDS of work. With `budgetMs` at 2,000 the confirm therefore reaches roughly 400 of them
  // and returns `degraded: true` — about a fifth of the cap.
  //
  // That is not a fault: a partial dictionary is under-disclosure, and the links fill in on the next
  // fetch. It is written down because the sentence it replaces was the stated reason for one lane, and
  // "2,000 in two seconds" and "a fifth of them in two seconds" argue for different lane counts. If
  // anybody revisits that, the 2.1s interactive-starvation figure above is the measurement to redo
  // first — it is why one lane was chosen, and it has not been re-measured since.
  const SLICE = 200 // 4 chunks of 50, sequential inside the slice; budget checked between slices
  const started = Date.now()
  const confirmed = new Set<string>()
  for (let i = 0; i < ids.length; i += SLICE) {
    if (Date.now() - started > budgetMs) return { confirmed, exhausted: true }
    const part = await filterAuthorized(fga, principal, 'view', ids.slice(i, i + SLICE), undefined, 'page', 1, signal)
    for (const id of part) confirmed.add(id)
  }
  return { confirmed, exhausted: false }
}

export async function getTitleDictionary(
  db: TenantDb,
  fga: OpenFgaClient,
  // #541 `signal` aborts the confirm between batch waves when the requester is gone (tab
  // navigated / connection closed). An abandoned dictionary kept flooding the checker for seconds and
  // starved the NEXT page-open's interactive checks — the measured bimodal sidebar. Abort throws (the
  // response is dead), never fabricates a verdict.
  // `budgetMs` bounds the CONFIRM's checker occupancy (default 2000ms). the slow mode, measured on
  // the dev log: an abandoned dictionary ran its full confirm for ~4.7s THROUGH the next page-open,
  // and every interactive check of that open crawled beside it. The socket-close abort above does not
  // fire behind the vite proxy (the backend socket is the proxy's, and it stays open), so the bound
  // must be self-imposed: confirm in slices, stop when over budget, and return what has been CONFIRMED
  // so far with `degraded: true`. A partial dictionary is strictly under-disclosure (fail closed on
  // content) and the dictionary is an enhancement — a few links filling in on the next refetch beats
  // the login-path checks starving for seconds.
  args: { subject: string; signal?: AbortSignal; budgetMs?: number },
): Promise<{ entries: TitleDictEntry[]; capped: boolean; degraded?: boolean }> {
  const isGuest = args.subject.startsWith('share_link:')
  const principal = isGuest ? DICT_ANON : args.subject
  const { objects } = await fga.listObjects({ user: principal, relation: 'view', type: 'page' })
  const ids = (objects ?? []).map((o: string) => o.replace(/^page:/, ''))

  if (ids.length >= LIST_OBJECTS_TRUNCATION_FLOOR) {
    // Possibly-truncated ListObjects → candidates come from the DB instead. Guests still only link
    // into the published public surface. The confirm below is the sole authz gate on this branch —
    // every candidate that the viewer cannot view is dropped by it (fail-closed, model id pinned).
    const rows = isGuest
      ? await db.sql<{ id: string; title: string }[]>`
          SELECT id, title FROM pages WHERE published_at IS NOT NULL AND deleted_at IS NULL
          ORDER BY updated_at DESC LIMIT ${DICT_CAP + 1}`
      : await db.sql<{ id: string; title: string }[]>`
          SELECT id, title FROM pages WHERE deleted_at IS NULL
          ORDER BY updated_at DESC LIMIT ${DICT_CAP + 1}`
    const capped = rows.length > DICT_CAP
    const windowRows = capped ? rows.slice(0, DICT_CAP) : rows
    const { confirmed, exhausted } = await confirmWithinBudget(fga, principal, windowRows.map((r) => r.id), args.budgetMs ?? 2000, args.signal)
    return { entries: windowRows.filter((r) => confirmed.has(r.id)), capped, ...(exhausted ? { degraded: true } : {}) }
  }

  if (ids.length === 0) return { entries: [], capped: false }
  // ListObjects spans the shared FGA store; the tenant-scoped handle (RLS) narrows to this tenant.
  // Guests link only into the published public surface; members may link to viewable drafts too
  // (their titles already show in the member sidebar — nothing new is revealed).
  const rows = isGuest
    ? await db.sql<{ id: string; title: string }[]>`
        SELECT id, title FROM pages WHERE id = ANY(${ids}) AND published_at IS NOT NULL AND deleted_at IS NULL
        ORDER BY updated_at DESC LIMIT ${DICT_CAP + 1}`
    : await db.sql<{ id: string; title: string }[]>`
        SELECT id, title FROM pages WHERE id = ANY(${ids}) AND deleted_at IS NULL
        ORDER BY updated_at DESC LIMIT ${DICT_CAP + 1}`
  const capped = rows.length > DICT_CAP
  const windowRows = capped ? rows.slice(0, DICT_CAP) : rows
  // Addendum 3: the final confirm on the capped window (belt-and-braces for the ListObjects shape;
  // a SINGLE filterAuthorized pass — never per-link display-time checks, anti-test 8).
  // #534: the window is capped at 2000, i.e. up to 40 batches. Sequentially that is the ~14s a user waits
  // for the editor to open on a large space. The dictionary is an ENHANCEMENT (auto internal links), never a
  // gate, so it is exactly the caller that may take a few lanes — bounded at 4, which keeps #489's "not all
  // at once" while cutting 40 waves to 10. The confirm itself is unchanged: same relation, same fail-closed
  // handling, so what lands in the dictionary is identical.
  const { confirmed, exhausted } = await confirmWithinBudget(fga, principal, windowRows.map((r) => r.id), args.budgetMs ?? 2000, args.signal)
  return { entries: windowRows.filter((r) => confirmed.has(r.id)), capped, ...(exhausted ? { degraded: true } : {}) }
}

// The hover-card excerpt (ADR-104 Slice B): a thin, view-gated read following the getPublished
// pattern — deny and missing are the SAME 404 (#262 existence-hiding; anti-test 5: no wording ever
// distinguishes them). Published content only: an unpublished draft returns excerpt null (the title
// alone is already in the viewer's dictionary). This returns the published Markdown SOURCE prefix; the client
// renders it with the shared DOM-safe renderer (`renderMarkdownToDom` — createTextNode/textContent
// construction, `safeHref`, NO innerHTML), so a raw `<script>` / dangerous scheme stays inert (#351).
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
  // Members create DRAFTS; a space-EDIT-link guest creates a page PUBLISHED, atomically (#274 / ADR-135
  // §3 — guest drafts are impossible-by-construction). The guest branch never forwards the member-only
  // seeds (templateId/fromPageId): template#view has no share_link path and the fence stays structural.
  app.post<{ Params: { spaceId: string }; Body: { title?: string; parentId?: string | null; fromPageId?: string | null; templateId?: string | null } }>(
    '/spaces/:spaceId/pages', { config: { guest: 'edit' } }, async (req, reply) => {
      // #667 every field here is optional, so a bodyless POST could have meant "an untitled
      // page". It is refused instead, and uniformly with its four neighbours: creating something is
      // worth being asked for explicitly, and nobody can be relying on the old behaviour — it was a 500.
      const body = requireBody(req.body)
      if (!req.user) {
        if (!req.guest) return reply.code(401).send({ error: 'unauthorized' })
        // #274 / ADR-135 §3: the guest created-page cap (two-bucket link+session window; static reason
        // code only, same no-oracle rule as publish). BEFORE any work so a flooding guest costs ~nothing.
        if (!(await guestCreatePageRateAllowed(app.valkey, req.db, { tenantId: req.tenant.id, shareLinkId: req.guest.shareLinkId, anonId: req.guest.anonId }))) {
          // #326: no page exists yet, so the flag carries the SPACE only — the display gate already
          // handles space-scoped events through space#view.
          await recordAbuseFlag(app.valkey, req.db, {
            tenantId: req.tenant.id, eventType: 'abuse.rate_capped_create',
            pageId: null, spaceId: req.params.spaceId, actor: abuseActor(req, `guest:${req.guest.shareLinkId}`),
            linkId: req.guest.shareLinkId,
            // Same reason as the publish cap: the space's edit gate lives further down, in
            // guestCreatePublishPage, so it is checked here before this space's queue gains a row.
            authorize: () => check(app.fga, `share_link:${req.guest!.shareLinkId}`, 'edit', { type: 'space', id: req.params.spaceId }, { current_time: new Date().toISOString() }),
          })
          return reply.code(429).send({ error: 'rate limited', reason: 'create_rate' })
        }
        const page = await guestCreatePublishPage(req.db, app.fga, app.searchDriver, app.storageDriver, {
          tenantId: req.tenant.id,
          spaceId: req.params.spaceId,
          shareLinkId: req.guest.shareLinkId,
          anonId: req.guest.anonId,
          title: body.title,
          parentId: body.parentId ?? null,
        })
        return reply.code(201).send(page)
      }
      const page = await createPage(req.db, app.fga, app.searchDriver, {
        tenantId: req.tenant.id,
        spaceId: req.params.spaceId,
        userId: req.user.sub,
        title: body.title,
        parentId: body.parentId ?? null,
        fromPageId: body.fromPageId ?? null, // #229: seed from a page ("duplicate", view-gated)
        templateId: body.templateId ?? null, // #250: seed from a template snapshot (view-gated)
      })
      return reply.code(201).send(page)
    },
  )

  // Move/reorder a page. parentId null = top level; afterId null = first child of
  // the target parent. spaceId moves the page (and its subtree) to another space
  // (3b ②); when parentId is given, the parent's space is authoritative.
  app.patch<{ Params: { pageId: string }; Body: { parentId?: string | null; afterId?: string | null; spaceId?: string | null } }>(
    '/pages/:pageId/move', async (req) => {
      // #667 every field defaults to null, so treating a missing body as `{}` would read as
      // "move to the top level, first position" — a destructive default nobody asked for. An explicit
      // `{}` still means that, because the caller said so.
      const body = requireBody(req.body)
      return movePage(req.db, app.fga, app.searchDriver, {
        pageId: req.params.pageId,
        userId: req.user.sub,
        parentId: body.parentId ?? null,
        afterId: body.afterId ?? null,
        spaceId: body.spaceId ?? null,
      })
    },
  )

  // The space page tree — for a member, or a space-link guest (#104). A guest's token is
  // bound to THIS space (resource.type=space, id=spaceId), and listPages only returns the
  // published pages the guest may view (leak-safe). View is the floor (no comment/edit needed).
  app.get<{ Params: { spaceId: string }; Querystring: { first?: string } }>('/spaces/:spaceId/pages', { config: { guest: 'view' } }, async (req, reply) => {
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
    // #903 / ADR-220 §13: a GUEST no longer pays for a `view` Check (and a badge read) on every page in
    // the space to show `GUEST_TREE_CAP` rows — the walk below stops confirming once it has that many
    // VISIBLE pages, rather than confirming everything and slicing after. §6.2's contract is unchanged:
    // one response, the full (now bounded) visible set, and a `truncated` flag.
    //
    // Members are NOT capped here — the branch route is their answer, and capping the whole-space read
    // would be the silent truncation this ticket exists to remove. `first=N` (the partial first paint,
    // #541) is a member-only optimization the guest shell never asks for (§6.2: rendered fully expanded
    // in one response) — only read for the member arm.
    if (req.guest) {
      return listPagesGuestBounded(req.db, app.fga, { spaceId: req.params.spaceId, subject, context })
    }
    const firstRaw = (req.query as { first?: string } | undefined)?.first
    const firstN = firstRaw != null ? Math.min(100, Math.max(1, Number.parseInt(firstRaw, 10) || 0)) || undefined : undefined
    const pages = await listPages(req.db, app.fga, { spaceId: req.params.spaceId, subject, context, firstN })
    return { pages, truncated: false }
  })

  // #623 / ADR-220 §5: the first paint — the root branch plus the path to the open page.
  app.get<{ Params: { spaceId: string }; Querystring: { open?: string; limit?: string } }>(
    '/spaces/:spaceId/pages/paint', { config: { guest: 'view' } }, async (req, reply) => {
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
      const asked = Number.parseInt(req.query.limit ?? '', 10)
      return paintTree(req.db, app.fga, {
        spaceId: req.params.spaceId, subject,
        ...(context ? { context } : {}),
        ...(req.query.open ? { open: req.query.open } : {}),
        ...(Number.isFinite(asked) ? { limit: asked } : {}),
      })
    })

  // #623 / ADR-220 §1-§3: ONE BRANCH of the tree — the children of one parent, bounded and keyset-paged.
  //
  // Additive: `/spaces/:spaceId/pages` still answers the whole space, and the sidebar still reads it.
  // Moving the client onto branches is the next slice; landing the surface first means its refusals can
  // be pinned before anything depends on them.
  //
  // ⚠️ The caller NAMES the parent here, which the whole-space route never allowed. Every refusal is one
  // 404 — see listBranch. The guest arm is bound to its own space exactly as the whole-space route is.
  app.get<{ Params: { spaceId: string }; Querystring: { parent?: string; cursor?: string; limit?: string } }>(
    '/spaces/:spaceId/pages/branch', { config: { guest: 'view' } }, async (req, reply) => {
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
      const asked = Number.parseInt(req.query.limit ?? '', 10)
      // `parent` absent (or the literal "root") means the space's root branch.
      const parentRaw = req.query.parent
      const parentId = !parentRaw || parentRaw === 'root' ? null : parentRaw
      return listBranch(req.db, app.fga, {
        spaceId: req.params.spaceId, parentId, subject,
        ...(context ? { context } : {}),
        ...(Number.isFinite(asked) ? { limit: asked } : {}),
        ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
      })
    })

  // ADR-238 / #739: WHERE is this row in the tree? One round trip, so the sidebar never reads until it
  // finds. Guest-capable on the same terms as the branch route it feeds: a space link may ask about its
  // own space, and every refusal is the branch route's single 404.
  app.get<{ Params: { spaceId: string; pageId: string }; Querystring: { limit?: string } }>(
    '/spaces/:spaceId/pages/:pageId/path', { config: { guest: 'view' } }, async (req, reply) => {
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
      const asked = Number.parseInt(req.query.limit ?? '', 10)
      return pathToPage(req.db, app.fga, {
        spaceId: req.params.spaceId, pageId: req.params.pageId, subject,
        ...(context ? { context } : {}),
        ...(Number.isFinite(asked) ? { limit: asked } : {}),
      })
    })

  // #623 ②: the placeholder follow-up. Members only — §4.4 settles guests by principal type,
  // and a share_link asking gets an empty answer rather than a distinguishable refusal.
  app.get<{ Params: { spaceId: string }; Querystring: { parent?: string } }>(
    '/spaces/:spaceId/pages/tree-placeholders', async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'unauthorized' })
      const parentRaw = req.query.parent
      return branchPlaceholders(req.db, app.fga, {
        spaceId: req.params.spaceId,
        parentId: !parentRaw || parentRaw === 'root' ? null : parentRaw,
        subject: `user:${req.user.sub}`,
        tenantId: req.tenant.id,
        groups: req.user.groups,
      })
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
    // #364 ①: hand the caller's principal through so homePageId is view-gated (member = user,
    // guest = the share_link principal with current_time — an unpublished home stays null for guests).
    const viewer = req.user
      ? { fga: app.fga, subject: `user:${req.user.sub}` }
      : { fga: app.fga, subject: `share_link:${req.guest!.shareLinkId}`, context: { current_time: new Date().toISOString() } }
    const info = await getSpaceInfo(req.db, req.params.spaceId, viewer)
    if (!info) return reply.code(404).send({ error: 'not found' })
    return info
  })

  // Pages overview for space managers (Phase 5 #5) — space#manage gated.
  app.get<{ Params: { spaceId: string }; Querystring: { limit?: string; cursor?: string; q?: string } }>(
    '/spaces/:spaceId/pages-overview', async (req) => {
      const raw = Number.parseInt(req.query?.limit ?? '', 10)
      return listSpacePagesOverview(req.db, app.fga, {
        spaceId: req.params.spaceId, userId: req.user.sub,
        limit: Number.isFinite(raw) ? raw : undefined, cursor: req.query?.cursor, q: req.query?.q,
      })
    })

  app.get<{ Params: { pageId: string } }>('/pages/:pageId', async (req) => {
    return getPage(req.db, app.fga, { pageId: req.params.pageId, userId: req.user.sub })
  })

  // Rename — members or an EDIT-capability guest (#274 guest pages are created "Untitled" and
  // named here, member-parity). The FGA edit gate is the shared authority; view tokens are rejected by
  // the auth hook's capability guard before the handler.
  app.patch<{ Params: { pageId: string }; Body: { title: string } }>(
    '/pages/:pageId', { config: { guest: 'edit' } }, async (req) => {
      const body = requireBody(req.body) // #667 the reported crash — `req.body.title` on undefined
      return updatePage(req.db, app.fga, app.searchDriver, {
        pageId: req.params.pageId,
        ...(req.user ? { userId: req.user.sub } : { guest: { shareLinkId: req.guest!.shareLinkId, anonId: req.guest!.anonId } }),
        title: body.title,
      })
    },
  )

  // #411 / ADR-153: DELETE moves the page (and its subtree) to the trash. Physical deletion happens only
  // through the trash: explicit purge below, or the retention sweep after TRASH_RETENTION_DAYS.
  app.delete<{ Params: { pageId: string } }>('/pages/:pageId', async (req, reply) => {
    await trashPage(req.db, app.fga, app.searchDriver, { pageId: req.params.pageId, userId: req.user.sub })
    return reply.code(204).send()
  })

  app.post<{ Params: { pageId: string } }>('/pages/:pageId/restore', async (req, reply) => {
    const r = await restorePage(req.db, app.fga, app.searchDriver, { pageId: req.params.pageId, userId: req.user.sub })
    return reply.code(200).send(r)
  })

  app.delete<{ Params: { pageId: string } }>('/pages/:pageId/purge', async (req, reply) => {
    await purgePage(req.db, app.fga, app.searchDriver, { pageId: req.params.pageId, userId: req.user.sub })
    return reply.code(204).send()
  })

  // #437 / ADR-167: the direct permanent path (modes 'both' / 'direct_only' only — 400 otherwise).
  app.delete<{ Params: { pageId: string } }>('/pages/:pageId/permanent', async (req, reply) => {
    await directDeletePage(req.db, app.fga, app.searchDriver, { pageId: req.params.pageId, userId: req.user.sub })
    return reply.code(204).send()
  })

  // Trash listing is a member-only settings surface (no guest config — a share_link token never lists a
  // trash even if its own page is in it).
  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/trash', async (req) => {
    return listSpaceTrash(req.db, app.fga, { spaceId: req.params.spaceId, userId: req.user.sub })
  })

  // #511 / ADR-185: bulk-delete a selection of pages in the space (member-only; no guest config). Per-page
  // authz + subtree cascade + reindex ride inside bulkDeletePages; the response is a partial-success map.
  app.post<{ Params: { spaceId: string }; Body: { pageIds?: unknown } }>('/spaces/:spaceId/pages/bulk-delete', async (req, reply) => {
    const pageIds = Array.isArray(req.body?.pageIds) ? req.body.pageIds.filter((x): x is string => typeof x === 'string') : []
    const r = await bulkDeletePages(req.db, app.fga, app.searchDriver, { spaceId: req.params.spaceId, pageIds, userId: req.user.sub })
    return reply.code(200).send(r)
  })

  // #511 / ADR-185 (slice 2): bulk-publish a selection of pages in the space (member-only; no guest config).
  // Per-page `publish` gate + abuse filter + revision + reindex ride inside bulkPublishPages; the response is a
  // partial-success map. `flush` drains each page's live collab draft first (same as the single /publish route).
  app.post<{ Params: { spaceId: string }; Body: { pageIds?: unknown } }>('/spaces/:spaceId/pages/bulk-publish', async (req, reply) => {
    const pageIds = Array.isArray(req.body?.pageIds) ? req.body.pageIds.filter((x): x is string => typeof x === 'string') : []
    const flush = (pageId: string) => flushDraft(app.valkey, docName(req.tenant.id, pageId))
    const r = await bulkPublishPages(req.db, app.fga, app.searchDriver, app.storageDriver, { spaceId: req.params.spaceId, pageIds, userId: req.user.sub, flush })
    return reply.code(200).send(r)
  })

  // #511 / ADR-185 (slice 3): bulk visibility (member-only; no guest config). `private: true` makes the
  // selection private, `false` clears it. The per-page `share` gate, the marker pair, the subtree cascade and
  // the outbox reindex all ride inside bulkSetPageVisibility; the response is a partial-success map. That
  // reindex is a TRUSTED path, not a synchronous one — the row commits with the page's transaction
  // and a worker collects what the inline call misses; search safety comes from the FGA re-check at read.
  app.post<{ Params: { spaceId: string }; Body: { pageIds?: unknown; private?: unknown } }>('/spaces/:spaceId/pages/bulk-visibility', async (req, reply) => {
    const pageIds = Array.isArray(req.body?.pageIds) ? req.body.pageIds.filter((x): x is string => typeof x === 'string') : []
    if (typeof req.body?.private !== 'boolean') return reply.code(400).send({ error: 'private (boolean) required' })
    const r = await bulkSetPageVisibility(req.db, app.fga, app.searchDriver, {
      spaceId: req.params.spaceId, pageIds, makePrivate: req.body.private,
      tenantId: req.tenant.id, userId: req.user.sub, plan: req.tenant.plan,
    })
    return reply.code(200).send(r)
  })

  // #511 / ADR-185 (slice 5): bulk move (member-only; no guest config). The destination's `manage` is
  // checked inside bulkMovePages — the approved decision requires manage on BOTH sides and the single-page
  // primitive only asks `edit` of the destination space.
  app.post<{ Params: { spaceId: string }; Body: { pageIds?: unknown; targetSpaceId?: unknown } }>('/spaces/:spaceId/pages/bulk-move', async (req, reply) => {
    const pageIds = Array.isArray(req.body?.pageIds) ? req.body.pageIds.filter((x): x is string => typeof x === 'string') : []
    const targetSpaceId = typeof req.body?.targetSpaceId === 'string' ? req.body.targetSpaceId : ''
    if (!targetSpaceId) return reply.code(400).send({ error: 'targetSpaceId required' })
    const r = await bulkMovePages(req.db, app.fga, app.searchDriver, {
      spaceId: req.params.spaceId, targetSpaceId, pageIds, userId: req.user.sub,
    })
    return reply.code(200).send(r)
  })

  // Publish the current draft as the new published version (edit-gated). Members or
  // an edit-capable guest (share-link) — same FGA `edit` check either way.
  app.post<{ Params: { pageId: string } }>('/pages/:pageId/publish', { config: { guest: 'edit' } }, async (req, reply) => {
    const p = principalForPage(req, req.params.pageId)
    // #328 / ADR-140 increment 2: guest publish rate cap (share-link + #331 session buckets; never raw
    // IP). Members are not capped. BEFORE flushDraft/publishPage so a flooding guest costs nothing
    // beyond the caps read; a STATIC reason code only (no content/limit interpolation — same no-oracle
    // rule as the 422 below, and the caller holds an edit-capable token, so nothing new is revealed).
    if (req.guest && !(await guestPublishRateAllowed(app.valkey, req.db, { tenantId: req.tenant.id, shareLinkId: req.guest.shareLinkId, anonId: req.guest.anonId }))) {
      // #326: flag the refusal for patrol. The throttle is consulted FIRST so a flooding guest costs a
      // single Valkey round-trip — the page lookup only happens for the one refusal that gets recorded,
      // keeping the "a flood costs ~nothing" property this cap was written for.
      await recordAbuseFlag(app.valkey, req.db, {
        tenantId: req.tenant.id, eventType: 'abuse.rate_capped_publish',
        pageId: req.params.pageId, actor: abuseActor(req, `guest:${req.guest.shareLinkId}`),
        linkId: req.guest.shareLinkId,
        // The cap fires BEFORE the edit gate, so prove the token actually reaches this page before
        // writing a row about it — otherwise a token for one page plants flags on another.
        authorize: () => check(app.fga, `share_link:${req.guest!.shareLinkId}`, 'edit', { type: 'page', id: req.params.pageId }, { current_time: new Date().toISOString() }),
        spaceId: async () => (await req.db.sql<[{ space_id: string }?]>`SELECT space_id FROM pages WHERE id = ${req.params.pageId}`)[0]?.space_id ?? null,
      })
      return reply.code(429).send({ error: 'rate limited', reason: 'publish_rate' })
    }
    // Flush the live draft to pages.ydoc BEFORE snapshotting, so a publish issued
    // right after typing (within the collab debounce window) includes those edits and
    // does not leave them behind as "unpublished changes". Best-effort: never blocks
    // longer than the timeout, and is a no-op when collab isn't running (e.g. tests).
    await flushDraft(app.valkey, docName(req.tenant.id, req.params.pageId))
    // #326: the refusal below is patrol supply. The flag is recorded HERE, awaited, before the reply —
    // a fire-and-forget write would run after onResponse released the tenant connection, and the row
    // would be refused by RLS with nothing to show for it (the reviewer proved exactly that).
    let rejected: { reason: string; spaceId: string } | null = null
    try {
      return await publishPage(req.db, app.fga, app.searchDriver, app.storageDriver, {
        pageId: req.params.pageId, ...p,
        onAbuseReject: (reason, spaceId) => { rejected = { reason, spaceId } },
      })
    } catch (e) {
      if (rejected) {
        const r: { reason: string; spaceId: string } = rejected
        await recordAbuseFlag(app.valkey, req.db, {
          tenantId: req.tenant.id,
          eventType: r.reason === 'banned_content' ? 'abuse.publish_rejected_banned' : 'abuse.publish_rejected_mass_delete',
          pageId: req.params.pageId, spaceId: r.spaceId, actor: abuseActor(req, p.createdBy),
          linkId: req.guest?.shareLinkId ?? null,
          // publishPage already ran the edit gate to get this far — the rejection is a CONTENT verdict,
          // not a permission one — so the right to write about this page is established.
          authorize: async () => true,
        })
      }
      // #328 / ADR-140: surface the abuse-filter rejection as a 422 with the STATIC reason code so the client
      // can show a specific message (mass_delete / banned_content) — never the offending content (no oracle).
      const reason = (e as { reason?: string }).reason
      if ((e as { statusCode?: number }).statusCode === 422 && reason) return reply.code(422).send({ error: 'publish rejected', reason })
      throw e
    }
  })

  // Toggle a single task checkbox on the published page WITHOUT creating a revision
  // (ADR-019). Edit-gated (FGA bastion) like publish; the client has already flipped
  // the live draft, so flush it first, then fold the one flip into published_md.
  app.post<{ Params: { pageId: string }; Body: { index: number; to?: boolean } }>(
    '/pages/:pageId/tasks/toggle', { config: { guest: 'edit' } }, async (req) => {
      const body = requireBody(req.body) // #667 `index` is required, and undefined would toggle nothing
      const p = principalForPage(req, req.params.pageId)
      await flushDraft(app.valkey, docName(req.tenant.id, req.params.pageId))
      return toggleTask(req.db, app.fga, app.searchDriver, {
        pageId: req.params.pageId, subject: p.subject, createdBy: p.createdBy, index: body.index,
        // #830: optional, and only ever used to tell a folded flip from one that never arrived.
        to: typeof body.to === 'boolean' ? body.to : undefined,
        context: p.context,
      })
    },
  )

  // Read the published content + draft-vs-published state (view-gated). Members or a
  // view-capable guest. The web view surface and guest share routes render this.
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/published', { config: { guest: 'view' } }, async (req) => {
    const { subject, context } = principalForPage(req, req.params.pageId)
    return getPublished(req.db, app.fga, { pageId: req.params.pageId, subject, context })
  })

  // #464 / ADR-175: record a genuine READ for page analytics. The reading surface calls this ONCE on mount
  // (never the polled /published fetch, nor an editor/preview open — the ADR §2 explicit read signal, so
  // "member views" means readers, not people who opened the editor). VIEW-gated with existence-hiding (a
  // non-viewer 404s here exactly like /published, so this is never an oracle and only view-able pages are
  // recorded). A MEMBER is named in the roster (reliable, deduped per day); a view-GUEST is aggregated only
  // (no durable id). Collection is EE-gated + deduped inside collectPageView; a hiccup never 500s the mount.
  app.post<{ Params: { pageId: string } }>('/pages/:pageId/view', { config: { guest: 'view' } }, async (req, reply) => {
    const { subject, context } = principalForPage(req, req.params.pageId)
    // #489 (HAR fact 1): the view record is a NON-CRITICAL write — if the authz check itself errors
    // (FGA deadline under saturation), do not 500 the reading surface; skip the record with a warn and
    // 204. Uniform for every page (viewable/non-viewable/nonexistent alike), so it is never an oracle;
    // nothing is recorded on an unconfirmed check. A clean `false` still 404s below (existence-hiding).
    let canView: boolean
    try {
      canView = await check(app.fga, subject, 'view', { type: 'page', id: req.params.pageId }, context)
    } catch (e) {
      req.log.warn({ err: e, pageId: req.params.pageId }, 'page-view record skipped: authz check unavailable')
      return reply.code(204).send()
    }
    if (!canView) {
      return reply.code(404).send({ error: 'not found' }) // existence-hiding — same floor as /published
    }
    // dedup key: a member by sub, a guest by its pseudonymous per-session anonId (never a durable store).
    // The event goes to the seam raw; the EE collector owns entitlement, day bucketing and the write.
    const tenant = { id: req.tenant.id, plan: req.tenant.plan }
    await collectPageViewEvent(req.user
      ? { tenant, pageId: req.params.pageId, viewerClass: 'member', memberSub: req.user.sub, dedupKey: req.user.sub }
      : { tenant, pageId: req.params.pageId, viewerClass: 'guest', dedupKey: req.guest?.anonId ?? `g:${req.guest?.shareLinkId ?? ''}` },
    ).catch(() => {})
    return reply.code(204).send()
  })

  // #688 slice 2: GET /pages/:pageId/analytics (the who-viewed dashboard) moved with the feature
  // into @wikistead-ee/server (analyticsEeMount). The view SIGNAL above stays: existence-hiding and
  // the guest config belong with the pages surface, and the event crosses the seam raw.

  // #230: backlinks for a page (member or view-guest). Each returned page is FGA-view-gated for the
  // caller, so this leaks no reference from a page the viewer cannot see.
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/backlinks', { config: { guest: 'view' } }, async (req) => {
    const { subject, context } = principalForPage(req, req.params.pageId)
    return getBacklinks(req.db, app.fga, { pageId: req.params.pageId, subject, context })
  })

  // #322 / ADR-133 §2/§3: 2-hop RELATED pages for the "Related" panel. MEMBER-ONLY — the route deliberately
  // omits `config.guest`, so a share_link token is rejected (§3: the public reader gets Related in a later
  // increment; the member API is never on an anonymous surface). getRelatedPages view-gates the target and
  // view-filters BOTH endpoints of every candidate edge, so no unviewable page/title leaks. Lazy-fetched by
  // the panel when the Related section opens.
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/related', async (req) => {
    const { subject, context } = principalForPage(req, req.params.pageId)
    return getRelatedPages(req.db, app.fga, { pageId: req.params.pageId, subject, context })
  })

  // #394 / ADR-147: the local link graph around a page (mini graph depth=1 / modal depth=2). MEMBER-ONLY —
  // the route deliberately omits `config.guest`, so a share_link token is rejected (a public graph over
  // public pages is a later increment, ADR-133 §6). getLocalGraph view-gates the center and returns an edge
  // only when the caller can view BOTH endpoints; an unviewable page is absent as a node entirely.
  // #399 / ADR-158 §1: the PAGE-level comment-audience override. The model has supported direct
  // `page#comment_open` wildcard tuples since #100/#244 (`[user:*, share_link:*] or comment_open from
  // space`) — this ships the missing write path, mirroring the space switch (setSpaceCommentOpen):
  // manage-gated, each wildcard toggled INDEPENDENTLY and idempotently (members = user:*, guests =
  // share_link:* — deliberately NOT a #244 always-together pair; "members only" IS the lone-user:*
  // state). ADDITIVE semantics recorded honestly: a page can OPEN comments its space keeps closed,
  // never close below the space (monotonic union; subtractive override = a deny-shaped model change,
  // out of scope per ADR-029's deferral).
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/comment-audience', async (req) => {
    await requireVerb(app.fga, req.user.sub, req.params.pageId, 'share') // #420 3b
    await requireNotTrashed(req.db, req.params.pageId) // Rider 2
    return readPageCommentAudience(app.fga, req.params.pageId)
  })
  app.put<{ Params: { pageId: string }; Body: { guests?: boolean; members?: boolean } }>('/pages/:pageId/comment-audience', async (req) => {
    await requireVerb(app.fga, req.user.sub, req.params.pageId, 'share') // #420 3b
    await requireNotTrashed(req.db, req.params.pageId) // Rider 2
    const cur = await readPageCommentAudience(app.fga, req.params.pageId)
    const obj = `page:${req.params.pageId}`
    const writes: { user: string; relation: string; object: string }[] = []
    const deletes: { user: string; relation: string; object: string }[] = []
    const apply = (want: boolean | undefined, have: boolean, user: string) => {
      if (want === undefined || want === have) return
      ;(want ? writes : deletes).push({ user, relation: 'comment_open', object: obj })
    }
    apply(req.body?.guests, cur.guests, 'share_link:*')
    apply(req.body?.members, cur.members, 'user:*')
    if (deletes.length) await deleteTuples(app.fga, deletes)
    if (writes.length) await writeTuples(app.fga, writes)
    return { guests: req.body?.guests ?? cur.guests, members: req.body?.members ?? cur.members }
  })

  // #416 / ADR-161: member typeahead for the PAGE permissions dialog. Gate = page#manage — byte-for-byte
  // the authority that can already grant on this page (grantPageAccess), so the picker widens WHO can
  // enumerate members only to principals who could act on the result anyway (the reviewed ruling). Same
  // projection + empty-query pin as the space endpoint via the shared core. Member-only (no guest config).
  app.get<{ Params: { pageId: string }; Querystring: { q?: string } }>('/pages/:pageId/member-candidates', async (req) => {
    await requireVerb(app.fga, req.user.sub, req.params.pageId, 'share') // #420 3b
    await requireNotTrashed(req.db, req.params.pageId) // Rider 2
    return searchMemberCandidates(req.db, req.query.q ?? '')
  })

  app.get<{ Params: { pageId: string }; Querystring: { depth?: string } }>('/pages/:pageId/graph', async (req) => {
    const { subject, context } = principalForPage(req, req.params.pageId)
    // #440 / ADR-166: depth 1..3, server-clamped — an out-of-range or garbage value normalizes
    // (4+ → 3, non-numeric/0 → 1), never a 500 (4+ hops = the space-wide graph, ADR-147 §③b).
    const parsed = Number.parseInt(req.query.depth ?? '1', 10)
    const depth = (Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 3) : 1) as GraphDepth
    return getLocalGraph(req.db, app.fga, { pageId: req.params.pageId, depth, subject, context })
  })

  // #370 / ADR-145: resolve a member-live `:::tagged` / `:::children` list. MEMBER-ONLY — the route
  // deliberately omits `config.guest`, so a share_link token is rejected (a guest never triggers a live
  // reverse-lookup, the ADR-134 Hole A discipline; the anonymous/public surface renders the static snapshot
  // instead). An unknown directive name returns an empty list (never an error — the client passes the raw
  // directive through). getListResults view-gates the host page and view-filters every result.
  app.get<{ Params: { pageId: string }; Querystring: { name?: string; body?: string } }>('/pages/:pageId/list', async (req) => {
    const name = req.query.name
    if (name !== 'tagged' && name !== 'children') return [] as Backlink[]
    const { subject, context } = principalForPage(req, req.params.pageId)
    return getListResults(req.db, app.fga, { pageId: req.params.pageId, name, body: req.query.body ?? '', subject, context })
  })

  // #413 / ADR-145 §5: viewer-scoped tag suggestions. MEMBER-ONLY (no guest config) — a tag name is itself
  // page content, so getSuggestedTags offers a tag only when the caller can view ≥1 page carrying it.
  app.get<{ Querystring: { q?: string } }>('/tags/suggest', async (req) => {
    return getSuggestedTags(req.db, app.fga, { q: req.query.q ?? '', subject: `user:${req.user.sub}` })
  })

  // #224 / ADR-104: the viewer-scoped title dictionary for auto internal links. The :pageId only
  // anchors the guest token binding (a guest may fetch it for the page/space they were shared);
  // the dictionary itself is viewer-scoped (member = own view set / guest = public-only — see
  // getTitleDictionary). Nothing here is per-link display-time authz — the dictionary content IS
  // the defence (Addendum 2 point 1).
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/title-dictionary', { config: { guest: 'view' } }, async (req, reply) => {
    const { subject, context } = principalForPage(req, req.params.pageId)
    // #489 (remedy 1): the dictionary is an ENHANCEMENT (auto internal links) — it must never
    // take the app down with it. Any FGA failure here (deadline under saturation, backend down) —
    // whether in the anchor check or the dict body — DEGRADES to an empty dictionary (200, links
    // render as plain text) instead of a 500 the client would retry into a multi-second freeze.
    // Uniform for every page id → never an oracle; an empty dictionary is strictly UNDER-disclosure,
    // so the failure mode is authz-safe (fail closed on content, open on availability).
    try {
      // #489: gate on the ANCHOR page's `view` FIRST — one check. Without it, a nonexistent (or
      // non-viewable) page id still ran the FULL listObjects + confirm batch (measured: 3.2s →
      // deadline 500 for a dead id, while the batch starved every other route). A clean FALSE stays a
      // uniform 404, same floor as /published (existence-hiding).
      if (!(await check(app.fga, subject, 'view', { type: 'page', id: req.params.pageId }, context))) {
        return reply.code(404).send({ error: 'not found' })
      }
      // #534: the confirm behind this costs ~1.3s on a large space, and the client refetches every 30s.
      // Serve a few seconds of it from a per-viewer cache — keyed on tenant AND subject, because a
      // dictionary IS "what this principal may see", and dropped for the whole tenant the moment the
      // dictionary invalidation fires, so the disclosure window is no wider than the one that already
      // existed. A miss computes; nothing is ever served stale in place of a fresh answer.
      // #637 / ADR-216 §6: same shape, same fix. The dictionary IS "what this principal may see", the key
      // is tenant + subject, and a confined key's subject is its owner's.
      const cached = currentAuthzScope()?.restriction == null ? getCachedTitleDict(req.tenant.id, subject) : undefined
      if (cached) return cached
      // #534 (user ruling): a MISS answers EMPTY IMMEDIATELY (degraded — links render as plain
      // text and fill in moments later) instead of holding this request, and with it the whole
      // page-open, hostage to a multi-second confirm. Measured: the in-request compute was what made
      // a fresh page's own GETs take ~1s in the browser while the server answered curl in 11ms — the
      // cold dictionary a NEIGHBOURING surface kicked off was starving them. Under-disclosure only:
      // an empty dictionary never shows a title the viewer must not see, and navigation re-checks
      // view server-side, so nothing here is an authz gate.
      //
      // The fill runs detached, once per (tenant, subject) — single-flight — on its OWN TenantDb
      // (req.db dies with this request). It keeps the whole generation discipline: gen is read
      // before computing, and a revoke landing mid-fill makes setCachedTitleDict refuse the store
      // (fail toward slow, never toward a stale answer). On success it publishes the SAME stateless
      // dict ping the reindex path uses (client: refetch, throttled) — but through a client-only
      // publish that does NOT bump the generation, or the fill would invalidate its own work.
      // The requester-lifetime abort (#541) is deliberately NOT wired here: the fill serves
      // the next request too, so the requester navigating away must not kill it — the #541 time
      // budget inside getTitleDictionary is what bounds it now.
      if (beginTitleDictFill(req.tenant.id, subject)) {
        const tenant = req.tenant
        const log = req.log
        void (async () => {
          const bg = await acquireTenantDb(tenant)
          try {
            const gen = titleDictGeneration(tenant.id)
            const fresh = await getTitleDictionary(bg, app.fga, { subject })
            setCachedTitleDict(tenant.id, subject, fresh, Date.now(), gen)
            // liveness only — the client's 30s staleTime refetch is the backstop
            // The payload is ignored by the collab fan-out (it broadcasts a stateless
            // "dict-invalidate" with no page id — existence-hiding on the wire); the marker only
            // lets tests tell a fill ping from a reindex ping.
            void app.valkey.publish(`${DICT_CHANNEL_PREFIX}${tenant.id}`, JSON.stringify({ filled: true })).catch(() => {})
          } catch (e) {
            log.warn({ err: e }, 'title-dictionary background fill failed; next miss retries')
          } finally {
            endTitleDictFill(tenant.id, subject)
            await bg.release()
          }
        })()
      }
      return { entries: [], capped: false, degraded: true }
    } catch (e) {
      req.log.warn({ err: e, pageId: req.params.pageId }, 'title-dictionary degraded: authz backend unavailable')
      return { entries: [], capped: false, degraded: true }
    }
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
    const ids = [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.length > 0))]
    // #762: OVER THE CAP IS A REFUSAL, not a shorter answer.
    //
    // The response is the set of ids the caller MAY VIEW, so an id that is absent from it was denied —
    // and an id the route never looked at is absent in exactly the same way. Nothing in the body
    // separates them. The editor reads absence as "dead link", so a document with more than the cap
    // used to strike through live links past that point: the truncation was invisible to the only
    // caller that could have compensated for it.
    //
    // ADR-117 ruled that an over-cap request must not do unbounded work ("capped/paged"), and left the
    // ANSWER open; the 200 was an implementation detail nobody chose. Refusing is the reading that
    // cannot lie — and the editor already degrades a non-200 to "unknown", which leaves every link
    // alive rather than inventing dead ones. The cap itself (256, the number ADR-117 fixed) is
    // unchanged, and so is the promise that the store never sees more than that.
    if (ids.length > MAX_LINK_STATUS_IDS) {
      return reply.code(400).send({ error: `too many ids: ${ids.length} (max ${MAX_LINK_STATUS_IDS})`, code: 'too_many_ids' })
    }
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

  // #970 / ADR-267 §3.1: is THIS specific, already-allowlisted URL actually frameable? A header-only
  // probe (X-Frame-Options / CSP frame-ancestors) of a URL the client would otherwise iframe — same
  // page-view gate + provider allowlist + SSRF guard as /embed above (checkFrameability), so the SSRF
  // population is identical; the difference is this never reads a body. Member or view-guest.
  app.get<{ Params: { pageId: string }; Querystring: { url?: string } }>('/pages/:pageId/embed/frameability', { config: { guest: 'view' } }, async (req, reply) => {
    const { subject, context } = principalForPage(req, req.params.pageId)
    const url = req.query?.url
    if (!url) return reply.code(400).send({ error: 'url is required' })
    const [row] = await req.db.sql<{ embed_providers: string[] }[]>`SELECT embed_providers FROM tenant_settings WHERE tenant_id = ${req.tenant.id}`
    try {
      const { verdict } = await checkFrameability({ fga: app.fga }, { principal: subject, pageId: req.params.pageId, url, allowlist: row?.embed_providers ?? [], context })
      return { verdict }
    } catch (e) {
      if (e instanceof EmbedFrameabilityDeniedError || (e as { statusCode?: number })?.statusCode === 403) {
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
    // #525 distinguish the failure modes so the client can match mermaid — an INVALID diagram
    // gets a visible error, while an unconfigured endpoint stays a silent degrade-to-source (the
    // operator simply has not opted in) and a transient outage is its own, retryable case.
    const r = await renderPlantumlResult(source, { dark: req.body?.theme === 'dark' }) // #342: dark → built-in !theme
    if (r.kind === 'unconfigured') return reply.code(204).send() // degrade: caller renders the source fence
    if (r.kind === 'invalid') return reply.code(422).send({ error: 'invalid diagram', reason: 'invalid_diagram' })
    if (r.kind === 'unavailable') return reply.code(503).send({ error: 'renderer unavailable', reason: 'renderer_unavailable' })
    return reply.header('content-type', 'image/png').send(r.png)
  })

  // ── per-page access (manage-gated; member-only, no guest config) ──────────
  app.get<{ Params: { pageId: string }; Querystring: { cursor?: string } }>('/pages/:pageId/access', async (req) => {
    return listPageAccess(app.fga, req.db, {
      pageId: req.params.pageId, tenantId: req.tenant.id, userId: req.user.sub,
      ...(req.query?.cursor ? { cursor: req.query.cursor } : {}),
    })
  })

  // grantee = user:<sub> | group:<id>#member (raw), OR groupName (#163: server resolves to
  // group:<id>#member via groupGrantee → matches #111's sync id exactly).
  app.post<{ Params: { pageId: string }; Body: { grantee?: string; groupName?: string; relation: string } }>('/pages/:pageId/access', async (req, reply) => {
    const grantee = req.body?.groupName ? groupGrantee(req.tenant.id, req.body.groupName) : (req.body?.grantee ?? '')
    await assertGranteeIsMember(req.db, grantee) // #624
    await grantPageAccess(req.db, app.fga, app.searchDriver, {
      pageId: req.params.pageId, tenantId: req.tenant.id, userId: req.user.sub,
      grantee, relation: req.body?.relation ?? '', plan: req.tenant.plan,
    })
    return reply.code(204).send()
  })

  app.delete<{ Params: { pageId: string }; Body: { grantee?: string; groupName?: string; relation: string } }>('/pages/:pageId/access', async (req, reply) => {
    const grantee = req.body?.groupName ? groupGrantee(req.tenant.id, req.body.groupName) : (req.body?.grantee ?? '')
    try {
      const r = await revokePageAccess(req.db, app.fga, app.searchDriver, {
        pageId: req.params.pageId, tenantId: req.tenant.id, userId: req.user.sub,
        grantee, relation: req.body?.relation ?? '', plan: req.tenant.plan,
      })
      // #596: 200 with the honesty payload — `stillCovered` names what keeps granting the capability
      // after this removal, so the client can say so instead of implying the access is gone.
      return reply.code(200).send({ removed: true, stillCovered: r.stillCovered })
    } catch (e) {
      // #596: Fastify's default error shape drops custom props — send `coveredBy` explicitly so the
      // dialog can name the covering assignment in the refusal.
      const err = e as { statusCode?: number; code?: string; coveredBy?: string[]; message?: string }
      if (err.statusCode === 409 && err.code === 'still_covered') {
        return reply.code(409).send({ error: err.message, code: 'still_covered', coveredBy: err.coveredBy ?? [] })
      }
      throw e
    }
  })

  // #109 / ADR-072 monotonic deny — restrict/unrestrict a principal from a page (manage-gated). The
  // deny list is distinct from the grant list; a restricted principal 404s on the page even as a
  // space viewer. principal = user:<sub> | group:<id>#member (raw) OR groupName (#163 resolved).
  app.get<{ Params: { pageId: string }; Querystring: { cursor?: string } }>('/pages/:pageId/restrict', async (req) => {
    return listPageRestrictions(req.db, app.fga, {
      pageId: req.params.pageId, userId: req.user.sub, ...(req.query?.cursor ? { cursor: req.query.cursor } : {}),
    })
  })
  app.post<{ Params: { pageId: string }; Body: { principal?: string; groupName?: string } }>('/pages/:pageId/restrict', async (req, reply) => {
    const principal = req.body?.groupName ? groupGrantee(req.tenant.id, req.body.groupName) : (req.body?.principal ?? '')
    // #624: a restriction names somebody too — subtracting a stranger writes permanent litter.
    await assertGranteeIsMember(req.db, principal)
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
    return { private: await isPagePrivate(req.db, app.fga, { pageId: req.params.pageId, userId: req.user.sub }) }
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
  // #329 / ADR-139 — page FREEZE toggle (manage-gated inside setPageFrozen/unsetPageFrozen). POST freezes
  // at a level ('full' = everyone below manage loses edit; 'guests' = share-link guests only); DELETE
  // unfreezes (clears both markers). The current level rides on GET /pages/:pageId (`frozen`), so no GET
  // here — the badge and the dialog read the page payload.
  app.post<{ Params: { pageId: string }; Body: { level?: string } }>('/pages/:pageId/freeze', async (req, reply) => {
    const level = req.body?.level
    if (level !== 'full' && level !== 'guests') return reply.code(400).send({ error: "level must be 'full' or 'guests'" })
    await setPageFrozen(req.db, app.fga, {
      pageId: req.params.pageId, tenantId: req.tenant.id, userId: req.user.sub, level, plan: req.tenant.plan,
    })
    return reply.code(204).send()
  })
  app.delete<{ Params: { pageId: string } }>('/pages/:pageId/freeze', async (req, reply) => {
    await unsetPageFrozen(req.db, app.fga, {
      pageId: req.params.pageId, tenantId: req.tenant.id, userId: req.user.sub, plan: req.tenant.plan,
    })
    return reply.code(204).send()
  })
  // #253 / ADR-113: per-page anonymous public toggle. GET = current state (manage-gated). POST makes it
  // public — but ONLY while the tenant parent switch is ON (guardrail 1: OFF ⇒ 403, a second layer over the
  // hidden UI so the API is the fortress). DELETE (make non-public) is always allowed — revoking is safe.
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/public', async (req) => {
    // `public` = this page's OWN grant (the toggle's state). #253 review: also report `effectivePublic` —
    // whether an anonymous reader can actually reach the page (its own grant OR via a PUBLIC SPACE), so the
    // UI can warn "publicly reachable via space" when the own toggle reads OFF but the page is world-readable.
    const own = await isPagePublic(req.db, app.fga, { pageId: req.params.pageId, userId: req.user.sub })
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

  // #437 / ADR-167: the tenant delete-mode knob (admin-gated, the old creation-policy shape — that
  // knob itself moved to tenant-role capabilities, #445/ADR-171). It selects deletion PATHWAYS
  // only — who may delete stays the delete verb / manage superset in every mode.
  app.get('/admin/delete-mode', async (req) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    const [row] = await req.db.sql<[{ delete_mode: string }?]>`SELECT delete_mode FROM tenant_settings LIMIT 1`
    return { deleteMode: row?.delete_mode ?? 'trash_only' }
  })
  app.put<{ Body: { deleteMode?: string } }>('/admin/delete-mode', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    const v = req.body?.deleteMode
    if (!v || !(DELETE_MODES as readonly string[]).includes(v)) {
      return reply.code(400).send({ error: "deleteMode ('trash_only' | 'both' | 'direct_only') required" })
    }
    await req.db.sql`
      INSERT INTO tenant_settings (tenant_id, delete_mode) VALUES (${req.tenant.id}, ${v})
      ON CONFLICT (tenant_id) DO UPDATE SET delete_mode = ${v}, updated_at = now()`
    return { deleteMode: v }
  })
}
