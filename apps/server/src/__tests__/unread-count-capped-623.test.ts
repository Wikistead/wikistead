// #623: the unread badge counted every unread row a member had ever accumulated.
//
// The screen has stopped at 99 since #320 — `NotificationBell` renders "99+" above it. So the rows past
// the hundredth were being scanned to produce a figure nobody is shown, on a query the bell polls.
//
// Two things are pinned, and the second is the one that keeps this honest: the count is capped, AND the
// cap is above every number the badge prints exactly. A cap of, say, 10 would also make the sweep happy
// while turning a real "37 unread" into "10".
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { unreadCount, UNREAD_BADGE_CAP } from '../routes/notifications.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SUB = `uc623-${STAMP}`
// comfortably past the cap, so "capped" and "counted them all" give different answers
const N = UNREAD_BADGE_CAP + 25

let tenant: Tenant
let db: TenantDb
let eventId: string

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  // Rows written straight in: what is measured is the counting, not the fan-out that produces them.
  // `feed_events` is the parent, so one event carries every notification in this fixture.
  const [ev] = await admin<{ id: string }[]>`
    INSERT INTO feed_events (tenant_id, event_type, actor, page_id)
    VALUES (${tenant.id}, 'page.published', ${`user:${SUB}`}, NULL) RETURNING id`
  eventId = ev!.id
  for (let i = 0; i < N; i++) {
    await admin`
      INSERT INTO notifications (tenant_id, event_id, member_sub, read_at)
      VALUES (${tenant.id}, ${eventId}, ${SUB}, NULL)`
  }
}, 180_000)

afterAll(async () => {
  await admin`DELETE FROM notifications WHERE member_sub = ${SUB}`.catch(() => {})
  await admin`DELETE FROM feed_events WHERE id = ${eventId}`.catch(() => {})
  await db.release()
  await pool.end()
  await admin.end()
}, 180_000)

describe('#623: the unread badge stops counting where the screen stops', () => {
  it('does not count past the cap, however many rows there are', async () => {
    const n = await unreadCount(db, { memberSub: SUB })
    expect(n, `the fixture holds ${N} unread rows and the count came back ${n}`).toBeLessThanOrEqual(UNREAD_BADGE_CAP + 1)
  }, 180_000)

  it('still says "there are more than the badge prints"', async () => {
    // A cap that clamped to exactly 99 would make the bell show "99" for a member with thousands. The
    // extra one is what lets the screen say "99+".
    expect(await unreadCount(db, { memberSub: SUB })).toBe(UNREAD_BADGE_CAP + 1)
  }, 180_000)

  it('the cap is the number the bell already refuses to print past', async () => {
    // The two must move together. This reads the component rather than restating the constant, so
    // lowering one alone fails here instead of quietly showing a wrong number.
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const bell = readFileSync(
      resolve(import.meta.dirname, '../../../../apps/web/src/notifications/NotificationBell.tsx'), 'utf8')
    const m = /count\s*>\s*(\d+)\s*\?\s*"(\d+)\+"/.exec(bell)
    expect(m, 'the bell no longer renders an "N+" badge — re-aim this pin at whatever replaced it').toBeTruthy()
    expect(Number(m![1]), 'the screen prints exact numbers past the cap the server will count to')
      .toBe(UNREAD_BADGE_CAP)
    expect(Number(m![2]), 'and the "+" wording names the same number').toBe(UNREAD_BADGE_CAP)
  }, 180_000)

  it('a member under the cap still gets the exact number', async () => {
    // The cap must not become the answer. Without this, clamping everything to 100 would pass above.
    const few = `${SUB}-few`
    for (let i = 0; i < 3; i++) {
      await admin`INSERT INTO notifications (tenant_id, event_id, member_sub, read_at)
                  VALUES (${tenant.id}, ${eventId}, ${few}, NULL)`
    }
    try {
      expect(await unreadCount(db, { memberSub: few })).toBe(3)
    } finally {
      await admin`DELETE FROM notifications WHERE member_sub = ${few}`.catch(() => {})
    }
  }, 180_000)
})
