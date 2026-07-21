// #326 / ADR-142 Addendum 2: the patrol QUEUE — abuse refusals become feed flags, and the space
// patrol listing shows the supply the ruling named (abuse events + anonymous/share-link activity).
//
// What is permission-critical here, and therefore anti-tested rather than merely tested:
//   - a flag is a TYPE and an actor, never content: no draft text, no matched word, no ratio;
//   - flags never fan out notifications (patrol is a pull surface — amplifying a vandal's refusals
//     into members' bells would be its own abuse vector);
//   - a refusal on a NEVER-PUBLISHED page is still flagged (the fanOutFeedEvent path would have
//     swallowed it on the publishedAt guard — the reason the emit helper is insert-only);
//   - hammering a refusal inside the throttle window yields ONE flag, not one per attempt;
//   - the listing narrows the shared feed and never widens it: a page the caller cannot view stays
//     absent, and ordinary member activity is not in the patrol supply at all.
// Real Postgres + OpenFGA.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, publishPage } from '../routes/pages.js'
import { recordAbuseFlag, listPatrol, listFeed } from '../routes/notifications.js'
import { buildApp } from '../app.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import type { FastifyInstance } from 'fastify'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const storage = new LogicalStorageDriver()
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const ydoc = (t: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, t); return d })()))
const RUN = Date.now().toString(36)
const OWNER = `pf-owner-${RUN}`, MOD = `pf-mod-${RUN}`, OUTSIDER = `pf-out-${RUN}`
const GUEST = `guest:pf-link-${RUN}`

let db!: TenantDb, spaceId!: string, openPage!: string, privPage!: string, draftPage!: string
let app!: FastifyInstance
const pageIds: string[] = []
const tuples: { user: string; relation: string; object: string }[] = []

// A tiny in-memory stand-in for the Valkey calls recordAbuseFlag makes. `SET NX EX` returns "OK" the
// first time a key is seen and null afterwards — which is the whole throttle.
function fakeValkey() {
  const keys = new Set<string>()
  return {
    calls: 0,
    async set(key: string, _v: string, _ex: string, _s: number, nx: string) {
      this.calls++
      if (nx !== 'NX') return "OK"
      if (keys.has(key)) return null
      keys.add(key)
      return "OK"
    },
  }
}

beforeAll(async () => {
  await driver.ensureIndex(); await storage.ensureBucket()
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'free', name: `patrolflags-${RUN}` })).id
  const g = [{ user: `user:${MOD}`, relation: 'manager', object: `space:${spaceId}` }]
  await writeTuples(fgaClient, g); tuples.push(...g)

  openPage = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: OWNER, title: `PF Open ${RUN}` })).id
  privPage = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: OWNER, title: `PF Private ${RUN}` })).id
  draftPage = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: OWNER, title: `PF Draft ${RUN}` })).id
  pageIds.push(openPage, privPage, draftPage)

  // openPage is published (ordinary member activity — the control for "not patrol supply")
  await admin`UPDATE pages SET ydoc = ${ydoc('# open body')} WHERE id = ${openPage}`
  await publishPage(db, fgaClient, driver, storage, { pageId: openPage, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })

  // privPage is strict-private: the marker pair cuts space inheritance, so MOD (a space manager)
  // cannot view it — the display gate must drop its flag even though MOD may patrol the space.
  const pv = [
    { user: 'user:*', relation: 'private', object: `page:${privPage}` },
    { user: 'share_link:*', relation: 'private', object: `page:${privPage}` },
  ]
  await writeTuples(fgaClient, pv); tuples.push(...pv)
  // draftPage stays UNPUBLISHED on purpose (the first-publish-rejection case).
}, 60_000)

afterAll(async () => {
  await deleteTuples(fgaClient, tuples).catch(() => {})
  for (const id of pageIds) {
    await admin`DELETE FROM patrolled_events WHERE feed_event_id IN (SELECT id FROM feed_events WHERE page_id = ${id})`.catch(() => {})
    await admin`DELETE FROM feed_events WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM revisions WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM pages WHERE id = ${id}`.catch(() => {})
  }
  await admin`DELETE FROM feed_events WHERE space_id = ${spaceId}`.catch(() => {})
  // The throwaway member this run mints is tenant state, not space state: leaving it behind changes
  // "who is the newest member" for every seat-cap test that runs later.
  await admin`DELETE FROM members WHERE tenant_id = ${TENANT} AND sub = ${OUTSIDER}`.catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await app.close()
  await db.release(); await admin.end(); await pool.end()
}, 60_000)

const flagsFor = (pageId: string) =>
  admin<{ event_type: string; actor: string; space_id: string | null }[]>`
    SELECT event_type, actor, space_id FROM feed_events WHERE page_id = ${pageId} AND event_type LIKE 'abuse.%'`

describe('abuse flags feed the patrol queue (#326 / ADR-142 Addendum 2)', () => {
  it('one refusal writes exactly one flag, carrying a type and an actor and nothing else', async () => {
    const vk = fakeValkey()
    const wrote = await recordAbuseFlag(vk as never, db, {
      tenantId: TENANT, eventType: 'abuse.publish_rejected_banned', pageId: openPage, spaceId, actor: `user:${OUTSIDER}`, authorize: async () => true,
    })
    expect(wrote).toBe(true)
    const rows = await flagsFor(openPage)
    expect(rows.length).toBe(1)
    expect(rows[0]!.event_type).toBe('abuse.publish_rejected_banned')
    expect(rows[0]!.actor).toBe(`user:${OUTSIDER}`)
    // ANTI-TEST: the row's columns are the whole payload. There is nowhere for content to hide, and
    // the schema gained nothing — so a future "just add the matched word" needs a migration and a
    // ruling, not a quiet edit here.
    const cols = await admin<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'feed_events' ORDER BY column_name`
    expect(cols.map((c) => c.column_name)).toEqual(['actor', 'created_at', 'event_type', 'id', 'page_id', 'space_id', 'tenant_id'])
  })

  it('ANTI-TEST: a flag never becomes a notification (patrol is pull-only)', async () => {
    const before = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM notifications`
    const vk = fakeValkey()
    await recordAbuseFlag(vk as never, db, {
      tenantId: TENANT, eventType: 'abuse.rate_capped_publish', pageId: openPage, spaceId, actor: GUEST, authorize: async () => true,
    })
    const after = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM notifications`
    expect(after[0]!.n, 'no bell rings for a refusal').toBe(before[0]!.n)
  })

  it('a refusal on a NEVER-PUBLISHED page is still flagged (the publishedAt guard would have eaten it)', async () => {
    const [p] = await admin<{ published_at: Date | null }[]>`SELECT published_at FROM pages WHERE id = ${draftPage}`
    expect(p!.published_at, 'fixture sanity: this page was never published').toBeNull()
    const vk = fakeValkey()
    await recordAbuseFlag(vk as never, db, {
      tenantId: TENANT, eventType: 'abuse.publish_rejected_mass_delete', pageId: draftPage, spaceId, actor: GUEST, authorize: async () => true,
    })
    const rows = await flagsFor(draftPage)
    expect(rows.length, 'the first-publish rejection is exactly the signature patrol needs').toBe(1)
  })

  it('ANTI-TEST: hammering inside the window yields ONE flag, not one per attempt', async () => {
    const vk = fakeValkey()
    const results: boolean[] = []
    for (let i = 0; i < 8; i++) {
      results.push(await recordAbuseFlag(vk as never, db, {
        tenantId: TENANT, eventType: 'abuse.rate_capped_create', pageId: null, spaceId, actor: GUEST, authorize: async () => true,
      }))
    }
    expect(results.filter(Boolean).length, 'first attempt writes, the rest are throttled').toBe(1)
    const rows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM feed_events WHERE space_id = ${spaceId} AND event_type = 'abuse.rate_capped_create'`
    expect(rows[0]!.n, 'the rate limiter must not become a feed amplifier').toBe(1)
  })

  it('a create-cap flag carries the space only — there is no page yet', async () => {
    const rows = await admin<{ page_id: string | null; space_id: string | null }[]>`
      SELECT page_id, space_id FROM feed_events WHERE space_id = ${spaceId} AND event_type = 'abuse.rate_capped_create'`
    expect(rows[0]!.page_id).toBeNull()
    expect(rows[0]!.space_id).toBe(spaceId)
  })
})

describe('the patrol listing shows the supply, and only what the caller may view', () => {
  it('lists abuse flags and guest activity for a manager', async () => {
    const items = await listPatrol(db, fgaClient, { subject: `user:${MOD}`, spaceId })
    const types = items.map((i) => i.eventType)
    expect(types, 'the refusals are here').toContain('abuse.publish_rejected_banned')
    expect(types).toContain('abuse.rate_capped_create')
  })

  it('ANTI-TEST: ordinary member activity is not patrol supply', async () => {
    const patrol = await listPatrol(db, fgaClient, { subject: `user:${MOD}`, spaceId })
    expect(patrol.map((i) => i.eventType), 'a normal publish is activity, not a flag').not.toContain('page.published')
    // …while the shared feed, which the same person can also read, does carry it — proving the
    // narrowing happens in the patrol query and not by hiding events from the member.
    const feed = await listFeed(db, fgaClient, { subject: `user:${MOD}`, spaceId })
    expect(feed.map((i) => i.eventType)).toContain('page.published')
  })

  it('ANTI-TEST: a flag on a page the caller cannot view never appears', async () => {
    const vk = fakeValkey()
    await recordAbuseFlag(vk as never, db, {
      tenantId: TENANT, eventType: 'abuse.publish_rejected_banned', pageId: privPage, spaceId, actor: GUEST, authorize: async () => true,
    })
    const [row] = await flagsFor(privPage)
    expect(row, 'the flag really was written — the row exists, the display drops it').toBeTruthy()
    const items = await listPatrol(db, fgaClient, { subject: `user:${MOD}`, spaceId })
    expect(items.some((i) => i.pageId === privPage), 'a space manager cut off from the page sees no flag for it').toBe(false)
    // the creator, who can still view it, does see it — so the row is genuinely reachable and the
    // previous assertion is about permission, not about the row being absent.
    const ownerItems = await listPatrol(db, fgaClient, { subject: `user:${OWNER}`, spaceId })
    expect(ownerItems.some((i) => i.pageId === privPage)).toBe(true)
  })

  it('unpatrolledOnly narrows to what has not been reviewed', async () => {
    const all = await listPatrol(db, fgaClient, { subject: `user:${OWNER}`, spaceId })
    expect(all.length).toBeGreaterThan(0)
    const target = all[0]!
    await admin`INSERT INTO patrolled_events (tenant_id, feed_event_id, patrolled_by) VALUES (${TENANT}, ${target.id}, ${OWNER})
                ON CONFLICT DO NOTHING`
    const left = await listPatrol(db, fgaClient, { subject: `user:${OWNER}`, spaceId, unpatrolledOnly: true })
    expect(left.some((i) => i.id === target.id), 'a reviewed flag leaves the queue').toBe(false)
    const still = await listPatrol(db, fgaClient, { subject: `user:${OWNER}`, spaceId })
    expect(still.some((i) => i.id === target.id), 'but it is still there without the filter').toBe(true)
  })
})

// The ROUTE, over HTTP. The helper tests above cannot see whether anything calls it, and the write
// path is where this feature broke once already: a fire-and-forget insert ran after the response, by
// which time the tenant connection was released and RLS refused the row — silently.
describe('the patrol route and the 422 wiring, over HTTP', () => {
  // No content-type: these POSTs carry no body, and declaring JSON with an empty body is a 400.
  const devHeaders = { host: 'dev.localhost', authorization: 'Bearer dev-token' }

  it('a 422-rejected publish leaves a flag — recorded before the response, not after it', async () => {
    // dev-user owns the demo fixtures; give them a page in this space and a policy that refuses it.
    const page = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: `PF 422 ${RUN}` })).id
    pageIds.push(page)
    await admin`UPDATE pages SET ydoc = ${ydoc('clean starting text')} WHERE id = ${page}`
    await publishPage(db, fgaClient, driver, storage, { pageId: page, subject: 'user:dev-user', createdBy: 'user:dev-user' })
    await admin`UPDATE pages SET ydoc = ${ydoc('clean starting text plus pfspamword326')} WHERE id = ${page}`
    await admin`UPDATE tenant_settings SET abuse_banned_words = ${['pfspamword326']} WHERE tenant_id = ${TENANT}`
    try {
      const r = await app.inject({ method: 'POST', url: `/pages/${page}/publish`, headers: devHeaders })
      expect(r.statusCode, r.body).toBe(422)
      const rows = await admin<{ event_type: string; actor: string }[]>`
        SELECT event_type, actor FROM feed_events WHERE page_id = ${page} AND event_type LIKE 'abuse.%'`
      expect(rows.length, 'the refusal is in the queue by the time the caller has their 422').toBe(1)
      expect(rows[0]!.event_type).toBe('abuse.publish_rejected_banned')
      expect(rows[0]!.actor).toBe('user:dev-user')
    } finally {
      await admin`UPDATE tenant_settings SET abuse_banned_words = '{}' WHERE tenant_id = ${TENANT}`
    }
  })

  it('GET /spaces/:id/patrol answers a moderator and refuses a plain member', async () => {
    // A plain member of the tenant — NOT an admin, so none of the tenant-admin implications apply.
    await admin`INSERT INTO members (tenant_id, sub, email, display_name, role)
                VALUES (${TENANT}, ${OUTSIDER}, ${OUTSIDER + '@x.test'}, 'Outsider', 'member')
                ON CONFLICT (tenant_id, sub) DO NOTHING`
    const sid = await createSession(app.valkey, { tenantId: TENANT, sub: OUTSIDER, role: 'member' })
    const memberHeaders = { host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${sid}` }
    const denied = await app.inject({ method: 'GET', url: `/spaces/${spaceId}/patrol`, headers: memberHeaders })
    expect(denied.statusCode, 'no moderation capability, no queue').toBe(403)

    // grant MODERATE only (never manage): a moderator must be able to open the queue they may mark.
    const mod = [{ user: `user:${OUTSIDER}`, relation: 'moderator', object: `space:${spaceId}` }]
    await writeTuples(fgaClient, mod); tuples.push(...mod)
    const ok = await app.inject({ method: 'GET', url: `/spaces/${spaceId}/patrol`, headers: memberHeaders })
    expect(ok.statusCode, 'a moderator opens it — the write gate asks for moderate too').toBe(200)
    expect(Array.isArray(ok.json())).toBe(true)
  })

  it('ANTI-TEST: a refusal never writes into a space the actor has no rights to', async () => {
    // The caps fire before the gate that would authorize the action, so the flag path carries its own
    // authorization. Without it, a token minted for one space could plant rows in another space's
    // moderation queue — a write into an authz-gated surface by someone with no rights to it.
    const before = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM feed_events WHERE space_id = ${spaceId}`
    const wrote = await recordAbuseFlag(null, db, {
      tenantId: TENANT, eventType: 'abuse.rate_capped_create', pageId: null, spaceId,
      actor: 'anon:intruder', authorize: async () => false,
    })
    expect(wrote, 'refused: no rights, no row').toBe(false)
    const after = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM feed_events WHERE space_id = ${spaceId}`
    expect(after[0]!.n, 'the queue is unchanged').toBe(before[0]!.n)
  })

  it('a rotated guest session cannot multiply flags on the same link', async () => {
    // The session pseudonym is the actor, and a guest may re-exchange their token for a new one at
    // will. A per-session throttle alone would let them write a row per rotation; the link-scoped key
    // is what makes the window hold.
    const vk = fakeValkey()
    const link = `pf-link-rot-${RUN}`
    const first = await recordAbuseFlag(vk as never, db, {
      tenantId: TENANT, eventType: 'abuse.rate_capped_publish', pageId: openPage, spaceId,
      actor: 'anon:session-one', linkId: link, authorize: async () => true,
    })
    const second = await recordAbuseFlag(vk as never, db, {
      tenantId: TENANT, eventType: 'abuse.rate_capped_publish', pageId: openPage, spaceId,
      actor: 'anon:session-two', linkId: link, authorize: async () => true,
    })
    expect(first).toBe(true)
    expect(second, 'a fresh session on the same link is the same flood').toBe(false)
  })

  it('a space moderator is reported as such, without being handed manage', async () => {
    // The web settings shell admits a moderator so they can reach their queue; it must not mistake
    // them for a manager, or a moderator would get rename and delete along with it.
    const r = await app.inject({ method: 'GET', url: '/spaces', headers: { host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${await createSession(app.valkey, { tenantId: TENANT, sub: OUTSIDER, role: 'member' })}` } })
    expect(r.statusCode).toBe(200)
    const mine = (r.json() as { id: string; capability: string; canModerate?: boolean }[]).find((s) => s.id === spaceId)
    expect(mine, 'the space is visible to the moderator').toBeTruthy()
    expect(mine!.canModerate, 'reported as a moderator').toBe(true)
    expect(mine!.capability, 'but NOT as a manager').not.toBe('manage')
  })

  it('ANTI-TEST: a guest token cannot reach the patrol queue at all', async () => {
    const r = await app.inject({ method: 'GET', url: `/spaces/${spaceId}/patrol`, headers: { host: 'dev.localhost' } })
    expect([401, 403], `unauthenticated must not read the queue (got ${r.statusCode})`).toContain(r.statusCode)
  })
})
