import { buildApp } from './app.js'
import { startOutboxWorker } from './search/index.js'

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
