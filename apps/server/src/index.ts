import { buildApp } from './app.js'
import { startOutboxWorker } from './search/index.js'
import { startAuditDrainWorker } from './audit/outbox.js'
import { assertProductionFgaPersistent } from './openfga-guard.js'

// Fail fast: in production OpenFGA must be persistent (postgres), not in-memory (ADR-035).
assertProductionFgaPersistent()

const app = await buildApp()

const port = Number(process.env.SERVER_PORT ?? 4000)
app.listen({ port, host: '0.0.0.0' }).catch((e) => {
  app.log.error(e)
  process.exit(1)
})

// Background search-reindex drain. The inline processOutboxAsync only covers API
// mutations; collab body edits enqueue outbox rows that this worker drains, so
// full-text body search actually updates. Started here (not in buildApp) so tests
// driving the app via inject don't spawn a timer.
startOutboxWorker(app.searchDriver, Number(process.env.SEARCH_OUTBOX_POLL_MS ?? 2000))

// Background audit drain (#177): appends enqueued audit intents to the hash-chained audit_log.
// Reliable + idempotent; started here (not buildApp) so inject-driven tests don't spawn a timer.
startAuditDrainWorker(Number(process.env.AUDIT_OUTBOX_POLL_MS ?? 3000))
