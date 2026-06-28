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
import { LogicalSearchDriver, drainOutbox, type SearchDriver } from './search/index.js'
import { pool } from './db/pool.js'

// The drain loop the CLI runs, factored out so it is integration-testable (the CLI block
// below self-executes and ends the pool, which a test can't do). Ensures the index exists,
// then drains until no unclaimed rows remain, returning the total processed.
export async function runSearchSync(driver: SearchDriver): Promise<number> {
  await driver.ensureIndex()
  let total = 0
  let n: number
  do {
    n = await drainOutbox(driver)
    total += n
  } while (n > 0)
  return total
}

// CLI entry: run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const total = await runSearchSync(new LogicalSearchDriver())
  console.log(`search:sync drained ${total} outbox entr${total === 1 ? 'y' : 'ies'}`)
  await pool.end()
}
