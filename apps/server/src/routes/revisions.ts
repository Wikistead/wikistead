import * as Y from 'yjs'
import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import type IORedis from 'ioredis'
import { check } from '@wikistead/authz'
import { resolveEntitlements } from '@wikistead/entitlements'
import { emit } from '@wikistead/events'
import type { Sql } from 'postgres'
import { withTenantTx } from '../db/index.js' // #382
import { fanOutFeedEvent } from './notifications.js' // #327 / ADR-143: reliable in-tx restore feed event
import type { TenantDb } from '../db/index.js'
import type { StorageDriver } from '../storage/index.js'
import { resolveAuthorIdentities, authorFields } from '../author-identity.js' // #486 / ADR-150 Addendum 2
import { storeRevisionYdoc, readRevisionYdoc } from './revision-ydoc.js'
import { reconcileTaskChecks, requireModerate } from './pages.js' // #316 checkbox reconciliation; #330 the moderation gate

interface RevisionRow {
  id: string; tenant_id: string; page_id: string
  title: string; created_by: string | null; created_at: Date
}
export interface RevisionSummary {
  id: string; pageId: string; title: string; createdBy: string | null; createdAt: Date
  // #486 / ADR-150 Addendum 2: author display name/avatar resolved on this view-gated history response.
  createdByName?: string | null; createdByHasAvatar?: boolean
}

// ── computeRestoreUpdate ────────────────────────────────────────────────────
//
// Produces a Y.Doc update that, when applied to the current doc, makes its
// Y.Text content match the snapshot content.
//
// Implementation: delete all current characters (recorded as tombstones) then
// insert snapshot characters as new operations. This is append-only and CRDT-safe:
// no existing updates are modified, and connected clients can apply the delta.
//
// TODO(phase: revisions): each restore tombstones all current Y.Text characters.
// Yjs retains tombstones permanently, so repeated restores grow pages.ydoc.
// Consider Y.Doc GC (Y.applyUpdate with gc=true) or compaction for high-frequency use.
export function computeRestoreUpdate(current: Buffer, snapshot: Buffer): Uint8Array {
  const snapDoc = new Y.Doc()
  Y.applyUpdate(snapDoc, new Uint8Array(snapshot))
  return computeRestoreUpdateToText(current, snapDoc.getText('content').toString())
}

// The same delete+insert delta, but targeting an already-decoded body TEXT — so the caller can transform
// the snapshot text (e.g. #316 checkbox reconciliation) before building the restore update.
export function computeRestoreUpdateToText(current: Buffer, targetText: string): Uint8Array {
  const currentDoc = new Y.Doc()
  Y.applyUpdate(currentDoc, new Uint8Array(current))
  const currentSV = Y.encodeStateVector(currentDoc)

  // Build restore operations on top of current state
  const restoreDoc = new Y.Doc()
  Y.applyUpdate(restoreDoc, new Uint8Array(current))
  const t = restoreDoc.getText('content')
  t.delete(0, t.length)
  t.insert(0, targetText)

  // Return only the delta (operations added since currentDoc state)
  return Y.encodeStateAsUpdate(restoreDoc, currentSV)
}

// ── Service functions ─────────────────────────────────────────────────────

// History retention cutoff for a plan: revisions older than this are hidden and
// not restorable on that plan. Infinity retention => epoch (everything visible).
function retentionCutoff(plan: string): Date {
  const days = resolveEntitlements(plan).historyRetentionDays
  return isFinite(days) ? new Date(Date.now() - days * 86_400_000) : new Date(0)
}

/** #623: how many revisions one response may carry. */
export const REVISIONS_PAGE_LIMIT = 100

export interface RevisionsPage { revisions: RevisionSummary[]; nextCursor: string | null }

export async function listRevisions(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; userId: string; plan: string; limit?: number; cursor?: string },
): Promise<RevisionsPage> {
  const canView = await check(fga, `user:${args.userId}`, 'view', { type: 'page', id: args.pageId })
  if (!canView) throw Object.assign(new Error('not found'), { statusCode: 404 }) // #262: existence-hiding on the read path (history is a display of the page)

  // #623: one row per published version, and a long-lived page has hundreds. The whole history used to
  // arrive in one response.
  //
  // The cursor's timestamp travels as an EPOCH rather than a formatted date, for the reason measured on
  // `/spaces` and again on `/members`: a parameter carrying microseconds comes back out of ::timestamptz
  // rounded to milliseconds, because the driver parses it into a JS Date on the way in. This list walks
  // DESC, which is the direction that SKIPS rather than repeats — a revision between the truncated
  // instant and the true one appears on no page at all, and a missing version in a history nobody can
  // see the end of is not something a reader can notice.
  //
  // `id` joins the ORDER BY as the tiebreaker: a restore writes a fresh revision, and a bulk revert can
  // stamp two in the same instant.
  const limit = Math.min(500, Math.max(1, args.limit ?? REVISIONS_PAGE_LIMIT))
  const bar = args.cursor?.indexOf('|') ?? -1
  const after = args.cursor && bar > 0 ? { at: args.cursor.slice(0, bar), id: args.cursor.slice(bar + 1) } : null
  // Plan-gated retention: free tiers only expose recent history.
  const rows = await db.sql<(RevisionRow & { cursor_at: string })[]>`
    SELECT id, tenant_id, page_id, title, created_by, created_at,
           extract(epoch from created_at)::text AS cursor_at
    FROM revisions WHERE page_id = ${args.pageId} AND created_at >= ${retentionCutoff(args.plan)}
      ${after ? db.sql`AND (created_at, id) < (to_timestamp(${after.at}::numeric), ${after.id})` : db.sql``}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `
  // #486 / ADR-150 Addendum 2: resolve the revision author names AFTER the view gate, on the caller's
  // RLS handle (cross-tenant → null), over the surviving rows only. override ?? OIDC name; guest dropped.
  // NOTE: unlike page-meta/comments (bare sub), a revision's created_by is the FGA-principal form
  // `user:<sub>` (or guest:/anon:) — strip the `user:` prefix so it matches members.sub.
  const bareSub = (s: string | null): string | null => (s == null ? null : s.startsWith('user:') ? s.slice(5) : s)
  // one row past the limit answers "is there more" without a second count query, and it is dropped
  // BEFORE the author resolution below so an over-fetched row never costs a name lookup.
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  const authorIds = await resolveAuthorIdentities(db, page.map(r => bareSub(r.created_by)).filter((s): s is string => s != null))
  return {
    revisions: page.map(r => {
      const by = authorFields(authorIds, bareSub(r.created_by))
      return { id: r.id, pageId: r.page_id, title: r.title, createdBy: r.created_by, createdByName: by.name, createdByHasAvatar: by.hasAvatar, createdAt: r.created_at }
    }),
    nextCursor: hasMore && last ? `${last.cursor_at}|${last.id}` : null,
  }
}

/**
 * The whole history, by walking the pages.
 *
 * For callers that genuinely need every revision — the tests, and any reader that has to reason about
 * the list as a whole. It exists so the walk is written ONCE: the loop condition is `nextCursor`, never
 * "the page came back empty".
 */
export async function listAllRevisions(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; userId: string; plan: string },
): Promise<RevisionSummary[]> {
  const out: RevisionSummary[] = []
  let cursor: string | undefined
  do {
    const page: RevisionsPage = await listRevisions(db, fga, { ...args, ...(cursor ? { cursor } : {}) })
    out.push(...page.revisions)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return out
}

// #109 / ADR-072: does this page have revisions HIDDEN by the plan's history-retention window?
// An entitlement loss (short retention) must be disclosed as "older history hidden — upgrade to
// see the full timeline" (the data is kept, not deleted), NOT silently omitted (which reads as
// "no history" = data-loss). The list route surfaces this so the UI can show the upgrade
// affordance. Unlimited retention → nothing is ever hidden.
export async function hasHiddenRevisions(db: TenantDb, args: { pageId: string; plan: string }): Promise<boolean> {
  if (!isFinite(resolveEntitlements(args.plan).historyRetentionDays)) return false
  const [row] = await db.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM revisions
    WHERE page_id = ${args.pageId} AND created_at < ${retentionCutoff(args.plan)}
  `
  return (row?.n ?? 0) > 0
}

// Restore a page to a specific revision.
//
// Decoded Markdown body of one revision snapshot (Design-5 diff). view-gated like the
// list; retention-gated so an out-of-window revision is "not found" (matches listRevisions).
// Returns plain text — the client diffs it against the current published snapshot
// (hand-rolled line LCS, ADR-019 D6); checkbox `[x]`/`[ ]` changes appear as line diffs.
export async function getRevisionContent(
  db: TenantDb,
  fga: OpenFgaClient,
  storage: StorageDriver,
  args: { pageId: string; revId: string; userId: string; plan: string },
): Promise<{ content: string }> {
  const canView = await check(fga, `user:${args.userId}`, 'view', { type: 'page', id: args.pageId })
  if (!canView) throw Object.assign(new Error('not found'), { statusCode: 404 }) // #262: existence-hiding on the read path
  const [rev] = await db.sql<[{ ydoc: Buffer | null; ydoc_key: string | null }]>`
    SELECT ydoc, ydoc_key FROM revisions
    WHERE id = ${args.revId} AND page_id = ${args.pageId} AND created_at >= ${retentionCutoff(args.plan)}
  `
  if (!rev) throw Object.assign(new Error('revision not found'), { statusCode: 404 })
  const bytes = await readRevisionYdoc(storage, rev) // dual-read (ydoc_key ?? inline), LOUD if dangling
  const doc = new Y.Doc()
  Y.applyUpdate(doc, bytes)
  return { content: doc.getText('content').toString() }
}

// CRDT-safe: computes a delete+insert update on top of current state.
// Does NOT overwrite in-place; appends new operations so connected clients
// can apply the delta without losing concurrent edits.
//
// Write order and correctness guarantee:
//   1. pages.ydoc updated in DB (withTenant → RLS-scoped) — THIS IS CORRECTNESS.
//      Even if step 2 fails, clients get the restored state on next reconnect.
//   2. Revision inserted (always, so the restore is immediately undoable).
//   3. search_outbox enqueued (reindex body).
//   4. Valkey publish — PERFORMANCE ONLY (immediate propagation to live clients).
//      If publish fails or no subscriber, the Valkey message is lost, but
//      pages.ydoc already holds the truth. Same positioning as Meili=performance/FGA=safety.
export async function restoreRevision(
  db: TenantDb,
  fga: OpenFgaClient,
  valkey: IORedis,
  storage: StorageDriver,
  args: { tenantId: string; pageId: string; revId: string; userId: string; plan: string },
): Promise<{ documentName: string }> {
  const canEdit = await check(fga, `user:${args.userId}`, 'edit', { type: 'page', id: args.pageId })
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  // Load current ydoc and target revision from DB (space_id → the #327 restore feed event fan-out below).
  const [current] = await db.sql<[{ ydoc: Buffer | null; title: string; space_id: string }]>`
    SELECT ydoc, title, space_id FROM pages WHERE id = ${args.pageId}
  `
  if (!current) throw Object.assign(new Error('not found'), { statusCode: 404 })

  // Plan-gated retention: a revision outside the window is not restorable (and is
  // reported as not found, matching what listRevisions exposes).
  const [rev] = await db.sql<[{ ydoc: Buffer | null; ydoc_key: string | null; tenant_id: string }]>`
    SELECT ydoc, ydoc_key, tenant_id FROM revisions
    WHERE id = ${args.revId} AND page_id = ${args.pageId} AND created_at >= ${retentionCutoff(args.plan)}
  `
  if (!rev) throw Object.assign(new Error('revision not found'), { statusCode: 404 })

  if (!current.ydoc) throw Object.assign(new Error('no saved ydoc for this page'), { statusCode: 409 })

  const revBytes = await readRevisionYdoc(storage, rev) // dual-read of the target revision
  // #316 / ADR-123: restoring the BODY must not silently revert live task progress. Reconcile the target
  // revision's checkbox states against the CURRENT ones: unchanged task composition → keep the current
  // checked/unchecked (overlaid onto the restored prose); added/removed/reordered tasks → the revision's
  // own snapshot states stand. Checkbox state stays inline in the markdown (no new store), so the restore
  // writes it to BOTH pages.ydoc (draft) and published_md below — one consistent write (no #303 dirty skew).
  const snapDoc = new Y.Doc(); Y.applyUpdate(snapDoc, new Uint8Array(revBytes))
  const currentDoc0 = new Y.Doc(); Y.applyUpdate(currentDoc0, new Uint8Array(current.ydoc))
  const reconciledText = reconcileTaskChecks(currentDoc0.getText('content').toString(), snapDoc.getText('content').toString())
  const restoreUpdate = computeRestoreUpdateToText(current.ydoc, reconciledText)

  // Apply restore update to get new full state
  const restoredDoc = new Y.Doc()
  Y.applyUpdate(restoredDoc, new Uint8Array(current.ydoc))
  Y.applyUpdate(restoredDoc, restoreUpdate)
  const newYdoc = Buffer.from(Y.encodeStateAsUpdate(restoredDoc))
  // Restore = RE-PUBLISH (draft/publish model): the restored content becomes the
  // current PUBLISHED version too, not just the draft — otherwise viewers would
  // still see the old published version after a restore. published_md is the
  // restored body text; the freshly-inserted revision is the new published pointer.
  const restoredMd = restoredDoc.getText('content').toString()

  // Offload the new revision bytes to storage S3-FIRST (ADR-062): if the put fails we throw
  // here and never write a row → no dangling pointer (the new pages.ydoc below is unaffected).
  const newRevKey = await storeRevisionYdoc(storage, args.tenantId, newYdoc)

  // Write new state + always-insert revision so the restored state is immediately
  // visible in history and undoable, AND repoint published_* to it.
  await withTenantTx(args.tenantId, async (tx) => {
    const [newRev] = await tx<[{ id: string }]>`
      INSERT INTO revisions (tenant_id, page_id, ydoc_key, title, created_by)
      VALUES (${args.tenantId}, ${args.pageId}, ${newRevKey}, ${current.title}, ${`user:${args.userId}`})
      RETURNING id
    `
    await tx`
      UPDATE pages SET ydoc = ${newYdoc}, updated_at = now(),
        published_md = ${restoredMd}, published_revision_id = ${newRev.id}, published_at = now(),
        has_unpublished_changes = false
      WHERE id = ${args.pageId}
    `
    await tx`
      INSERT INTO search_outbox (tenant_id, page_id, operation)
      VALUES (${args.tenantId}, ${args.pageId}, 'upsert')
    `
    // #327 / ADR-143 (C-2 increment 1): fan the restore out to watchers IN this tx (reliable — a commit-then-
    // crash still delivers, matching #320 publish), replacing the old fire-and-forget emit-only path. A restore
    // re-publishes (published_at just set above), so the §2 published guard passes. Actor is the member (restore
    // is member-only). The feed groups vandal runs by actor (C-6 anon id / user sub) for one-click revert.
    await fanOutFeedEvent(tx as unknown as Sql, { tenantId: args.tenantId, eventType: 'page.restored', pageId: args.pageId, spaceId: current.space_id, actor: `user:${args.userId}`, publishedAt: new Date() })
  })

  // Publish restore update to Valkey for immediate propagation to live clients.
  // Position: PERFORMANCE ONLY. pages.ydoc is already updated above.
  // Failure here does not affect correctness; connected clients reconnect and
  // load the new state from pages.ydoc.
  const documentName = `t:${args.tenantId}:p:${args.pageId}`
  try {
    await valkey.publish(`wks:restore:${documentName}`, Buffer.from(restoreUpdate).toString('base64'))
  } catch (err) {
    console.error(`[restore:publish] failed for ${documentName} (non-fatal):`, err)
  }

  emit({ type: 'page.restored', tenantId: args.tenantId, pageId: args.pageId, fromRevisionId: args.revId, actorId: args.userId })
  return { documentName }
}

// #327 / ADR-143 (increment 2): per-actor bulk revert — ONE forward restore to the revision just before the
// actor's LATEST CONTIGUOUS run. Moderation-gated (moderate OR manage, #330); the restore itself reuses
// restoreRevision verbatim (forward-only append, #316 checkbox reconcile, in-tx feed event, S3-first) — a
// moderator holds `edit` via the model bypass, so the inner edit gate passes by construction.
//
// HONESTY BOUNDS (the ADR's whole point — never a silent destructive mass-revert):
//   'not-latest'  — the actor's revisions are NOT the most recent run (someone else edited after them).
//                   One click can't isolate their changes → 409; the client falls back to the plain
//                   per-revision diff + restore buttons (manual path).
//   'not-a-run'   — the latest run is a SINGLE revision (review ruling): reverting "one
//                   edit in bulk" restores whatever buried version precedes it — the exact footgun the
//                   feature removes — so 2+ contiguous revisions are required, matching the UI guard.
//   'no-baseline' — the run reaches the very first (retention-visible) revision, so there is no pre-run
//                   revision to restore to → 409, manual path.
//   'no-revisions'— nothing to revert (no visible revisions at all) → 409.
// The client precomputes the same run from the revision list it already shows; this service re-derives it
// server-side (the fortress) so a stale/forged client can never widen the revert.
export async function revertActorRun(
  db: TenantDb,
  fga: OpenFgaClient,
  valkey: IORedis,
  storage: StorageDriver,
  args: { tenantId: string; pageId: string; actor: string; userId: string; plan: string },
): Promise<{ restoredToRevisionId: string; revertedCount: number }> {
  await requireModerate(fga, args.userId, args.pageId) // #330: a moderation verb — editors never pass
  // The same retention-gated window the history list exposes: the run and its baseline must both be
  // visible on this plan (a baseline hidden by retention → 'no-baseline', matching what the UI can show).
  const revs = await db.sql<RevisionRow[]>`
    SELECT id, tenant_id, page_id, title, created_by, created_at
    FROM revisions WHERE page_id = ${args.pageId} AND created_at >= ${retentionCutoff(args.plan)}
    ORDER BY created_at DESC
  `
  if (revs.length === 0) throw Object.assign(new Error('no revisions to revert'), { statusCode: 409, reason: 'no-revisions' })
  if (revs[0]!.created_by !== args.actor) {
    throw Object.assign(new Error("the actor's revisions are not the latest run"), { statusCode: 409, reason: 'not-latest' })
  }
  let runLen = 0
  while (runLen < revs.length && revs[runLen]!.created_by === args.actor) runLen++
  //(#327 review ruling): a single revision is NOT a run — the endpoint contract matches the
  // UI guard (bulk revert exists for 2+ contiguous revisions only), so a hand-crafted API call can't turn
  // one edit into a "bulk" revert that restores whatever buried version lies beneath it.
  if (runLen < 2) throw Object.assign(new Error('a single revision is not a run'), { statusCode: 409, reason: 'not-a-run' })
  const baseline = revs[runLen]
  if (!baseline) throw Object.assign(new Error('no revision precedes the run'), { statusCode: 409, reason: 'no-baseline' })
  await restoreRevision(db, fga, valkey, storage, {
    tenantId: args.tenantId, pageId: args.pageId, revId: baseline.id, userId: args.userId, plan: args.plan,
  })
  return { restoredToRevisionId: baseline.id, revertedCount: runLen }
}

// ── Fastify plugin ────────────────────────────────────────────────────────

export async function revisionsPlugin(app: FastifyInstance) {
  app.get<{ Params: { pageId: string }; Querystring: { limit?: string; cursor?: string } }>('/pages/:pageId/revisions', async (req, reply) => {
    const limit = Number.parseInt(req.query.limit ?? '', 10)
    const list = await listRevisions(req.db, app.fga, {
      pageId: req.params.pageId, userId: req.user.sub, plan: req.tenant.plan,
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
    })
    // #109/ADR-072: disclose plan-hidden history (non-destructive entitlement loss) so the UI can
    // show "upgrade to see the full timeline" rather than silently implying there is no older history.
    reply.header('X-Retention-Limited', String(await hasHiddenRevisions(req.db, { pageId: req.params.pageId, plan: req.tenant.plan })))
    return list
  })

  app.get<{ Params: { pageId: string; revId: string } }>('/pages/:pageId/revisions/:revId/content', async (req) => {
    return getRevisionContent(req.db, app.fga, app.storageDriver, { pageId: req.params.pageId, revId: req.params.revId, userId: req.user.sub, plan: req.tenant.plan })
  })

  app.post<{ Params: { pageId: string; revId: string } }>(
    '/pages/:pageId/revisions/:revId/restore',
    async (req, reply) => {
      await restoreRevision(req.db, app.fga, app.valkey, app.storageDriver, {
        tenantId: req.tenant.id,
        pageId: req.params.pageId,
        revId: req.params.revId,
        userId: req.user.sub,
        plan: req.tenant.plan,
      })
      return reply.code(204).send()
    },
  )

  // #327 / ADR-143 (increment 2): one-click per-actor revert of the latest contiguous run. MEMBER-ONLY
  // (no `config.guest` — a guest is rejected before the handler) + moderate/manage inside the service.
  // 409 carries a `reason` (not-latest / no-baseline / no-revisions) so the client routes honestly to the
  // guided manual path instead of pretending a one-click was possible.
  app.post<{ Params: { pageId: string }; Body: { actor?: string } }>(
    '/pages/:pageId/revisions/revert-actor',
    async (req, reply) => {
      const actor = req.body?.actor ?? ''
      if (!/^(user|guest|anon):[^\s]+$/.test(actor)) {
        return reply.code(400).send({ error: 'actor must be user:<sub>, guest:<id> or anon:<id>' })
      }
      try {
        return await revertActorRun(req.db, app.fga, app.valkey, app.storageDriver, {
          tenantId: req.tenant.id, pageId: req.params.pageId, actor, userId: req.user.sub, plan: req.tenant.plan,
        })
      } catch (err) {
        const e = err as { statusCode?: number; reason?: string; message?: string }
        if (e.statusCode === 409 && e.reason) return reply.code(409).send({ error: e.message, reason: e.reason })
        throw err
      }
    },
  )
}
