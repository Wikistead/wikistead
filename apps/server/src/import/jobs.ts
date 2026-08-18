// #712 / ADR-227 §7 — import as a background job, above a threshold.
//
// WHY THIS EXISTS. The synchronous import (ADR-132) is right for a vault of a few hundred notes and
// dishonest for the thousands of pages a real Confluence space carries: the client holds a connection
// for minutes, a proxy timeout throws away a COMPLETED import's report, and the compensating rollback
// runs under a request that may already be gone. §7's decision was to keep the synchronous path exactly
// as it is and add an escalation, not to rewrite one path into the other — so below the threshold
// nothing here runs, and none of the existing tests change.
//
// SUBSTRATE. The existing outbox discipline (db/outbox-lease.ts), not a new broker: a row, a claim with
// FOR UPDATE SKIP LOCKED, external work outside any transaction. The `imports` row is simultaneously the
// queue entry and the progress/report surface, which is the point — the report outlives the connection.
//
// AUTHZ. The job creates every page through `createPage` as the ENQUEUING member, exactly like the
// synchronous path, so the space `edit` gate is unchanged and is enforced per page by the same code. The
// route additionally checks `edit` BEFORE queueing: without that, a member of the tenant who cannot write
// to the space could park a 200 MiB archive in object storage and get a 202 for it.
import type { OpenFgaClient } from '@openfga/sdk'
import postgres from 'postgres'
import { runInAuthzScope, SYSTEM_SCOPE, check } from '@wikistead/authz'
import { pool } from '../db/pool.js'
import { claimOutboxBatch, startOutboxDrainWorker } from '../db/outbox-lease.js'
import { registry, acquireTenantDb } from '../db/index.js'
import type { StorageDriver } from '../storage/index.js'
import type { SearchDriver } from '../search/index.js'
import { prepareImport, runPreparedImport, type ImportReport, type PreparedImport } from './index.js'

// ADR-227 §9 answer 1 (owner ruling): 200 nodes. Deliberately a starting value measured later, not
// a law — env-overridable so a deployment that learns better does not need a release.
export const IMPORT_SYNC_MAX_NODES = Number(process.env.IMPORT_SYNC_MAX_NODES ?? 200)

// Longer than the shared 2-minute outbox window: a claim here covers a job that legitimately runs for
// many minutes. The claim is REFRESHED as pages are created (see progress below), so this window bounds
// "worker died", not "worker is slow".
const IMPORT_STALE_CLAIM = '5 minutes'
// Progress writes are throttled — a 5000-page import must not become 5000 extra UPDATEs.
const PROGRESS_WRITE_MS = 3000

export type ImportStatus = 'queued' | 'running' | 'done' | 'failed'

export interface ImportRow {
  id: string
  status: ImportStatus
  nodesTotal: number
  nodesDone: number
  report: ImportReport | null
  error: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * The space already has an import in flight.
 *
 * #712 this carries the RUNNING import's id, because without it the screen can say "an import
 * is already running" and nothing else — the status route needs an id, so the one action worth
 * offering ("show me the one that is running") could not be built. No new authorization decision
 * comes with it: only somebody with `edit` on the space can reach this error at all, which is the
 * same gate the status route applies before answering.
 */
export class ImportBusyError extends Error {
  constructor(public readonly running: { id: string; status: ImportStatus; nodesDone: number; nodesTotal: number } | null = null) {
    super('an import is already running for this space')
    this.name = 'ImportBusyError'
  }
}

function archiveKeyFor(tenantId: string, importId: string): string {
  // Server-generated, like every other key the importer writes: nothing from the archive reaches a path.
  return `imports/${tenantId}/${importId}.zip`
}

interface JobDeps { fga: OpenFgaClient; storage: StorageDriver; driver: SearchDriver }

/**
 * Stage the archive and queue the job. Returns the import id for the 202.
 *
 * The archive is written to object storage BEFORE the row, because the row is what the drain acts on and
 * a queued row with no bytes would be a job that can only fail. The reverse leak — bytes with no row,
 * possible only if the process dies in between — is one unreferenced object, the same harmless class the
 * materializer's rollback already documents, and it is never a quota or authz problem (no attachment row
 * exists, so nothing counts it and nothing serves it).
 */
export async function enqueueImportJob(
  deps: { storage: StorageDriver },
  archive: Uint8Array,
  args: { tenantId: string; spaceId: string; userId: string; parentPageId?: string | null; publish?: boolean; nodesTotal: number },
): Promise<string> {
  const [{ id }] = await pool<[{ id: string }]>`SELECT gen_random_uuid()::text AS id`
  const key = archiveKeyFor(args.tenantId, id)
  await deps.storage.putObject(key, archive, 'application/zip')
  try {
    await pool`
      INSERT INTO imports (id, tenant_id, space_id, executor_sub, parent_page_id, publish, archive_key, status, nodes_total)
      VALUES (${id}, ${args.tenantId}, ${args.spaceId}, ${args.userId}, ${args.parentPageId ?? null},
              ${args.publish === true}, ${key}, 'queued', ${args.nodesTotal})`
  } catch (e) {
    await deps.storage.deleteObject(key).catch(() => {})
    // The partial unique index (migration 124) is the one-import-per-space bound. Losing that race is a
    // 409, not a 500 — and it is decided by the database, so two simultaneous uploads cannot both win.
    if ((e as postgres.PostgresError)?.code === '23505') throw new ImportBusyError(await runningImportFor(args.tenantId, args.spaceId))
    throw e
  }
  return id
}

/**
 * The import currently occupying this space's one slot, if any.
 *
 * Read AFTER the unique-index violation rather than before the insert: asking first would be a
 * read-then-write race (two uploads could both find the slot free), and the index is what actually
 * decides. This read only explains a decision the database already made.
 *
 * Same explicit isolation as `readImport` — `imports` has no RLS — and the same statuses the index
 * treats as occupying (queued/running).
 */
async function runningImportFor(tenantId: string, spaceId: string) {
  const [row] = await pool<[{ id: string; status: ImportStatus; nodes_done: number; nodes_total: number }?]>`
    SELECT id, status, nodes_done, nodes_total FROM imports
    WHERE tenant_id = ${tenantId} AND space_id = ${spaceId} AND status IN ('queued', 'running')
    ORDER BY created_at DESC LIMIT 1`
  return row ? { id: row.id, status: row.status, nodesDone: row.nodes_done, nodesTotal: row.nodes_total } : null
}

/**
 * Read one import's status. TENANT ISOLATION IS THIS PREDICATE: `imports` carries no RLS (it is a drained
 * queue — see migration 124), so the tenant and space are matched explicitly here, and the caller checks
 * FGA `edit` on the space before calling. Returns null for "not this tenant's / not this space's / gone",
 * which the route answers as 404 — the same existence-hiding 404 the rest of the product uses.
 */
export async function readImportStatus(args: { id: string; tenantId: string; spaceId: string }): Promise<ImportRow | null> {
  const rows = await pool<{
    id: string; status: ImportStatus; nodes_total: number; nodes_done: number
    report: ImportReport | null; error: string | null; created_at: Date; updated_at: Date
  }[]>`
    SELECT id, status, nodes_total, nodes_done, report, error, created_at, updated_at
    FROM imports WHERE id = ${args.id} AND tenant_id = ${args.tenantId} AND space_id = ${args.spaceId}`
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id, status: r.status, nodesTotal: r.nodes_total, nodesDone: r.nodes_done,
    // ⚠️ MEASURED: this pool hands JSONB back as a STRING, not a parsed object. Without this the report
    // reaches the UI as a quoted blob and every `report.degraded` read is silently undefined — a
    // fidelity report that says nothing, which is the one failure mode this whole feature exists to
    // prevent. Typed as the parsed shape either way, so a caller cannot accidentally depend on the text.
    report: typeof r.report === 'string' ? (JSON.parse(r.report) as ImportReport) : r.report,
    error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

interface ClaimedRow {
  id: string; tenant_id: string; space_id: string; executor_sub: string
  parent_page_id: string | null; publish: boolean; archive_key: string | null
}

/**
 * One drain pass. Claims queued imports and runs them to completion (or to a recorded failure).
 *
 * Batch of 1 on purpose: an import is minutes of work and holds a space's slot, so there is nothing to
 * gain from interleaving two of them in one pass — the loop in startOutboxDrainWorker comes straight back
 * for the next one.
 */
export async function drainImportJobs(deps: JobDeps): Promise<number> {
  // A worker that died mid-import leaves a row saying "running" forever, which also holds the space's
  // one-import slot shut. It CANNOT be retried — pages it already created are real and re-running would
  // duplicate them — so it is settled as failed, honestly worded. This is the only place that reaps it.
  await pool`
    UPDATE imports SET status = 'failed', updated_at = now(),
      error = 'the worker stopped before this import finished; pages it had already created were kept'
    WHERE status = 'running' AND claimed_at < now() - ${IMPORT_STALE_CLAIM}::interval`

  const rows = await claimOutboxBatch<ClaimedRow>({
    table: 'imports',
    returning: ['id', 'tenant_id', 'space_id', 'executor_sub', 'parent_page_id', 'publish', 'archive_key'],
    batch: 1,
    orderBy: 'created_at',
    extraDue: pool`AND status = 'queued'`,
  })
  let handled = 0
  for (const row of rows) {
    await pool`UPDATE imports SET status = 'running', updated_at = now() WHERE id = ${row.id}`
    try {
      await runOneImport(deps, row)
    } catch (e) {
      await pool`
        UPDATE imports SET status = 'failed', error = ${e instanceof Error ? e.message : String(e)},
          archive_key = NULL, updated_at = now() WHERE id = ${row.id}`
    }
    if (row.archive_key) await deps.storage.deleteObject(row.archive_key).catch(() => {})
    handled++
  }
  return handled
}

async function runOneImport(deps: JobDeps, row: ClaimedRow): Promise<void> {
  if (!row.archive_key) throw new Error('the staged archive is missing')
  const tenant = await registry.findById(row.tenant_id)
  if (!tenant) throw new Error('tenant gone')
  const archive = await deps.storage.getObject(row.archive_key)
  // Prepared again rather than carried across the 202: the IR is derived data, and re-deriving it costs
  // one capped unzip while storing it would mean a second, larger thing to keep in agreement with itself.
  const prepared: PreparedImport = prepareImport(archive)
  // The same tenant-scoped driver the request path uses, so the job is isolation-blind exactly like the
  // synchronous import (a namespace-promoted tenant works here for free — ADR-001).
  const db = await acquireTenantDb(tenant)
  let lastWrite = 0
  try {
    const report = await runPreparedImport(
      { db, fga: deps.fga, storage: deps.storage, driver: deps.driver },
      prepared,
      {
        tenantId: row.tenant_id, spaceId: row.space_id, userId: row.executor_sub, plan: String(tenant.plan),
        parentPageId: row.parent_page_id, publish: row.publish,
        onProgress: (done) => {
          const now = Date.now()
          if (now - lastWrite < PROGRESS_WRITE_MS) return
          lastWrite = now
          // Refreshing claimed_at here is what makes IMPORT_STALE_CLAIM mean "the worker died" rather
          // than "the import is big". Fire-and-forget: progress is a courtesy, never a reason to fail.
          void pool`UPDATE imports SET nodes_done = ${done}, claimed_at = now(), updated_at = now() WHERE id = ${row.id}`
            .catch(() => {})
        },
      },
    )
    await pool`
      UPDATE imports SET status = 'done', report = ${JSON.stringify(report)}::jsonb,
        nodes_done = ${report.pagesCreated}, archive_key = NULL, updated_at = now()
      WHERE id = ${row.id}`
  } finally {
    await db.release()
  }
}

// Called from the server ENTRY (not buildApp), the #432 rule every other drain follows: tests drive
// drainImportJobs directly, THIS is what runs an import in production.
export function startImportJobWorker(deps: JobDeps, intervalMs: number): () => void {
  return startOutboxDrainWorker(() => drainImportJobs(deps), intervalMs)
}

/**
 * The enqueue-time space gate (see AUTHZ at the top of this file). Kept here beside the enqueue it
 * guards so the two cannot drift apart.
 */
export async function assertCanQueueImport(fga: OpenFgaClient, userId: string, spaceId: string): Promise<void> {
  const canEdit = await check(fga, `user:${userId}`, 'edit', { type: 'space', id: spaceId })
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
}

// Re-exported so the route does not need to know that the scope wrapper exists; a drain triggered
// inline (tests, or a future admin "run now") declares the same unrestricted scope the worker does.
export async function drainImportJobsInScope(deps: JobDeps): Promise<number> {
  return runInAuthzScope(SYSTEM_SCOPE, () => drainImportJobs(deps))
}
