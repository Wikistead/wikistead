// Integration test — real Postgres + OpenFGA + Fastify, no mocks. ADR-180 personal activity heatmap.
// SELF-SCOPE is the security boundary and is enforced TWICE:
//   - the endpoint has NO "whose activity" parameter — the subject is the session sub (req.user.sub),
//   - the query filters on that sub (`created_by = 'user:'||sub` / `author_sub = sub`) on the tenant RLS
//     handle, so one member's counts can never include another member's (or another tenant's) rows.
// Also pinned: soft-deleted comments are excluded, an empty history returns an empty grid (not an error),
// and day buckets follow the caller's timezone.
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

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const tag = Date.now().toString(36)
const SUB_A = `heat-a-${tag}`
const SUB_B = `heat-b-${tag}`
const SUB_TZ = `heat-tz-${tag}`
const SUB_EMPTY = `heat-empty-${tag}`
const YDOC = Buffer.from([0])

let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string
let threadId: string
let today: string

const dayMinus = (n: number): string => {
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}
// Seed a revision authored by `sub` on a given UTC calendar day (noon UTC, far from any midnight boundary).
const seedRev = (sub: string, day: string, hhmm = '12:00:00') =>
  admin`INSERT INTO revisions (tenant_id, page_id, ydoc, title, created_by, created_at)
        VALUES (${tenant.id}, ${pageId}, ${YDOC}, 't', ${'user:' + sub}, ${`${day} ${hhmm}+00`}::timestamptz)`
const seedComment = (sub: string, day: string, deleted = false) =>
  admin`INSERT INTO comments (tenant_id, thread_id, body, author_sub, created_at, deleted_at)
        VALUES (${tenant.id}, ${threadId}, 'c', ${sub}, ${`${day} 12:00:00+00`}::timestamptz,
                ${deleted ? `${day} 13:00:00+00` : null}::timestamptz)`

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `heatmap-${tag}` })
  spaceId = space.id
  const page = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: `heatmap-page-${tag}` })
  pageId = page.id
  const [{ id: tid }] = await admin<[{ id: string }]>`
    INSERT INTO comment_threads (tenant_id, page_id, created_by) VALUES (${tenant.id}, ${pageId}, ${'user:' + SUB_A}) RETURNING id`
  threadId = tid
  const [{ d }] = await admin<[{ d: string }]>`SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS d`
  today = d

  // A: two revisions + one comment on day-3, one revision on day-10, one SOFT-DELETED comment on day-3.
  await seedRev(SUB_A, dayMinus(3))
  await seedRev(SUB_A, dayMinus(3))
  await seedRev(SUB_A, dayMinus(10))
  await seedComment(SUB_A, dayMinus(3))
  await seedComment(SUB_A, dayMinus(3), true) // excluded (retracted)
  // B (another member): activity on the SAME day — must never appear in A's heatmap.
  await seedRev(SUB_B, dayMinus(3))
  await seedComment(SUB_B, dayMinus(3))
}, 40_000)

afterAll(async () => {
  await admin`DELETE FROM comments WHERE author_sub IN (${SUB_A}, ${SUB_B}, ${SUB_TZ})`.catch(() => {})
  await admin`DELETE FROM revisions WHERE created_by IN (${'user:' + SUB_A}, ${'user:' + SUB_B}, ${'user:' + SUB_TZ})`.catch(() => {})
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end()
  await admin.end()
}, 40_000)

describe('GET /me/activity — getMyActivity (ADR-180)', () => {
  it('counts the caller\'s OWN revisions + comments per day, excluding soft-deleted comments', async () => {
    const { days } = await getMyActivity(db, { subject: SUB_A, tz: 'UTC' })
    const byDay = new Map(days.map((x) => [x.day, x]))
    expect(byDay.get(dayMinus(3))?.count).toBe(3) // 2 revisions + 1 live comment (the retracted one is NOT counted)
    expect(byDay.get(dayMinus(10))?.count).toBe(1) // 1 revision
    // #483 the per-kind split the tooltip breakdown reads — and it must SUM to the count
    // (a drifting split would silently lie in the tooltip).
    expect(byDay.get(dayMinus(3))?.edits).toBe(2)
    expect(byDay.get(dayMinus(3))?.comments).toBe(1) // the soft-deleted comment is excluded here too
    expect(byDay.get(dayMinus(10))?.edits).toBe(1)
    expect(byDay.get(dayMinus(10))?.comments).toBe(0)
    for (const d of days) expect(d.edits + d.comments, `${d.day} split sums to count`).toBe(d.count)
  })

  it('is SELF-SCOPED — another member\'s activity on the same day never leaks in', async () => {
    const a = await getMyActivity(db, { subject: SUB_A, tz: 'UTC' })
    const b = await getMyActivity(db, { subject: SUB_B, tz: 'UTC' })
    // A's day-3 count is 3 (only A's rows); B, seeded with 1 rev + 1 comment on the same day, sees 2.
    expect(new Map(a.days.map((x) => [x.day, x.count])).get(dayMinus(3))).toBe(3)
    expect(new Map(b.days.map((x) => [x.day, x.count])).get(dayMinus(3))).toBe(2)
    // …and the totals are disjoint: A's total excludes every B row and vice-versa.
    expect(a.days.reduce((s, x) => s + x.count, 0)).toBe(4) // 3 + 1
    expect(b.days.reduce((s, x) => s + x.count, 0)).toBe(2)
    // #483 the split is self-scoped exactly like the total — B's kinds never bleed into A's.
    const a3 = a.days.find((x) => x.day === dayMinus(3))!
    const b3 = b.days.find((x) => x.day === dayMinus(3))!
    expect([a3.edits, a3.comments]).toEqual([2, 1])
    expect([b3.edits, b3.comments]).toEqual([1, 1])
  })

  it('an empty history returns an empty grid, not an error', async () => {
    const { days } = await getMyActivity(db, { subject: SUB_EMPTY, tz: 'UTC' })
    expect(days).toEqual([])
  })

  it('buckets by the caller\'s timezone (a 23:30 UTC event lands on the next day in Asia/Tokyo)', async () => {
    const day = dayMinus(5)
    await seedRev(SUB_TZ, day, '23:30:00') // 23:30 UTC → 08:30 next-day JST
    const utc = await getMyActivity(db, { subject: SUB_TZ, tz: 'UTC' })
    const jst = await getMyActivity(db, { subject: SUB_TZ, tz: 'Asia/Tokyo' })
    expect(utc.days.map((x) => x.day)).toEqual([day])
    const next = new Date(`${day}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1)
    expect(jst.days.map((x) => x.day)).toEqual([next.toISOString().slice(0, 10)])
  })

  it('an unknown timezone falls back to UTC (no error)', async () => {
    const { tz, days } = await getMyActivity(db, { subject: SUB_A, tz: 'Not/AZone' })
    expect(tz).toBe('UTC')
    expect(days.length).toBeGreaterThan(0)
  })
})
