// Manual search-outbox drain (#119): `pnpm search:sync`.
//
// The search_outbox records a reindex intent in the SAME transaction as every permission /
// content change (ADR-005), so the intent survives Meilisearch being down. A running server
// drains it via the background worker; this script drains whatever remains ON DEMAND — e.g.
// after Meili is restored, or in a one-shot/ops context with no long-running server.
//
// Reliable + idempotent: it reuses the same drainOutbox() the worker uses (FOR UPDATE SKIP
// LOCKED, so it coexists with a live worker; Meili upsert/delete are idempotent, so re-running
// is harmless). Rows that fail are left for retry; the loop ends once no unclaimed rows remain.
import { LogicalSearchDriver, drainOutbox, lastDrainOutcome, type SearchDriver } from './search/index.js'
import { pool } from './db/pool.js'

// The drain loop the CLI runs, factored out so it is integration-testable (the CLI block
// below self-executes and ends the pool, which a test can't do). Ensures the index exists,
// then drains until no unclaimed rows remain, returning the total processed.
//
// #618: the loop used to continue on `processed > 0`, which reads "this batch indexed nothing" as
// "the queue is empty". Those are different facts, and the difference was not hypothetical: a batch
// of 50 rows that all fail (the orphans of the sibling defect sat at the head of the queue, oldest
// first) ended the run reporting "drained 0" with fresh rows still waiting behind them. Measured:
// pending=3 and the CLI returned 0.
//
// So the loop follows what it CLAIMED — there were rows, so look again — and stops when a claim
// comes back empty. Rows that failed stay for retry (reindex is a trusted path; nothing is dropped
// here), and the count of them is REPORTED rather than folded into a quiet success.
export async function runSearchSync(driver: SearchDriver): Promise<{ processed: number; failed: number; dropped: number }> {
  await driver.ensureIndex()
  let processed = 0
  let failed = 0
  let dropped = 0
  // A stuck row is claimed again on the next pass once its claim ages out; within ONE run a batch
  // that claims only rows it already saw would spin. The bound is the number of passes, not time:
  // each pass claims a fresh batch, and a run that keeps finding new rows is doing its job.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    await drainOutbox(driver)
    const outcome = lastDrainOutcome()
    if (outcome.claimed === 0) break
    processed += outcome.processed
    dropped += outcome.dropped
    failed += outcome.claimed - outcome.processed - outcome.dropped
    // Every claimed row failed and none was an orphan: claiming again inside this run would return
    // the same rows (their claims have not aged out), so stop and SAY so rather than spin.
    if (outcome.processed === 0 && outcome.dropped === 0) break
  }
  return { processed, failed, dropped }
}

// Bounded so a pathological queue cannot hold a one-shot CLI open forever. 50 rows a pass — enough
// for a large backlog in one run, and a backlog past it is drained by running the command again.
const MAX_PASSES = 1000

// CLI entry: run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { processed, failed, dropped } = await runSearchSync(new LogicalSearchDriver())
  console.log(`search:sync drained ${processed} outbox entr${processed === 1 ? 'y' : 'ies'}`)
  // #618: a run that left rows behind says so. The old CLI printed "drained 0" for a queue it could
  // not empty, which reads as "nothing to do" — the operator's cue to look elsewhere.
  if (dropped > 0) console.log(`search:sync dropped ${dropped} entr${dropped === 1 ? 'y' : 'ies'} whose tenant no longer exists`)
  if (failed > 0) console.warn(`search:sync left ${failed} entr${failed === 1 ? 'y' : 'ies'} for retry (they failed this run)`)
  await pool.end()
  // A backlog nobody could index is not a successful run: exit non-zero so a scheduled invocation
  // surfaces instead of reporting success into a log nobody reads.
  if (failed > 0) process.exitCode = 1
}
