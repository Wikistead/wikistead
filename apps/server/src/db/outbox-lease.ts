import type { PendingQuery, Row } from 'postgres'
import { pool } from './pool.js'

// #432 (the #385 follow-up): THE outbox lease primitive. The three reliable outboxes — search
// (search_outbox), audit (audit_outbox) and webhooks (webhook_outbox) — share one reliability shape,
// aligned by #385: a SHORT claim statement (`claimed_at = now()` over FOR UPDATE SKIP LOCKED
// candidates, stale claims re-claimed after the window), all external I/O OUTSIDE any transaction,
// then success ⇒ delete / failure ⇒ leave (or site-specific backoff that RELEASES the claim). This
// module is the single definition of the claim statement, the stale window and the worker loop; the
// sites inject only their table, columns and per-row handling. Semantics are unchanged by design:
// at-least-once, idempotent handlers, crash ≠ failure (an aged claim retries).

// One stale window for every outbox: how long a claim may sit before a crashed worker's rows are
// re-claimable. Interval literals cannot be parameterized, so sites share this constant by value.
export const OUTBOX_STALE_CLAIM = '2 minutes'

// Claim a disjoint batch (across workers/instances — SKIP LOCKED) of due rows, marking them
// claimed. `extraDue` narrows candidacy (e.g. the webhook backoff gate `next_attempt_at <= now()`);
// `orderBy` picks the fairness column (created_at for FIFO outboxes, next_attempt_at for scheduled).
export async function claimOutboxBatch<T extends Row>(opts: {
  table: string
  returning: string[]
  batch: number
  orderBy?: string
  extraDue?: PendingQuery<Row[]>
}): Promise<T[]> {
  const table = pool(opts.table)
  const order = pool(opts.orderBy ?? 'created_at')
  const cols = pool(opts.returning)
  const rows = opts.extraDue
    ? await pool`
        UPDATE ${table} SET claimed_at = now()
        WHERE id IN (
          SELECT id FROM ${table}
          WHERE (claimed_at IS NULL OR claimed_at < now() - interval '2 minutes')
            ${opts.extraDue}
          ORDER BY ${order}
          LIMIT ${opts.batch}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING ${cols}
      `
    : await pool`
        UPDATE ${table} SET claimed_at = now()
        WHERE id IN (
          SELECT id FROM ${table}
          WHERE claimed_at IS NULL OR claimed_at < now() - interval '2 minutes'
          ORDER BY ${order}
          LIMIT ${opts.batch}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING ${cols}
      `
  return rows as unknown as T[]
}

// The shared periodic drain loop: one in-process `running` guard against self-overlap (SKIP LOCKED
// already handles cross-instance), a capped backlog-clearing burst per tick, errors deferred to the
// next tick. Call from the server ENTRY, not buildApp — tests drive the drain functions directly.
export function startOutboxDrainWorker(drain: () => Promise<number>, intervalMs: number): () => void {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      for (let i = 0; i < 20 && (await drain()) > 0; i++) { /* clear backlog, capped */ }
    } catch {
      /* next tick retries */
    } finally {
      running = false
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
