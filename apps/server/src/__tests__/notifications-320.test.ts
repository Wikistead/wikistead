// #320 / ADR-126: watch / notifications / feed — the permission-critical read path. Real Postgres + OpenFGA +
// Fastify. Pins the ADR anti-tests: fan-out notifies watchers but never the actor; the display double-gate
// (live row + per-event FGA `view` on the MOST-SPECIFIC resource) drops an unviewable change even for a space
// watcher; watch-create is a uniform 404; member isolation; guests are 401'd.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, publishPage } from '../routes/pages.js'
import { createWatch, deleteWatch, isWatching, listNotifications, unreadCount, markNotificationRead, listFeed } from '../routes/notifications.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const storage = new LogicalStorageDriver()
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 }

let db: TenantDb
let app: FastifyInstance
let spaceId: string
let pubPage: string // a normal page A + B can view
let privPage: string // private page: only A allowlisted, B is a space viewer but NOT allowlisted
const ACTOR = 'notif-actor', A = 'notif-a', B = 'notif-b'
const cleanupTuples: { user: string; relation: string; object: string }[] = []

async function setDraftAndPublish(pageId: string, body: string, actor: string) {
  await admin`UPDATE pages SET ydoc = ${draftYdoc(body)} WHERE id = ${pageId}`
  await publishPage(db, fgaClient, driver, storage, { pageId, subject: `user:${actor}`, createdBy: `user:${actor}` })
}
function draftYdoc(text: string): Buffer {
  const d = new Y.Doc(); d.getText('content').insert(0, text)
  return Buffer.from(Y.encodeStateAsUpdate(d))
}

beforeAll(async () => {
  db = await acquireTenantDb(asTenant(TENANT))
  app = await buildApp(); await app.ready()
  const space = await createSpace(db, fgaClient, { tenantId: TENANT, userId: ACTOR, plan: 'free', name: 'Notif Space' })
  spaceId = space.id
  // A + B are space viewers (so both can be space-watchers and view the public page).
  const grants = [
    { user: `user:${A}`, relation: 'viewer', object: `space:${spaceId}` },
    { user: `user:${B}`, relation: 'viewer', object: `space:${spaceId}` },
  ]
  await writeTuples(fgaClient, grants); cleanupTuples.push(...grants)

  const p1 = await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: ACTOR, title: 'Public Doc' })
  pubPage = p1.id
  const p2 = await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: ACTOR, title: 'Private Doc' })
  privPage = p2.id
  // Link both pages to the space so `viewer from space` resolves for A/B (real pages carry page#space; these
  // direct-created drafts don't until publish, so add it explicitly for the test).
  const spaceLinks = [pubPage, privPage].map((id) => ({ user: `space:${spaceId}`, relation: 'space', object: `page:${id}` }))
  await writeTuples(fgaClient, spaceLinks); cleanupTuples.push(...spaceLinks)
  // privPage is PRIVATE, with A on the allowlist (the user:* / share_link:* pair, like setPagePrivate), B is not.
  const privTuples = [
    { user: 'user:*', relation: 'private', object: `page:${privPage}` },
    { user: 'share_link:*', relation: 'private', object: `page:${privPage}` },
    { user: `user:${A}`, relation: 'view_direct', object: `page:${privPage}` }, // A allowlisted
  ]
  await writeTuples(fgaClient, privTuples); cleanupTuples.push(...privTuples)
}, 60_000)

afterAll(async () => {
  await deleteTuples(fgaClient, cleanupTuples).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: ACTOR }).catch(() => {})
  await app.close()
  await db.release()
  await admin.end()
  await pool.end()
}, 60_000)

describe('watch write gate (#320 / ADR-126)', () => {
  it('creating a watch on a nonexistent / cross-tenant id is a UNIFORM 404 (no oracle)', async () => {
    await expect(createWatch(db, fgaClient, { tenantId: TENANT, memberSub: A, resourceType: 'page', resourceId: 'no-such-page' }))
      .rejects.toMatchObject({ statusCode: 404 })
    await expect(createWatch(db, fgaClient, { tenantId: TENANT, memberSub: A, resourceType: 'space', resourceId: 'acme_space' }))
      .rejects.toMatchObject({ statusCode: 404 }) // cross-tenant space → no RLS row → same 404
  })
  it('a non-viewer of a private page cannot watch it (same 404 as nonexistent)', async () => {
    await expect(createWatch(db, fgaClient, { tenantId: TENANT, memberSub: B, resourceType: 'page', resourceId: privPage }))
      .rejects.toMatchObject({ statusCode: 404 }) // B not allowlisted on the private page
  })
})

describe('fan-out + notifications (#320 / ADR-126)', () => {
  it('a page watcher is notified on publish; the ACTOR is never self-notified', async () => {
    await createWatch(db, fgaClient, { tenantId: TENANT, memberSub: A, resourceType: 'page', resourceId: pubPage })
    await createWatch(db, fgaClient, { tenantId: TENANT, memberSub: ACTOR, resourceType: 'page', resourceId: pubPage }) // actor also watches
    await setDraftAndPublish(pubPage, 'hello', ACTOR)
    const aInbox = await listNotifications(db, fgaClient, { memberSub: A })
    expect(aInbox.some((n) => n.pageId === pubPage && n.eventType === 'page.published')).toBe(true)
    expect(aInbox[0]!.title).toBe('Public Doc') // title resolved live, not stored
    const actorInbox = await listNotifications(db, fgaClient, { memberSub: ACTOR })
    expect(actorInbox.some((n) => n.pageId === pubPage)).toBe(false) // self-action → feed yes, notification no
  })

  it('CORRECTION 1: a private page event is gated on page#view — a space watcher without page access never sees it', async () => {
    // B watches the SPACE; A watches the space too but is allowlisted on the private page.
    await createWatch(db, fgaClient, { tenantId: TENANT, memberSub: B, resourceType: 'space', resourceId: spaceId })
    await createWatch(db, fgaClient, { tenantId: TENANT, memberSub: A, resourceType: 'space', resourceId: spaceId })
    await setDraftAndPublish(privPage, 'secret', ACTOR)
    // A (allowlisted) sees the private page's event; B (space viewer, NOT page-allowlisted) does NOT — the gate
    // ran on page#view, not space#viewer. The notification ROW exists for B (fan-out via space-watch) but the
    // display gate drops it.
    const aInbox = await listNotifications(db, fgaClient, { memberSub: A })
    expect(aInbox.some((n) => n.pageId === privPage)).toBe(true)
    const bInbox = await listNotifications(db, fgaClient, { memberSub: B })
    expect(bInbox.some((n) => n.pageId === privPage)).toBe(false) // dropped (no page#view), no title leak
    expect(bInbox.some((n) => n.title === 'Private Doc')).toBe(false)
    // the raw row DID land for B (proving the drop is a DISPLAY gate, not a fan-out skip): unread count is raw.
    expect(await unreadCount(db, { memberSub: B })).toBeGreaterThan(0)
  })

  it('revoking view makes a landed notification disappear silently (row stays); count stays raw', async () => {
    // Give B a fresh public page, watch + publish so B has a viewable notification, then revoke and re-check.
    const p = await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: ACTOR, title: 'Revoke Doc' })
    const link = { user: `space:${spaceId}`, relation: 'space', object: `page:${p.id}` }
    await writeTuples(fgaClient, [link])
    await createWatch(db, fgaClient, { tenantId: TENANT, memberSub: B, resourceType: 'page', resourceId: p.id })
    await setDraftAndPublish(p.id, 'x', ACTOR)
    expect((await listNotifications(db, fgaClient, { memberSub: B })).some((n) => n.pageId === p.id)).toBe(true)
    // Revoke B: restrict the page for B (deny wins). The notification vanishes from the list; the row remains.
    const deny = { user: `user:${B}`, relation: 'restricted', object: `page:${p.id}` }
    await writeTuples(fgaClient, [deny])
    expect((await listNotifications(db, fgaClient, { memberSub: B })).some((n) => n.pageId === p.id)).toBe(false)
    const [{ n }] = await db.sql<[{ n: number }]>`SELECT count(*)::int AS n FROM notifications WHERE member_sub = ${B}`
    expect(n).toBeGreaterThan(0) // the row is still there (inert), never a title oracle
    await deleteTuples(fgaClient, [deny, link]).catch(() => {})
  })
})

describe('member isolation + guest exclusion (#320 / ADR-126)', () => {
  it('B cannot delete A\'s watch nor mark A\'s notification (member_sub predicate → 404/false)', async () => {
    const w = await createWatch(db, fgaClient, { tenantId: TENANT, memberSub: A, resourceType: 'page', resourceId: pubPage })
    expect(await deleteWatch(db, { id: w.id, memberSub: B })).toBe(false) // not B's row
    expect(await isWatching(db, { memberSub: A, resourceType: 'page', resourceId: pubPage })).toMatchObject({ watching: true })
    const [aNotif] = await db.sql<{ id: string }[]>`SELECT id FROM notifications WHERE member_sub = ${A} LIMIT 1`
    if (aNotif) expect(await markNotificationRead(db, { id: aNotif.id, memberSub: B })).toBe(false)
  })

  it('a share-link GUEST token is 401 on /watches, /feed, /notifications (structurally excluded)', async () => {
    const tok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: 'notif-link', resource: { type: 'page', id: pubPage }, capability: 'view' })
    const H = { host: 'dev.localhost', authorization: `Bearer ${tok}` }
    for (const url of ['/watches', '/feed', '/notifications', '/notifications/unread-count']) {
      const res = await app.inject({ method: 'GET', url, headers: H })
      expect(res.statusCode, `${url} must reject a guest`).toBe(401)
    }
    const post = await app.inject({ method: 'POST', url: '/watches', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ resourceType: 'page', resourceId: pubPage }) })
    expect(post.statusCode).toBe(401)
  })

  it('a member (dev-token) can list their own empty feed/inbox over HTTP (200)', async () => {
    const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
    expect((await app.inject({ method: 'GET', url: '/feed', headers: H })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/notifications/unread-count', headers: H })).statusCode).toBe(200)
  })
})

describe('feed cross-space view filter (#320)', () => {
  it('the feed drops events on pages the caller cannot view (double gate), keeps viewable ones', async () => {
    const aFeed = await listFeed(db, fgaClient, { subject: `user:${A}` })
    // A can view pubPage + privPage (allowlisted) → both appear; ordering is recent-first.
    expect(aFeed.some((e) => e.pageId === pubPage)).toBe(true)
    const bFeed = await listFeed(db, fgaClient, { subject: `user:${B}` })
    // B cannot view privPage → its events are absent from B's feed (no title residue).
    expect(bFeed.some((e) => e.pageId === privPage)).toBe(false)
    expect(bFeed.some((e) => e.title === 'Private Doc')).toBe(false)
  })
})
