import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'
import { startOutboxWorker } from './search/index.js'
import { startWebhookDrainWorker } from './routes/webhooks.js'
import { startEmailDrainWorker } from './email/outbox.js'
import { startShareLinkSweepWorker } from './routes/share-links.js'
import { pool } from './db/pool.js'
import { startCustomDomainRecheckWorker, recheckIntervalFromEnv } from './routes/custom-domains.js' // #576: a domain that stopped being ours must stop deciding link hosts
import { startTrashRetentionWorker } from './routes/pages.js'
import { fgaClient } from '@wikistead/authz'
import { assertProductionFgaPersistent, assertFgaModelFresh } from './openfga-guard.js'
import { assertMigrationsApplied } from './db/migration-guard.js'

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
  // Fail fast (#910): every migration this image ships must already be in the database's ledger.
  // A rollout that replaced only the image otherwise boots and fails per request with 42703.
  await assertMigrationsApplied(pool)

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

  // #688: the audit drain worker moved with the ledger into @wikistead-ee/server — auditEeMount
  // starts it on the app lifecycle. A CE entry has no ledger to drain, so nothing starts here.

  // Background share-link revoke-failure sweep (#220): retries FGA-delete failures recorded during a
  // privatisation so a "private but link alive on FGA" leak window self-heals. Coarse interval (failures
  // are rare); started here (not buildApp) so inject-driven tests don't spawn a timer.
  startShareLinkSweepWorker(fgaClient, Number(process.env.SHARE_LINK_SWEEP_POLL_MS ?? 60000))
  // #497 / ADR-183 §2b: revoke admin materialised from an IdP group the member no longer carries. Login
  // fixes the member who signs in; this is the only thing that fixes the one who never does again.
  startCustomDomainRecheckWorker(recheckIntervalFromEnv(process.env.CUSTOM_DOMAIN_RECHECK_MS))

  // Background webhook delivery (#228 / ADR-108): drains the in-tx webhook outbox, signs (HMAC) and POSTs
  // each event to matching active hooks via the pinned SSRF-safe client. Started here (not buildApp) so
  // inject-driven tests don't spawn a timer.
  startWebhookDrainWorker(fgaClient, Number(process.env.WEBHOOK_OUTBOX_POLL_MS ?? 5000))

  // #688 slice 2: the analytics drain worker moved with the collector into @wikistead-ee/server
  // (analyticsEeMount starts it on the app lifecycle, beside the audit drain).

  // Background email delivery (#547 / ADR-196 §5): drains the email outbox — messages are BUILT at
  // send time behind the send-time authz gates, per-tenant transport via the §7 resolver. Started
  // here (not buildApp) so inject-driven tests don't spawn a timer; the lesson says name it:
  // tests drive drainEmailOutbox directly, THIS is what delivers in production.
  startEmailDrainWorker({ fallback: app.email, log: (m) => app.log.info(m) }, Number(process.env.EMAIL_OUTBOX_POLL_MS ?? 5000))

  // Digest producer (#547 S4): hourly tick, fires at EMAIL_DIGEST_HOUR (EMAIL_DIGEST_TZ, default UTC).
  const { startDigestProducerWorker } = await import('./email/digest.js')
  startDigestProducerWorker((m) => app.log.info(m))

  // Background import drain (#712 / ADR-227 §7): runs the imports that were too large to finish inside
  // one request. Started here (not buildApp) so inject-driven tests don't spawn a timer — they call
  // drainImportJobs directly; THIS is what runs a queued import in production.
  const { startImportJobWorker } = await import('./import/jobs.js')
  startImportJobWorker(
    { fga: fgaClient, storage: app.storageDriver, driver: app.searchDriver },
    Number(process.env.IMPORT_JOB_POLL_MS ?? 5000),
  )

  // #896 / ADR-255 Decision 5: retries the permission-store tuple deletes a member removal could not
  // land. Started here (not buildApp) so inject-driven tests don't spawn a timer — they call
  // drainTupleOutbox directly; THIS is what clears the queue in production, and its log line carries
  // the two numbers the 2026-08-21 ruling asks for (how many wait, how old the oldest is).
  const { startTupleOutboxWorker } = await import('./db/tuple-outbox.js')
  startTupleOutboxWorker(fgaClient, Number(process.env.TUPLE_OUTBOX_POLL_MS ?? 30000), (m) => app.log.info(m))

  // Background trash retention purge (#411 / ADR-153): permanently deletes trash entries older than
  // TRASH_RETENTION_DAYS (30). Hourly is plenty for a 30-day horizon; started here (not buildApp) so
  // inject-driven tests don't spawn a timer.
  startTrashRetentionWorker(fgaClient, app.searchDriver, Number(process.env.TRASH_SWEEP_POLL_MS ?? 60 * 60 * 1000))

  return app
}
