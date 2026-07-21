// #362 / ADR-126 addendum: event types, scopes/preferences, watch UI — the anti-test merge gate.
// Real Postgres + OpenFGA. Pins: mask/mute/kill-switch/subtree only NARROW emission (and a re-enabled
// event is still double-gated); the mention row is inbox-only (absent from listFeed, gated in
// listNotifications); read-all touches only the caller's rows; the revocation sweep deletes ONLY
// watchers whose view is actually gone (per-watcher FGA check); the (created_at,id) cursor pages
// monotonically where the old id-only cursor dropped rows; the watch list's titles are view-filtered.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { memberTuples, ensureMembers } from './helpers/membership.js'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage } from '../routes/pages.js'
import { createWatch, fanOutFeedEvent, fanOutMention, listFeed, listNotifications, markAllNotificationsRead, unreadCount, sweepUnviewableWatches, listWatchesResolved } from '../routes/notifications.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const TENANT = 'tenant-n362' // DEDICATED tenant: this file inserts member rows, which would shift tenant_dev's seat math (plan-freeze.test)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant

let db: TenantDb
let spaceId: string
let pageA: string // published-ish target (we pass publishedAt directly to the emitter)
let pageChild: string // child of pageA (subtree tests)
let pageOther: string // unrelated page
const ACTOR = 'n362-actor', A = 'n362-a', B = 'n362-b', C = 'n362-c'
const cleanupTuples: { user: string; relation: string; object: string }[] = []
const NOW = () => new Date()

const emitOn = (pageId: string, eventType = 'page.published') =>
  db.tx((tx) => fanOutFeedEvent(tx, { tenantId: TENANT, eventType, pageId, spaceId, actor: `user:${ACTOR}`, publishedAt: NOW() }))

const notifCount = async (sub: string) =>
  Number((await admin`SELECT count(*)::int AS n FROM notifications WHERE member_sub = ${sub}`)[0].n)

beforeAll(async () => {
  await admin`INSERT INTO tenants (id, slug, plan, isolation) VALUES (${TENANT}, ${TENANT}, 'free', 'logical') ON CONFLICT (id) DO NOTHING`
  db = await acquireTenantDb(asTenant(TENANT))
  // #445 / ADR-171: createSpace gates on tenant#space_creator — a hand-fabricated tenant must carry
  // what provisioning seeds (the production shape for every real tenant). #471 / ADR-176: that grant
  // names the tenant's MEMBERS now, so the subs acting here have to hold membership.
  const creatorSeed = { user: `tenant:${TENANT}#member`, relation: 'space_creator', object: `tenant:${TENANT}` }
  await writeTuples(fgaClient, [creatorSeed]).catch(() => {})
  await ensureMembers(TENANT, [ACTOR, A, B, C])
  cleanupTuples.push(creatorSeed)
  const space = await createSpace(db, fgaClient, { tenantId: TENANT, userId: ACTOR, plan: 'free', name: 'N362 Space' })
  spaceId = space.id
  const grants = [A, B, C].map((s) => ({ user: `user:${s}`, relation: 'viewer', object: `space:${spaceId}` }))
  await writeTuples(fgaClient, grants); cleanupTuples.push(...grants)
  pageA = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: ACTOR, title: 'N362 A' })).id
  pageChild = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: ACTOR, title: 'N362 Child' })).id
  pageOther = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: ACTOR, title: 'N362 Other' })).id
  await admin`UPDATE pages SET parent_id = ${pageA} WHERE id = ${pageChild}`
  const links = [pageA, pageChild, pageOther].map((id) => ({ user: `space:${spaceId}`, relation: 'space', object: `page:${id}` }))
  await writeTuples(fgaClient, links); cleanupTuples.push(...links)
}, 60_000)

beforeEach(async () => {
  // Each test owns its watches/notifications — wipe the members' rows (not other tests' tenants: these
  // subs are unique to this file) and reset the member prefs.
  await admin`DELETE FROM watches WHERE member_sub IN (${A}, ${B}, ${C})`
  await admin`DELETE FROM notifications WHERE member_sub IN (${A}, ${B}, ${C})`
  await admin`UPDATE members SET notifications_enabled = true, default_event_mask = '{}' WHERE sub IN (${A}, ${B}, ${C})`
})

afterAll(async () => {
  await admin`DELETE FROM watches WHERE member_sub IN (${A}, ${B}, ${C})`
  await admin`DELETE FROM notifications WHERE member_sub IN (${A}, ${B}, ${C})`
  await deleteTuples(fgaClient, cleanupTuples).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: ACTOR }).catch(() => {})
  await db.release()
  await admin`DELETE FROM tenants WHERE id = ${TENANT}`.catch(() => {}) // cascades members/watches/feed rows
  await admin.end()
  await pool.end()
}, 30_000)

// Ensure the member rows exist (fan-out LEFT JOINs members for the prefs).
beforeAll(async () => {
  for (const s of [A, B, C]) {
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${TENANT}, ${s}, ${`${s}@e2e.test`}, 'member') ON CONFLICT DO NOTHING`
  }
})

describe('emission narrowing (#362 B) — masks/mute/kill switch only ever REDUCE fan-out', () => {
  it('a watch event_mask filters other event types but keeps the masked one', async () => {
    await createWatch(db, fgaClient, { tenantId: TENANT, memberSub: A, resourceType: 'page', resourceId: pageA })
    await admin`UPDATE watches SET event_mask = ${['page.published']}::text[] WHERE member_sub = ${A}`
    await emitOn(pageA, 'comment.created')
    expect(await notifCount(A), 'masked-out type does not notify').toBe(0)
    await emitOn(pageA, 'page.published')
    expect(await notifCount(A), 'the masked-in type notifies').toBe(1)
  })

  it('mute silences fan-out; unmute restores it — and the restored event is STILL display-gated', async () => {
    await createWatch(db, fgaClient, { tenantId: TENANT, memberSub: A, resourceType: 'page', resourceId: pageA })
    await admin`UPDATE watches SET muted = true WHERE member_sub = ${A}`
    await emitOn(pageA)
    expect(await notifCount(A), 'muted watch gets nothing').toBe(0)
    await admin`UPDATE watches SET muted = false WHERE member_sub = ${A}`
    await emitOn(pageA)
    expect(await notifCount(A)).toBe(1)
    const items = await listNotifications(db, fgaClient, { memberSub: A })
    expect(items.length, 'the display double-gate still ran (viewable page → visible)').toBe(1)
  })

  it('the member kill switch (notifications_enabled=false) stops fan-out entirely', async () => {
    await createWatch(db, fgaClient, { tenantId: TENANT, memberSub: A, resourceType: 'page', resourceId: pageA })
    await admin`UPDATE members SET notifications_enabled = false WHERE sub = ${A}`
    await emitOn(pageA)
    expect(await notifCount(A)).toBe(0)
  })

  it('an empty watch mask falls back to the member default mask', async () => {
    await createWatch(db, fgaClient, { tenantId: TENANT, memberSub: A, resourceType: 'page', resourceId: pageA })
    await admin`UPDATE members SET default_event_mask = ${['comment.created']}::text[] WHERE sub = ${A}`
    await emitOn(pageA, 'page.published')
    expect(await notifCount(A), 'default mask filters publish').toBe(0)
    await emitOn(pageA, 'comment.created')
    expect(await notifCount(A), 'default mask admits comment.created').toBe(1)
  })

  it('a subtree watch on the parent matches the CHILD page event, not an unrelated page', async () => {
    await createWatch(db, fgaClient, { tenantId: TENANT, memberSub: A, resourceType: 'subtree', resourceId: pageA })
    await emitOn(pageChild)
    expect(await notifCount(A), 'descendant event notifies the subtree watcher').toBe(1)
    await emitOn(pageOther)
    expect(await notifCount(A), 'an unrelated page does not').toBe(1)
  })
})

describe('mention (#362 A) — inbox-only, never space activity', () => {
  it('a mention lands in listNotifications (gated) but never in listFeed', async () => {
    const evId = await db.tx((tx) => fanOutMention(tx, { tenantId: TENANT, pageId: pageA, spaceId, actor: `user:${ACTOR}`, recipientSubs: [A] }))
    expect(evId).toBeTruthy()
    const inbox = await listNotifications(db, fgaClient, { memberSub: A })
    expect(inbox.some((i) => i.eventType === 'mention' && i.pageId === pageA), 'mention reaches the inbox through the double gate').toBe(true)
    const feed = await listFeed(db, fgaClient, { subject: `user:${A}` })
    expect(feed.some((i) => i.eventType === 'mention'), 'mention rows are excluded from the feed').toBe(false)
  })

  it('the mention respects the member kill switch and never notifies the actor', async () => {
    await admin`UPDATE members SET notifications_enabled = false WHERE sub = ${A}`
    await db.tx((tx) => fanOutMention(tx, { tenantId: TENANT, pageId: pageA, spaceId, actor: `user:${ACTOR}`, recipientSubs: [A, ACTOR] }))
    expect(await notifCount(A)).toBe(0)
    expect(await notifCount(ACTOR)).toBe(0) // actor excluded even when listed
  })
})

describe('read-all (#362 C) — caller-scoped', () => {
  it('marks only the CALLER’s rows read', async () => {
    await createWatch(db, fgaClient, { tenantId: TENANT, memberSub: A, resourceType: 'page', resourceId: pageA })
    await createWatch(db, fgaClient, { tenantId: TENANT, memberSub: B, resourceType: 'page', resourceId: pageA })
    await emitOn(pageA)
    expect(await unreadCount(db, { memberSub: A })).toBe(1)
    expect(await unreadCount(db, { memberSub: B })).toBe(1)
    const marked = await markAllNotificationsRead(db, { memberSub: A })
    expect(marked).toBe(1)
    expect(await unreadCount(db, { memberSub: A })).toBe(0)
    expect(await unreadCount(db, { memberSub: B }), 'B untouched').toBe(1)
  })
})

describe('revocation watch sweep (#362 E1) — per-watcher FGA check', () => {
  it('deletes ONLY the watcher whose view is gone; a survivor via another path keeps their watch', async () => {
    // C's ONLY view path onto pageOther: a direct grant (space viewer would survive — so restrict C first).
    const restrict = { user: `user:${C}`, relation: 'restricted', object: `page:${pageOther}` }
    // A watches too — A's space-viewer view SURVIVES the sweep.
    await createWatch(db, fgaClient, { tenantId: TENANT, memberSub: A, resourceType: 'page', resourceId: pageOther })
    await createWatch(db, fgaClient, { tenantId: TENANT, memberSub: C, resourceType: 'page', resourceId: pageOther })
    await writeTuples(fgaClient, [restrict]) // C loses view (restricted subtracts)
    try {
      const swept = await sweepUnviewableWatches(db, fgaClient, [pageOther])
      expect(swept, 'exactly the lost watcher swept').toBe(1)
      const remaining = await admin`SELECT member_sub FROM watches WHERE resource_id = ${pageOther}`
      expect(remaining.map((r) => r.member_sub)).toEqual([A])
    } finally {
      await deleteTuples(fgaClient, [restrict]).catch(() => {})
    }
  })
})

describe('monotonic cursor (#362 E2)', () => {
  it('pages the feed on (created_at,id) — ids that sort AGAINST time no longer drop rows', async () => {
    // Three events whose id lexicographic order CONTRADICTS their created_at order.
    const rows = [
      { id: 'n362-zzz', at: '2000-01-01T00:00:00Z' }, // oldest, biggest id
      { id: 'n362-mmm', at: '2000-01-02T00:00:00Z' },
      { id: 'n362-aaa', at: '2000-01-03T00:00:00Z' }, // newest, smallest id
    ]
    for (const r of rows) {
      await admin`INSERT INTO feed_events (id, tenant_id, event_type, page_id, space_id, actor, created_at)
        VALUES (${r.id}, ${TENANT}, 'page.published', ${pageA}, ${spaceId}, ${'user:' + ACTOR}, ${r.at})`
    }
    try {
      // Other tests' events (same space, newer timestamps) interleave — walk limit-1 pages to the end
      // and collect ONLY the planted rows; the tuple cursor must yield each exactly once, newest-first.
      const seen: string[] = []
      let before: string | null = null
      for (let i = 0; i < 40; i++) {
        const page = await listFeed(db, fgaClient, { subject: `user:${A}`, spaceId, before, limit: 1 })
        if (!page.length) break
        seen.push(...page.filter((p) => p.id.startsWith('n362-')).map((p) => p.id))
        before = page[page.length - 1]!.id
      }
      expect(seen).toEqual(['n362-aaa', 'n362-mmm', 'n362-zzz']) // every row exactly once, newest-first
    } finally {
      await admin`DELETE FROM feed_events WHERE id LIKE 'n362-%'`
    }
  })
})

describe('watch list resolution (#362 C) — view-filtered titles', () => {
  it('a viewable target resolves its title; a non-viewable one is untitled/inert (no oracle)', async () => {
    await createWatch(db, fgaClient, { tenantId: TENANT, memberSub: C, resourceType: 'page', resourceId: pageA })
    const restrict = { user: `user:${C}`, relation: 'restricted', object: `page:${pageA}` }
    let list = await listWatchesResolved(db, fgaClient, { memberSub: C })
    expect(list.find((w) => w.resourceId === pageA)?.title).toBe('N362 A')
    await writeTuples(fgaClient, [restrict]) // view revoked AFTER the watch existed
    try {
      list = await listWatchesResolved(db, fgaClient, { memberSub: C })
      const w = list.find((x) => x.resourceId === pageA)
      expect(w, 'the row survives (unwatch stays possible)').toBeTruthy()
      expect(w!.title, 'but the title is view-filtered away').toBeNull()
    } finally {
      await deleteTuples(fgaClient, [restrict]).catch(() => {})
    }
  })
})
