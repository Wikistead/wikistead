import { deleteTuples, isAlreadyConverged } from '@wikistead/authz'
import type { OpenFgaClient } from '@openfga/sdk'
import type { Sql } from 'postgres'
import { pool } from './pool.js'
import { claimOutboxBatch, startOutboxDrainWorker } from './outbox-lease.js'

// #896 / ADR-255 Decision 5: the seventh table on the #432 lease primitive, and the only one whose
// payload is a permission-store tuple. It lives beside the lease rather than under a feature because
// the queue is the reliability mechanism; the callers are elsewhere.
//
// Why it exists: a member removal must not be blocked by the store being down (#378), so the tuple
// delete's failure is swallowed. Swallowing it used to mean forgetting it, and a forgotten tuple
// names a subject on an object whose row is gone -- which ADR-255 section 1 shows nothing can find
// afterwards, because every sweep starts from a row.
//
// Enqueue-then-delete, and that is the whole ordering: the row is written INSIDE the transaction
// that removes the member, the store call happens AFTER commit, and success deletes the row.
// Recording only what a `catch` saw would lose the crash between commit and call -- the one case a
// catch block cannot observe.

export type TupleIntent = { subject: string; relation: string; object: string }

/**
 * Record tuple deletions that must eventually happen. MUST be called with the transaction handle of
 * the write that makes them necessary: the queue row and the row removal commit together or not at
 * all. Handed a session handle it still works, and no longer guarantees anything.
 */
export async function enqueueTupleDeletes(tx: Sql, tenantId: string, intents: TupleIntent[]): Promise<void> {
  if (intents.length === 0) return
  const rows = intents.map((i) => ({ tenant_id: tenantId, subject: i.subject, relation: i.relation, object: i.object }))
  await tx`INSERT INTO fga_tuple_outbox ${tx(rows, 'tenant_id', 'subject', 'relation', 'object')}`
}

async function dropRow(tenantId: string, i: TupleIntent): Promise<void> {
  await pool`
    DELETE FROM fga_tuple_outbox
     WHERE tenant_id = ${tenantId} AND subject = ${i.subject} AND relation = ${i.relation} AND object = ${i.object}
  `.catch(() => {}) // a row outliving a landed delete costs one converged retry, not correctness
}

/**
 * Try the deletes now, dropping the queue row for each one that lands. Call AFTER the transaction
 * commits. Never throws: a failure here is exactly the case the queue exists for, and #378's rule
 * that drift can never block a removal outlives the change that gave the drift a home.
 */
export async function flushTupleDeletes(fga: OpenFgaClient, tenantId: string, intents: TupleIntent[]): Promise<void> {
  for (const i of intents) {
    try {
      await deleteTuples(fga, [{ user: i.subject, relation: i.relation, object: i.object }])
    } catch (err) {
      // Already gone counts as done -- see the drain below for why this must read the flag.
      if (!isAlreadyConverged(err)) continue
    }
    await dropRow(tenantId, i)
  }
}

type ClaimedRow = { id: string; tenant_id: string; subject: string; relation: string; object: string }

/**
 * Retry what the flush could not land. Returns how many rows left the queue.
 *
 * Deleting an absent tuple is NOT a no-op: the store refuses it and `deleteTuples` turns that into a
 * domain error carrying `alreadyConverged`. At-least-once delivery guarantees redelivery, so the
 * handler treats that as SUCCESS -- by the flag, never by matching the store's sentence (#578/#622).
 * Reading the sentence would make every successful delete a row that retries forever, and the queue
 * depth would stop meaning "the drain is failing".
 *
 * Per-tuple, because a batch delete is all-or-nothing: one converged tuple would take its siblings
 * down with it and none of them would ever land.
 *
 * A row that keeps failing is left where it is (ruled 2026-08-21). It is not litter -- it is the only
 * remaining record of a subject identifier still in the store.
 */
export async function drainTupleOutbox(fga: OpenFgaClient, opts: { batch?: number } = {}): Promise<number> {
  const claimed = await claimOutboxBatch<ClaimedRow>({
    table: 'fga_tuple_outbox',
    returning: ['id', 'tenant_id', 'subject', 'relation', 'object'],
    batch: opts.batch ?? 100,
  })
  let drained = 0
  for (const r of claimed) {
    try {
      await deleteTuples(fga, [{ user: r.subject, relation: r.relation, object: r.object }])
    } catch (err) {
      if (!isAlreadyConverged(err)) continue // leave it claimed; the claim ages out and it is retried
    }
    await pool`DELETE FROM fga_tuple_outbox WHERE id = ${r.id}`
    drained++
  }
  return drained
}

/**
 * The two numbers the ruling publishes: how many rows are waiting, and how old the oldest one is.
 * A queue that quietly drops what it cannot deliver reports success while the residue it exists to
 * remove accumulates; an old row is a signal for a person, not litter.
 */
export async function tupleOutboxBacklog(): Promise<{ waiting: number; oldestAgeSeconds: number | null }> {
  const [row] = await pool<{ waiting: number; oldest: Date | null }[]>`
    SELECT count(*)::int AS waiting, min(created_at) AS oldest FROM fga_tuple_outbox`
  const oldest = row?.oldest ?? null
  return {
    waiting: row?.waiting ?? 0,
    oldestAgeSeconds: oldest ? Math.floor((Date.now() - oldest.getTime()) / 1000) : null,
  }
}

export function startTupleOutboxWorker(
  fga: OpenFgaClient,
  intervalMs: number,
  log?: (m: Record<string, unknown>) => void,
): () => void {
  return startOutboxDrainWorker(async () => {
    const drained = await drainTupleOutbox(fga)
    // Spoken on any tick that did work AND on any tick that leaves a backlog. The second is the one
    // an operator needs, and a drain that only reports its successes never says it.
    const backlog = await tupleOutboxBacklog()
    if (log && (drained > 0 || backlog.waiting > 0)) log({ drained, ...backlog, msg: 'fga tuple outbox' })
    return drained
  }, intervalMs)
}
