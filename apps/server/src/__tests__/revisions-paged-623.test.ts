// #623: the page history returned every published version in one response.
//
// One row per published version, and a long-lived page has hundreds. This pins the bound and the walk.
//
// The walk is DESC, which is the direction that SKIPS rather than repeats: a revision sitting between
// the cursor's truncated instant and its true one lands on no page at all. A reader looking at a history
// they cannot see the end of has no way to notice a missing version — so the walk is measured against
// the truth in the table, for misses AND duplicates, not for one of them.
//
// The fixture writes timestamps a MICROSECOND apart, and the offset is added in SQL from an integer:
// handing the driver a timestamp string loses the microseconds on the way in (measured on #623's
// /members slice — nine rows a microsecond apart all landed on the same instant and the walk came back
// clean while nothing was being tested).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { listRevisions, listAllRevisions } from '../routes/revisions.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const N = 9
const PAGE = 3

let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `rev623-space-${Date.now().toString(36)}`,
  })
  spaceId = space.id
  const page = await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'rev623-page', parentId: null,
  })
  pageId = page.id

  // Revisions written straight to the table: what is being measured is the cursor, not the publish path.
  // `now()` keeps them inside every plan's retention window, so this pin does not also depend on the
  // plan the dev tenant happens to carry.
  for (let i = 0; i < N; i++) {
    // ⚠️ TWO of the nine share an instant, deliberately, AND THEY STRADDLE A PAGE BOUNDARY. A restore
    // writes a fresh revision and a bulk revert can stamp more than one inside the same transaction, so
    // ties are real here — but a tie is only observable when the page ends between the two rows.
    // Measured twice: with nine distinct instants, deleting `id` from the comparison left this file
    // green; with the pair sitting inside one page, it was STILL green, because both rows came back
    // before the cursor was taken. Descending, offsets 8,7,6,6 put the pair at positions 3 and 4 — the
    // boundary for PAGE = 3.
    const offset = i === 5 ? 6 : i
    await admin`
      INSERT INTO revisions (tenant_id, page_id, title, ydoc, created_by, created_at)
      VALUES (${tenant.id}, ${pageId}, ${`rev-${String(i).padStart(2, '0')}`}, '\\x00'::bytea, 'user:dev-user',
              date_trunc('second', now()) + (${offset} || ' microseconds')::interval)`
  }
}, 180_000)

afterAll(async () => {
  await admin`DELETE FROM revisions WHERE page_id = ${pageId}`.catch(() => {})
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  // the handle goes back BEFORE the pool closes — without it `pool.end()` waits for a connection that
  // is still checked out, and the hook times out with every test already green.
  await db.release()
  await pool.end()
  await admin.end()
}, 180_000)

describe('#623: the page history is bounded, and the walk loses nothing', () => {
  it('one response does not carry the whole history', async () => {
    const first = await listRevisions(db, fgaClient, { pageId, userId: 'dev-user', plan: tenant.plan, limit: PAGE })
    expect(first.revisions.length, 'the page is capped at the limit it was asked for').toBe(PAGE)
    expect(first.nextCursor, 'and it says there is more, or the walk stops early').toBeTruthy()
  }, 180_000)

  it('walking the pages returns every revision exactly once, newest first', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 20; guard++) {
      const page = await listRevisions(db, fgaClient, { pageId, userId: 'dev-user', plan: tenant.plan, limit: PAGE, ...(cursor ? { cursor } : {}) })
      seen.push(...page.revisions.map((r) => r.title))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    const repeats = seen.filter((s, i) => seen.indexOf(s) !== i)
    expect(repeats, `the walk returned these twice: ${[...new Set(repeats)].join(', ')}`).toEqual([])
    // …and the misses, which is how the DESC direction fails. Reading only for repeats calls that a pass.
    expect(new Set(seen).size, `walked ${seen.length} rows and saw ${new Set(seen).size} of ${N}`).toBe(N)
    // Newest first is the contract the panel's run detection reads, and it is compared against the
    // TABLE rather than against a sort of what came back — a walk that dropped a row would still be
    // "sorted".
    const truth = (await admin<{ title: string }[]>`
      SELECT title FROM revisions WHERE page_id = ${pageId} ORDER BY created_at DESC, id DESC`).map((r) => r.title)
    expect(seen, 'the order survives the paging').toEqual(truth)
  }, 180_000)

  it('the cursor names the instant it came from, microseconds included', async () => {
    // The mechanism, measured apart from the walk: a cursor that lost precision selects a different
    // instant, and the rows between the two are on no page. The walk above can only catch that when the
    // fixture really does differ below the millisecond — this catches a fixture that quietly does not.
    const first = await listRevisions(db, fgaClient, { pageId, userId: 'dev-user', plan: tenant.plan, limit: PAGE })
    const at = first.nextCursor!.slice(0, first.nextCursor!.indexOf('|'))
    const lastId = first.revisions.at(-1)!.id
    const [row] = await admin<{ same: boolean }[]>`
      SELECT (SELECT created_at FROM revisions WHERE id = ${lastId}) = to_timestamp(${at}::numeric) AS same`
    expect(row!.same, `the cursor "${at}" does not name the instant it came from`).toBe(true)
    const [distinct] = await admin<{ n: number }[]>`
      SELECT count(DISTINCT created_at)::int AS n FROM revisions WHERE page_id = ${pageId}`
    // N - 1: one pair shares an instant on purpose (see the fixture). Anything lower means the
    // microseconds were lost on the way in and the walk above is measuring nothing.
    expect(distinct!.n, 'the fixture collapsed to fewer instants — the microseconds were lost on write').toBe(N - 1)
  }, 180_000)

  it('the walker returns the same history the pages do', async () => {
    const all = await listAllRevisions(db, fgaClient, { pageId, userId: 'dev-user', plan: tenant.plan })
    expect(all.length, 'listAllRevisions is what every existing caller now uses').toBe(N)
  }, 180_000)
})
