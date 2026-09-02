import { runInAuthzScope, SYSTEM_SCOPE } from '@wikistead/authz'
import type { PendingQuery, Row } from 'postgres'
import { pool } from './pool.js'
import { withSpan } from '../telemetry/tracing.js' // #987 / ADR-270 §3.2

// #432 (the #385 follow-up): THE outbox lease primitive. The reliable outboxes — search
// (search_outbox), audit (audit_outbox), webhooks (webhook_outbox), email (email_outbox), imports
// (import_jobs), analytics (analytics_outbox) and, since #896, permission-store tuple deletes
// (fga_tuple_outbox) — share one reliability shape, aligned by #385: a SHORT claim statement (`claimed_at = now()` over FOR UPDATE SKIP LOCKED
// candidates, stale claims re-claimed after the window), all external I/O OUTSIDE any transaction,
// then success ⇒ delete / failure ⇒ leave (or site-specific backoff that RELEASES the claim). This
// module is the single definition of the claim statement, the stale window and the worker loop; the
// sites inject only their table, columns and per-row handling. Semantics are unchanged by design:
// at-least-once, idempotent handlers, crash ≠ failure (an aged claim retries).

// One stale window for every outbox: how long a claim may sit before a crashed worker's rows are
// re-claimable. It is interpolated as a VALUE cast to interval (`${OUTBOX_STALE_CLAIM}::interval`),
// so this constant is the only place the window exists. (An earlier note claimed intervals cannot be
// parameterized — that is true only of the `interval '…'` LITERAL syntax; a parameter cast with
// `::interval` is ordinary SQL. The literal left the constant decorative: changing it would not have
// changed any query, and no test would have caught that.)
export const OUTBOX_STALE_CLAIM = '2 minutes'

// Claim a disjoint batch (across workers/instances — SKIP LOCKED) of due rows, marking them
// claimed. `extraDue` narrows candidacy (e.g. the webhook backoff gate `next_attempt_at <= now()`);
// `orderBy` picks the fairness column (created_at for FIFO outboxes, next_attempt_at for scheduled).
//
// ADR-252 §6a rulings 2/3 (#810): THE single chokepoint every claiming outbox rides — the ADR's own
// review measured this directly ("the word is made load-bearing where the freeze actually lives:
// claimOutboxBatch... a `frozen` declaration there IS the exclusion — the drain cannot declare it and
// skip it, because declaring it is how it happens"). So the exclusion lives here, once, rather than as
// a per-worker declaration nothing outside this function could actually enforce.
//
// `T extends Row & { tenant_id: string }` (ruling 3): a future outbox row type that omits `tenant_id`
// fails to COMPILE here, before a table without the column this claim's WHERE clause depends on could
// ever be built — "stopping before it is built is cheaper" than the alternative, which is
// `outbox-lease.ts`'s own `catch { /* next tick retries */ } ` (left untouched by this ticket, on
// purpose — see §6a ruling 3) swallowing the 42703 a claim against a missing column would throw.
//
// `tenants.deleted_at IS NOT NULL` (migration 132) excludes a workspace's rows from ever being claimed
// while its grace period is open — nothing writes that column yet (ADR-252 §1/§2 is not landed by this
// ticket), so every row is claimable today, unchanged. `tenants` carries no RLS policy (the global
// registry — see db/index.ts), so the bare-pool subquery here returns real rows rather than the
// silent-zero an RLS-scoped read would give a system-scope background worker (#479's shape).
export async function claimOutboxBatch<T extends Row & { tenant_id: string }>(opts: {
  table: string
  returning: string[]
  batch: number
  orderBy?: string
  extraDue?: PendingQuery<Row[]>
}): Promise<T[]> {
  const table = pool(opts.table)
  const order = pool(opts.orderBy ?? 'created_at')
  const cols = pool(opts.returning)
  // ONE claim statement. The due-narrowing fragment defaults to a always-true clause instead of an
  // empty one: an EMPTY postgres.js fragment silently collapses the surrounding SQL (the first cut of
  // this module zeroed the claim that way, which is why the branch existed), whereas `AND TRUE` is a
  // real, harmless predicate the planner drops. With the branch gone, the stale window — and every
  // other part of the lease — genuinely has one definition.
  const due = opts.extraDue ?? pool`AND TRUE`
  const rows = await pool`
    UPDATE ${table} SET claimed_at = now()
    WHERE id IN (
      SELECT id FROM ${table}
      WHERE (claimed_at IS NULL OR claimed_at < now() - ${OUTBOX_STALE_CLAIM}::interval)
        AND tenant_id NOT IN (SELECT id FROM tenants WHERE deleted_at IS NOT NULL)
        ${due}
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
//
// #987 / ADR-270 §3.2 / §4: every outbox drain in the process passes through here, so this is where
// a drain becomes a span — a ROOT span, since no request is behind it. `label` names the worker on
// the span (`search`, `email`, …); a caller that passes none is still traced, just anonymously.
export function startOutboxDrainWorker(drain: () => Promise<number>, intervalMs: number, label = 'outbox'): () => void {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      // #637 / ADR-216 §2: not on behalf of a request, and it SAYS so. An explicit unrestricted scope,
      // rather than arriving with none — which in a process that declared the requirement is a crash, and
      // in one that has not is indistinguishable from a request path where somebody forgot.
      await runInAuthzScope(SYSTEM_SCOPE, async () => {
        // `() => drain()` rather than passing `drain` itself: authz-scope-637's discovery walk recognises a
        // timer that reaches authorization by the `drain(` call shape, and a sweep it cannot see is a
        // sweep it cannot hold to naming its scope.
        for (let i = 0; i < 20 && (await withSpan('outbox.drain', { 'outbox.worker': label }, () => drain())) > 0; i++) { /* clear backlog, capped */ }
      })
    } catch {
      /* next tick retries */
    } finally {
      running = false
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
