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
import { LogicalSearchDriver, drainOutbox } from './search/index.js'
import { pool } from './db/pool.js'

const driver = new LogicalSearchDriver()
await driver.ensureIndex()

let total = 0
let n: number
do {
  n = await drainOutbox(driver)
  total += n
} while (n > 0)

console.log(`search:sync drained ${total} outbox entr${total === 1 ? 'y' : 'ies'}`)
await pool.end()
