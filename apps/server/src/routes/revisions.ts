import * as Y from 'yjs'
import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import type IORedis from 'ioredis'
import { check } from '@wikistead/authz'
import { resolveEntitlements } from '@wikistead/entitlements'
import { emit } from '@wikistead/events'
import { pool } from '../db/pool.js'
import type { TenantDb } from '../db/index.js'

interface RevisionRow {
  id: string; tenant_id: string; page_id: string
  title: string; created_by: string | null; created_at: Date
}
export interface RevisionSummary {
  id: string; pageId: string; title: string; createdBy: string | null; createdAt: Date
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
  const currentDoc = new Y.Doc()
  Y.applyUpdate(currentDoc, new Uint8Array(current))
  const currentSV = Y.encodeStateVector(currentDoc)

  const snapDoc = new Y.Doc()
  Y.applyUpdate(snapDoc, new Uint8Array(snapshot))
  const snapText = snapDoc.getText('content').toString()

  // Build restore operations on top of current state
  const restoreDoc = new Y.Doc()
  Y.applyUpdate(restoreDoc, new Uint8Array(current))
  const t = restoreDoc.getText('content')
  t.delete(0, t.length)
  t.insert(0, snapText)

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

export async function listRevisions(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { pageId: string; userId: string; plan: string },
): Promise<RevisionSummary[]> {
  const canView = await check(fga, `user:${args.userId}`, 'view', { type: 'page', id: args.pageId })
  if (!canView) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  // Plan-gated retention: free tiers only expose recent history.
  const rows = await db.sql<RevisionRow[]>`
    SELECT id, tenant_id, page_id, title, created_by, created_at
    FROM revisions WHERE page_id = ${args.pageId} AND created_at >= ${retentionCutoff(args.plan)}
    ORDER BY created_at DESC
  `
  return rows.map(r => ({ id: r.id, pageId: r.page_id, title: r.title, createdBy: r.created_by, createdAt: r.created_at }))
}

// Restore a page to a specific revision.
//
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
  args: { tenantId: string; pageId: string; revId: string; userId: string; plan: string },
): Promise<{ documentName: string }> {
  const canEdit = await check(fga, `user:${args.userId}`, 'edit', { type: 'page', id: args.pageId })
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  // Load current ydoc and target revision from DB
  const [current] = await db.sql<[{ ydoc: Buffer | null; title: string }]>`
    SELECT ydoc, title FROM pages WHERE id = ${args.pageId}
  `
  if (!current) throw Object.assign(new Error('not found'), { statusCode: 404 })

  // Plan-gated retention: a revision outside the window is not restorable (and is
  // reported as not found, matching what listRevisions exposes).
  const [rev] = await db.sql<[{ ydoc: Buffer; tenant_id: string }]>`
    SELECT ydoc, tenant_id FROM revisions
    WHERE id = ${args.revId} AND page_id = ${args.pageId} AND created_at >= ${retentionCutoff(args.plan)}
  `
  if (!rev) throw Object.assign(new Error('revision not found'), { statusCode: 404 })

  if (!current.ydoc) throw Object.assign(new Error('no saved ydoc for this page'), { statusCode: 409 })

  const restoreUpdate = computeRestoreUpdate(current.ydoc, rev.ydoc)

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

  // Write new state + always-insert revision so the restored state is immediately
  // visible in history and undoable, AND repoint published_* to it.
  await pool.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${args.tenantId}, true)`
    const [newRev] = await tx<[{ id: string }]>`
      INSERT INTO revisions (tenant_id, page_id, ydoc, title, created_by)
      VALUES (${args.tenantId}, ${args.pageId}, ${newYdoc}, ${current.title}, ${`user:${args.userId}`})
      RETURNING id
    `
    await tx`
      UPDATE pages SET ydoc = ${newYdoc}, updated_at = now(),
        published_md = ${restoredMd}, published_revision_id = ${newRev.id}, published_at = now()
      WHERE id = ${args.pageId}
    `
    await tx`
      INSERT INTO search_outbox (tenant_id, page_id, operation)
      VALUES (${args.tenantId}, ${args.pageId}, 'upsert')
    `
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

// ── Fastify plugin ────────────────────────────────────────────────────────

export async function revisionsPlugin(app: FastifyInstance) {
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/revisions', async (req) => {
    return listRevisions(req.db, app.fga, { pageId: req.params.pageId, userId: req.user.sub, plan: req.tenant.plan })
  })

  app.post<{ Params: { pageId: string; revId: string } }>(
    '/pages/:pageId/revisions/:revId/restore',
    async (req, reply) => {
      await restoreRevision(req.db, app.fga, app.valkey, {
        tenantId: req.tenant.id,
        pageId: req.params.pageId,
        revId: req.params.revId,
        userId: req.user.sub,
        plan: req.tenant.plan,
      })
      return reply.code(204).send()
    },
  )
}
