// #618: the search outbox grew forever, and the CLI that drains it stopped early.
//
// Found while running an unrelated merge gate: the isolated stack's queue held 316 rows, 285 of them
// for tenants that no longer existed. Those rows can never succeed — there is nothing to index — so
// each drain claimed them, failed, and left them for the next one. Because the claim takes the
// OLDEST rows first, they permanently occupied the head of every batch, and the CLI (which continued
// only while a batch INDEXED something) read "this batch indexed nothing" as "the queue is empty"
// and exited reporting success with fresh rows still waiting.
//
// Both halves are measured here against a real Postgres + Meili: the orphan is dropped (and nothing
// else is), and a fresh row queued BEHIND a wall of failures still gets indexed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { LogicalSearchDriver, drainOutbox, lastDrainOutcome, type SearchDriver } from '../search/index.js'
import { runSearchSync } from '../search-sync.js'

// A store that refuses every write — Meili down, or refusing the doc. This is what a LIVE tenant's
// failure actually looks like; a missing page is NOT one (the drain reads that as "delete the doc",
// which succeeds). Getting that wrong was the first draft of this test: it asserted a failure and
// measured a success.
const refusingDriver = (real: SearchDriver): SearchDriver => ({
  ...real,
  ensureIndex: () => real.ensureIndex(),
  upsertDoc: async () => { throw new Error('the search store is unavailable') },
  deleteDoc: async () => { throw new Error('the search store is unavailable') },
}) as SearchDriver

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const GHOST_TENANT = `sob618-ghost-${STAMP}` // inserted, given rows, then deleted
const SPACE = `sob618-space-${STAMP}`
const LIVE_PAGE = `sob618-live-${STAMP}`
const TOKEN = `sob618tok${STAMP}`

// A row for a tenant that is gone. Written straight to the table: enqueueOutbox needs a live tenant,
// and the state being pinned is the one left behind AFTER a tenant is deleted.
const orphanRow = async (pageId: string) =>
  (await admin<{ id: string }[]>`
    INSERT INTO search_outbox (tenant_id, page_id, operation) VALUES (${GHOST_TENANT}, ${pageId}, 'upsert') RETURNING id`)[0]!.id

beforeAll(async () => {
  await driver.ensureIndex()
  // A queue with unrelated residue in it is a different experiment; start from a known floor.
  await admin`DELETE FROM search_outbox`
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${SPACE}, ${TENANT}, 'sob618') ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, title, published_md, published_at)
              VALUES (${LIVE_PAGE}, ${TENANT}, ${SPACE}, 'sob618 live', ${`body ${TOKEN}`}, now()) ON CONFLICT (id) DO NOTHING`
}, 180_000)

afterAll(async () => {
  await admin`DELETE FROM search_outbox WHERE tenant_id IN (${TENANT}, ${GHOST_TENANT})`.catch(() => {})
  await driver.deleteDoc(LIVE_PAGE).catch(() => {})
  await admin`DELETE FROM pages WHERE id = ${LIVE_PAGE}`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${SPACE}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${GHOST_TENANT}`.catch(() => {})
  await admin.end(); await pool.end()
}, 120_000)

const outboxCount = async (tenantId: string) =>
  (await admin<[{ n: number }]>`SELECT count(*)::int AS n FROM search_outbox WHERE tenant_id = ${tenantId}`)[0].n

describe('#618: a row whose tenant is gone leaves the queue', () => {
  it('the drain drops it — and leaves every live row alone', async () => {
    await admin`DELETE FROM search_outbox`
    // Two ghosts and one real intent, so "dropped everything" cannot pass as "dropped the ghosts".
    await orphanRow(`${LIVE_PAGE}-ghost-a`)
    await orphanRow(`${LIVE_PAGE}-ghost-b`)
    await admin`INSERT INTO search_outbox (tenant_id, page_id, operation) VALUES (${TENANT}, ${LIVE_PAGE}, 'upsert')`
    expect(await outboxCount(GHOST_TENANT)).toBe(2)

    await drainOutbox(driver)
    expect(await outboxCount(GHOST_TENANT), 'the impossible rows are gone').toBe(0)
    expect(lastDrainOutcome().dropped, 'and the drain said how many').toBe(2)
    // The live row was indexed on the same pass, not swept.
    expect(await outboxCount(TENANT), 'the real intent was processed, not dropped').toBe(0)
  }, 120_000)

  it('a live tenant\'s failing row is NOT dropped — reindex stays a trusted path', async () => {
    await admin`DELETE FROM search_outbox`
    await admin`INSERT INTO search_outbox (tenant_id, page_id, operation) VALUES (${TENANT}, ${LIVE_PAGE}, 'upsert')`
    await drainOutbox(refusingDriver(driver))
    expect(lastDrainOutcome().dropped, 'nothing was dropped for a living tenant').toBe(0)
    expect(await outboxCount(TENANT), 'the row stayed, to be retried when the store is back').toBe(1)
    await admin`DELETE FROM search_outbox`
  }, 120_000)
})

describe('#618: the CLI does not stop at a batch that indexed nothing', () => {
  it('a fresh row queued BEHIND a wall of ghosts still gets indexed', async () => {
    await admin`DELETE FROM search_outbox`
    // More ghosts than one claim batch (50), all older than the real row — the arrangement measured
    // on the stack. The old loop drained the first batch, indexed 0, and returned.
    for (let i = 0; i < 60; i++) await orphanRow(`${LIVE_PAGE}-wall-${i}`)
    await admin`INSERT INTO search_outbox (tenant_id, page_id, operation) VALUES (${TENANT}, ${LIVE_PAGE}, 'upsert')`
    await driver.deleteDoc(LIVE_PAGE).catch(() => {})

    const result = await runSearchSync(driver)
    expect(result.processed, `the fresh row was reached: ${JSON.stringify(result)}`).toBeGreaterThanOrEqual(1)
    expect(result.dropped, 'and the wall was cleared, not skipped').toBeGreaterThanOrEqual(60)
    expect(await outboxCount(TENANT), 'nothing of ours is left queued').toBe(0)
    expect(await outboxCount(GHOST_TENANT)).toBe(0)
  }, 180_000)

  it('a run that leaves rows behind REPORTS them instead of returning a quiet zero', async () => {
    await admin`DELETE FROM search_outbox`
    await admin`INSERT INTO search_outbox (tenant_id, page_id, operation) VALUES (${TENANT}, ${LIVE_PAGE}, 'upsert')`
    const result = await runSearchSync(refusingDriver(driver))
    // The old signature was a single number, and this run's number is 0 — indistinguishable from an
    // empty queue, which is what sent an operator looking in the wrong place.
    expect(result.processed).toBe(0)
    expect(result.failed, 'the run says it left work behind').toBeGreaterThanOrEqual(1)
    await admin`DELETE FROM search_outbox`
  }, 120_000)
})
