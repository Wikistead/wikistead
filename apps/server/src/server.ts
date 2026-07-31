import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'
import { startOutboxWorker } from './search/index.js'
import { startAuditDrainWorker } from './audit/outbox.js'
import { startWebhookDrainWorker } from './routes/webhooks.js'
import { startAnalyticsDrainWorker } from './analytics/outbox.js'
import { startEmailDrainWorker } from './email/outbox.js'
import { startShareLinkSweepWorker } from './routes/share-links.js'
import { startAdminDriftWorker } from './auth/admin-mapping.js' // #497 / ADR-183 2b
import { pool } from './db/pool.js'
import { startCustomDomainRecheckWorker } from './routes/custom-domains.js' // #576: a domain that stopped being ours must stop deciding link hosts
import { startTrashRetentionWorker } from './routes/pages.js'
import { fgaClient } from '@wikistead/authz'
import { assertProductionFgaPersistent, assertFgaModelFresh } from './openfga-guard.js'

// #178 / ADR-084: the server bootstrap, extracted from index.ts into a reusable function so BOTH
// entrypoints share it — the CE entrypoint (apps/server/src/index.ts) and the EE composition root
// (packages/ee-server/src/main.ts, which registers the EE mount BEFORE calling this). Behaviour is
// identical to the old top-level index.ts (build → listen → background workers). Nothing here imports
// the EE namespace; the EE plugins mount through the getEeFeatures() seam inside buildApp.
export async function startServer(): Promise<FastifyInstance> {
  // Fail fast: in production OpenFGA must be persistent (postgres), not in-memory (ADR-035).
  assertProductionFgaPersistent()
  // Fail fast (non-production): the pinned FGA model must exist and match model.fga (#433) —
  // model drift otherwise surfaces as silent data-shaped authz failures instead of a config error.
  await assertFgaModelFresh()

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

  // Background share-link revoke-failure sweep (#220): retries FGA-delete failures recorded during a
  // privatisation so a "private but link alive on FGA" leak window self-heals. Coarse interval (failures
  // are rare); started here (not buildApp) so inject-driven tests don't spawn a timer.
  startShareLinkSweepWorker(fgaClient, Number(process.env.SHARE_LINK_SWEEP_POLL_MS ?? 60000))
  // #497 / ADR-183 §2b: revoke admin materialised from an IdP group the member no longer carries. Login
  // fixes the member who signs in; this is the only thing that fixes the one who never does again.
  startAdminDriftWorker(fgaClient, Number(process.env.ADMIN_DRIFT_POLL_MS ?? 900000))
  startCustomDomainRecheckWorker(Number(process.env.CUSTOM_DOMAIN_RECHECK_MS ?? 21600000))

  // Background webhook delivery (#228 / ADR-108): drains the in-tx webhook outbox, signs (HMAC) and POSTs
  // each event to matching active hooks via the pinned SSRF-safe client. Started here (not buildApp) so
  // inject-driven tests don't spawn a timer.
  startWebhookDrainWorker(fgaClient, Number(process.env.WEBHOOK_OUTBOX_POLL_MS ?? 5000))

  // Background analytics drain (#464 / ADR-175): folds enqueued page-view intents into the who-viewed
  // roster + daily counters (at-least-once; fold+delete in one tenant tx). Without this worker the
  // roster stays empty for ever and the outbox accumulates unboundedly — thereturn: every test
  // called the drain directly, so nothing noticed the worker was never started. Started here (not
  // buildApp) so inject-driven tests don't spawn a timer.
  startAnalyticsDrainWorker(Number(process.env.ANALYTICS_OUTBOX_POLL_MS ?? 5000))

  // Background email delivery (#547 / ADR-196 §5): drains the email outbox — messages are BUILT at
  // send time behind the send-time authz gates, per-tenant transport via the §7 resolver. Started
  // here (not buildApp) so inject-driven tests don't spawn a timer; thelesson says name it:
  // tests drive drainEmailOutbox directly, THIS is what delivers in production.
  startEmailDrainWorker({ fallback: app.email, log: (m) => app.log.info(m) }, Number(process.env.EMAIL_OUTBOX_POLL_MS ?? 5000))

  // Digest producer (#547 S4): hourly tick, fires at EMAIL_DIGEST_HOUR (EMAIL_DIGEST_TZ, default UTC).
  const { startDigestProducerWorker } = await import('./email/digest.js')
  startDigestProducerWorker((m) => app.log.info(m))

  // Background trash retention purge (#411 / ADR-153): permanently deletes trash entries older than
  // TRASH_RETENTION_DAYS (30). Hourly is plenty for a 30-day horizon; started here (not buildApp) so
  // inject-driven tests don't spawn a timer.
  startTrashRetentionWorker(fgaClient, app.searchDriver, Number(process.env.TRASH_SWEEP_POLL_MS ?? 60 * 60 * 1000))

  return app
}
