// Integration test — real Postgres + OpenFGA + Meilisearch + Fastify, no mocks.
// #119 (review fix): the `pnpm search:sync` CLI was only smoke-checked against a clean
// queue (drained 0), so its actual job — drain accumulated rows and reflect them in Meili
// was never exercised. This drives runSearchSync (the CLI's exported loop) over N pending
// rows and asserts: it returns the count drained, the queue empties, AND the body terms are
// searchable afterward (Meili actually updated). The background worker is NOT started by
// buildApp (only the real index.ts entry starts it), so the count is deterministic.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { runSearchSync } from '../search-sync.js'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const SPACE = 'syncsync-space'
// Three distinct pages, each enqueued once → N=3 pending outbox rows to drain in one run.
const STAMP = Date.now().toString(36)
const PAGES = [0, 1, 2].map((i) => ({ id: `search-sync-page-${i}-${STAMP}`, token: `syncbody${i}${STAMP}` }))

const fgaFixture = [
  { user: `tenant:${TENANT}`, relation: 'tenant', object: `space:${SPACE}` },
  ...PAGES.map((p) => ({ user: `space:${SPACE}`, relation: 'space', object: `page:${p.id}` })),
]

const ydoc = (text: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, text); return d })()))
let app: FastifyInstance

const search = async (q: string) => {
  const res = await app.inject({ method: 'GET', url: `/search?q=${encodeURIComponent(q)}`, headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' } })
  return (res.json() as { id: string }[]).map((h) => h.id)
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${SPACE}, ${TENANT}, 'Sync Space') ON CONFLICT (id) DO NOTHING`
  for (const p of PAGES) {
    const body = `# Sync Page\n\n${p.token} 京都の本文\n`
    await admin`INSERT INTO pages (id, tenant_id, space_id, title, ydoc, published_md)
                VALUES (${p.id}, ${TENANT}, ${SPACE}, 'Sync Page', ${ydoc(body)}, ${body})
                ON CONFLICT (id) DO NOTHING`
  }
  // One at a time, tolerating 'already exists': OpenFGA refuses a WHOLE batch when any tuple in it
  // exists, and a killed previous run (afterAll never reached) leaves these behind — the batch then
  // refuses forever and this file is deterministically red until someone hand-cleans the store
  // (measured 2026-08-14; the membership helper documents the same trap).
  for (const tuple of fgaFixture) {
    await writeTuples(fgaClient, [tuple]).catch(() => { /* already there — a prior run's leftover */ })
  }
  // Mimic a backlog accumulated while Meili was down: enqueue one 'upsert' per page, undrained.
  for (const p of PAGES) {
    await admin`INSERT INTO search_outbox (tenant_id, page_id, operation) VALUES (${TENANT}, ${p.id}, 'upsert')`
  }
})

afterAll(async () => {
  for (const p of PAGES) await app.searchDriver.deleteDoc(p.id).catch(() => {})
  await deleteTuples(fgaClient, fgaFixture).catch(() => {})
  for (const p of PAGES) await admin`DELETE FROM search_outbox WHERE page_id = ${p.id}`.catch(() => {})
  for (const p of PAGES) await admin`DELETE FROM pages WHERE id = ${p.id}`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${SPACE}`.catch(() => {})
  await app.close()
  await admin.end()
  await pool.end()
})

// #786: the claim here is not about time, and it kept losing to the clock anyway. The drain WAITS
// for Meili to apply each document (the driver calls waitForTask), so this file's cost is however
// long a busy store takes to index three pages — not work this test does.
//
// Measured, same three pages, same assertions: 0.4s of drain against an idle store (1.5s for the
// file), and past the 5s default when the rest of the suite is driving Meili at the same time
// where it reported "Test timed out", which reads as a broken drain rather than a busy index. A
// file-level reading right after a full suite came back at 18s.
//
// Same reasoning the owner accepted on #763: an assertion that is not about duration gets a budget
// it cannot lose to the machine. This is NOT a licence to widen a budget when the thing under
// test IS the time.
const BUDGET = 30_000

describe('search:sync CLI drain (runSearchSync)', () => {
  it('drains the accumulated rows, returns the count, and reflects them in Meili', async () => {
    // Before: none of the body tokens are searchable (the rows are still pending).
    for (const p of PAGES) expect(await search(p.token)).not.toContain(p.id)
    const [{ n: pending }] = await admin<[{ n: number }]>`SELECT count(*)::int AS n FROM search_outbox WHERE page_id = ANY(${PAGES.map((p) => p.id)})`
    expect(pending).toBe(PAGES.length)

    // Run the CLI's real drain loop.
    const { processed } = await runSearchSync(app.searchDriver)
    expect(processed).toBeGreaterThanOrEqual(PAGES.length) // drained at least our N rows

    // After: every body token is now searchable (Meili was actually updated)…
    for (const p of PAGES) expect(await search(p.token)).toContain(p.id)
    // …and our rows were consumed.
    const [{ n: left }] = await admin<[{ n: number }]>`SELECT count(*)::int AS n FROM search_outbox WHERE page_id = ANY(${PAGES.map((p) => p.id)})`
    expect(left).toBe(0)
  }, BUDGET)

  it('is a no-op on a clean queue (the original smoke case still holds)', async () => {
    // #618: the loop reports what it left behind as well as what it indexed — a clean queue is
    // all three at zero, which is a different fact from "indexed nothing" (the case that used to
    // end the run early).
    //
    // #786: it makes its OWN clean queue rather than inheriting the one above. When the drain above
    // died part-way, this reported `processed: 5` against an expected 0 — a second red, about a
    // fact that was never in question, for a failure that had already been reported once. One slow
    // run should show up once. (Files in this package run one at a time, so nothing enqueues
    // between the two calls.)
    await runSearchSync(app.searchDriver)
    expect(await runSearchSync(app.searchDriver)).toEqual({ processed: 0, failed: 0, dropped: 0 })
  }, BUDGET)
})
