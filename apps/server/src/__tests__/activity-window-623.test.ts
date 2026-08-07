// #623: the ledger called `/me/activity` "one row per thing the person did; grows for ever".
//
// It is not. The query buckets by CALENDAR DAY inside a twelve-month window, so the response is at most
// one row per day in a year however much the person did — and the rows that fall out of the window stop
// being returned. That is a real bound; what was missing was a measurement of it, and a ledger line
// saying so instead of a debt line promising a fix that is already there.
//
// The line is corrected rather than deleted because the scan CANNOT see this bound: `withoutSubqueries`
// strips the derived tables the window and the grouping live in, so the route reads as unbounded. The
// ledger is where a bound the instrument cannot see gets stated — and this file is where it is checked.
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
import { getMyActivity } from '../routes/account.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SUB = `act623-${STAMP}`
// Days INSIDE the window, each carrying several events, plus days well OUTSIDE it.
const INSIDE_DAYS = 12
const EVENTS_PER_DAY = 7
const OUTSIDE_DAYS = 5

let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `act623-space-${STAMP}`,
  })
  spaceId = space.id
  const page = await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'act623-page', parentId: null,
  })
  pageId = page.id

  // Inside: several revisions on each of a handful of recent days. `- 1 day` avoids the boundary
  // between "now" in UTC and "today" in the reader's timezone, which is a different question.
  for (let d = 1; d <= INSIDE_DAYS; d++) {
    for (let e = 0; e < EVENTS_PER_DAY; e++) {
      await admin`
        INSERT INTO revisions (tenant_id, page_id, title, ydoc, created_by, created_at)
        VALUES (${tenant.id}, ${pageId}, ${`in-${d}-${e}`}, '\\x00'::bytea, ${`user:${SUB}`},
                now() - (${d} || ' days')::interval - (${e} || ' hours')::interval)`
    }
  }
  // Outside: one revision on each of several days more than a year ago.
  for (let d = 0; d < OUTSIDE_DAYS; d++) {
    await admin`
      INSERT INTO revisions (tenant_id, page_id, title, ydoc, created_by, created_at)
      VALUES (${tenant.id}, ${pageId}, ${`out-${d}`}, '\\x00'::bytea, ${`user:${SUB}`},
              now() - interval '13 months' - (${d} || ' days')::interval)`
  }
}, 300_000)

afterAll(async () => {
  await admin`DELETE FROM revisions WHERE page_id = ${pageId}`.catch(() => {})
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end()
  await admin.end()
}, 300_000)

describe('#623: the activity heatmap is bounded by a window and a day', () => {
  it('a day of work is ONE row, however many things were done in it', async () => {
    // This is half the bound: the response counts days, not events. Without it, a person with a
    // thousand edits in a week would carry a thousand rows.
    const { days } = await getMyActivity(db, { subject: SUB, tz: 'UTC' })
    const mine = days.filter((d) => d.count > 0 && d.edits > 0)
    const busiest = mine.find((d) => d.edits === EVENTS_PER_DAY)
    expect(busiest, `no day carried all ${EVENTS_PER_DAY} events — the fixture landed on the wrong days`)
      .toBeDefined()
    // …and the day appears once, not once per event
    const dayKeys = mine.map((d) => d.day)
    expect(dayKeys.length, 'a day is repeated — the grouping is gone').toBe(new Set(dayKeys).size)
  }, 300_000)

  it('work older than the window is not returned at all', async () => {
    // The other half: the response cannot grow with the age of the account.
    const { days } = await getMyActivity(db, { subject: SUB, tz: 'UTC' })
    const cutoff = new Date(Date.now() - 366 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const stale = days.filter((d) => d.day < cutoff)
    expect(stale.map((d) => d.day), 'days older than the window came back').toEqual([])
  }, 300_000)

  it('the response can never exceed a year of days', async () => {
    const { days } = await getMyActivity(db, { subject: SUB, tz: 'UTC' })
    // 366 for a leap year, +1 for the timezone shift at either edge.
    expect(days.length, 'the response is no longer bounded by the window').toBeLessThanOrEqual(367)
  }, 300_000)

  it('the events that DID land inside the window are counted', async () => {
    // The green path. Without it, a window that returned nothing at all would satisfy the two above —
    // and "bounded" would be indistinguishable from "broken".
    const { days } = await getMyActivity(db, { subject: SUB, tz: 'UTC' })
    const total = days.reduce((n, d) => n + d.edits, 0)
    expect(total, 'the recent work vanished — the window is measuring nothing')
      .toBeGreaterThanOrEqual(INSIDE_DAYS * EVENTS_PER_DAY)
  }, 300_000)
})
