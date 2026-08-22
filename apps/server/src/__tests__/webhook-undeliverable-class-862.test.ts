// #862 / ADR-108 addendum §G: three event types were enqueued and then never delivered, by
// construction.
//
// The webhook drain asks `pageEventDisposition` at DELIVERY time — may this page be spoken of — and
// for almost everything that is the right moment, because the answer can change between the act and
// the delivery and the later answer is the safer one. For three types the act itself destroys what
// answers the question:
//
//   page.deleted        the purge removes every tuple for the page and emits afterwards, so the read
//                       finds nothing and answers `not-ready` — six retries over 930 s, then dropped
//   page.made_private   the marker is written first, so the answer is `suppress`, always
//   share_link.revoked  on the privatise path and on a move INTO a private ancestor, the same: the
//                       page is hidden by the time the event about its links is examined
//
// The consumer that most wants these hears none of them, and the privatise path says so out loud —
// the comment beside that emit reads "a consumer mirroring access has to hear about the ones that
// went". These walk the real operations and read what Postgres holds.
//
// ⚠️ What is NOT changed is which pages may be spoken of. The same predicate decides, at the last
// moment it has an answer; a page that was private or an unpublished draft before the act still
// settles as `suppress`, and the drain still deletes it unsent. That case is the second half of every
// walk here — a fix that delivered everything would pass the first half alone.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, setPagePrivate, movePage } from '../routes/pages.js'
import { createShareLink } from '../routes/share-links.js'
import { drainWebhookOutbox, createWebhook } from '../routes/webhooks.js'
import { buildApp } from '../app.js'
import type { FastifyInstance } from 'fastify'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
let tenant: Tenant, db: TenantDb, spaceId: string, hookId: string, app: FastifyInstance

interface Row { id: string; event_type: string; settled_disposition: string | null; attempts: number }
// The blocked hook's failure counter is the only thing that separates "delivered" from "handled":
// a row the drain suppresses or retries never reaches `guardedFetch`, so the count does not move.
async function hookFailures(): Promise<number> {
  const [h] = await admin<{ failure_count: number }[]>`SELECT failure_count FROM webhooks WHERE id = ${hookId}`
  return h!.failure_count
}

const rowsFor = (type: string) =>
  admin<Row[]>`SELECT id, event_type, settled_disposition, attempts FROM webhook_outbox
               WHERE tenant_id = ${tenant.id} AND event_type = ${type}`

// The bridge enqueues from the in-process bus, which `emit` hands off through a resolved promise.
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 25)) }

/** A page the world can already see: published and linked to its space, no private marker. */
async function visiblePage(title: string): Promise<string> {
  const id = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title })).id
  await admin`UPDATE pages SET published_at = now() WHERE id = ${id}`
  await writeTuples(fgaClient, [{ user: `space:${spaceId}`, relation: 'space', object: `page:${id}` }])
  return id
}

/** A page nobody outside was ever told about: an unpublished draft, no `page#space` link. */
async function draftPage(title: string): Promise<string> {
  return (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title })).id
}

beforeAll(async () => {
  // ⚠️ The bridge subscribes to the event bus inside `buildApp` and nowhere else (#862 the third
  // finding). A walk that calls the page functions directly emits into a bus with no listener and
  // measures nothing at all — which is how this file first ran, green on zero rows.
  app = await buildApp()
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'g862-space' })).id
  // An SSRF-blocked hook: a row the drain decides to DELIVER attempts it, fails, and comes back with
  // attempts = 1. A row it suppresses is deleted where it stands. Without a hook the two are
  // indistinguishable — both end with the row gone — which is the whole thing being measured.
  hookId = (await createWebhook(db, { tenantId: tenant.id, plan: 'business', userId: 'dev-user', url: 'https://127.0.0.1/blocked-862', eventFilter: null })).id
  await admin`DELETE FROM webhook_outbox`
}, 120_000)

afterAll(async () => {
  await admin`DELETE FROM webhooks WHERE id = ${hookId}`.catch(() => {})
  await admin`DELETE FROM webhook_outbox WHERE tenant_id = ${tenant.id}`.catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await app.close(); await db.release(); await pool.end(); await admin.end()
}, 120_000)

describe('#862 §G — a purge', () => {
  it('settles a visible page as deliverable, and the drain delivers it instead of retrying it away', async () => {
    await admin`DELETE FROM webhook_outbox WHERE tenant_id = ${tenant.id}`
    const pageId = await visiblePage('g862 purge visible')
    await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }) // the permanent path (physicalDeletePage)
    await settle()
    const [row] = await rowsFor('page.deleted')
    expect(row, 'the purge enqueued a page.deleted').toBeTruthy()
    expect(row!.settled_disposition, 'the answer was taken before the tuples went').toBe('deliver')
    // ⚠️ `handled` counts a suppression and a retry too, so it cannot tell delivery from refusal —
    // measured: ignoring the settled answer left this assertion green. The hook's failure counter only
    // moves when a POST was actually attempted, which is the thing that had never happened.
    const before = await hookFailures()
    await admin`UPDATE webhooks SET active = TRUE WHERE id = ${hookId}`
    expect(await drainWebhookOutbox(fgaClient)).toBeGreaterThan(0)
    expect(await hookFailures(), 'the row was DELIVERED (to a blocked URL, which fails) — not retried away').toBeGreaterThan(before)
  }, 120_000)

  it('⚠️ and settles a never-published draft as suppress — existence-hiding is unchanged', async () => {
    await admin`DELETE FROM webhook_outbox WHERE tenant_id = ${tenant.id}`
    const pageId = await draftPage('g862 purge draft')
    await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }) // the permanent path (physicalDeletePage)
    await settle()
    const [row] = await rowsFor('page.deleted')
    expect(row, 'the row is still written; it is the delivery that is refused').toBeTruthy()
    expect(row!.settled_disposition, 'nobody outside was ever told this page existed').toBe('suppress')
    await drainWebhookOutbox(fgaClient)
    const after = await rowsFor('page.deleted')
    expect(after.length, 'a suppressed row is deleted where it stands, never delivered').toBe(0)
  }, 120_000)
})

describe('#862 §G — a move INTO a private folder', () => {
  it('settles the moved page and the links it revokes, from before the parent was re-pointed', async () => {
    // The move is what makes the subtree private, and it has already landed by the time the privacy
    // boundary runs — so unlike the privatise path, nothing inside that function could read the answer.
    // It is taken in the caller. Nothing pinned this path at all until asked for it.
    await admin`DELETE FROM webhook_outbox WHERE tenant_id = ${tenant.id}`
    const folder = await visiblePage('g862 move folder')
    const moving = await visiblePage('g862 moving page')
    await createShareLink(db, fgaClient, {
      tenantId: tenant.id, plan: 'business', userId: 'dev-user',
      resource: { type: 'page', id: moving }, capability: 'view', expiresInSeconds: null,
    })
    await setPagePrivate(db, fgaClient, driver, { pageId: folder, tenantId: tenant.id, userId: 'dev-user' })
    await admin`DELETE FROM webhook_outbox WHERE tenant_id = ${tenant.id}` // the privatise's own rows
    await movePage(db, fgaClient, driver, { pageId: moving, userId: 'dev-user', parentId: folder, afterId: null })
    await settle()
    const moved = await rowsFor('page.moved')
    expect(moved.length, 'the move enqueued a page.moved').toBeGreaterThan(0)
    expect(moved[0]!.settled_disposition, 'read before the page inherited the folder\'s privacy').toBe('deliver')
    const revoked = await rowsFor('share_link.revoked')
    expect(revoked.length, 'and the link the move revoked').toBeGreaterThan(0)
    for (const r of revoked) expect(r.settled_disposition, 'settled the same way').toBe('deliver')
  }, 180_000)

  it('⚠️ and a page moved between two ordinary parents is NOT settled — the drain still asks', async () => {
    // The class is "the act destroyed the answer", not "a move happened". A move that changes nothing
    // about privacy must keep the delivery-time question, where the later answer is the safer one.
    await admin`DELETE FROM webhook_outbox WHERE tenant_id = ${tenant.id}`
    const a = await visiblePage('g862 ordinary parent')
    const moving = await visiblePage('g862 ordinary mover')
    await movePage(db, fgaClient, driver, { pageId: moving, userId: 'dev-user', parentId: a, afterId: null })
    await settle()
    const moved = await rowsFor('page.moved')
    expect(moved.length, 'the move enqueued a page.moved').toBeGreaterThan(0)
    expect(moved[0]!.settled_disposition, 'nothing was settled — the drain asks').toBeNull()
  }, 180_000)
})

describe('#862 §G — privatising a page', () => {
  it('delivers page.made_private and the share_link.revoked events beside it', async () => {
    await admin`DELETE FROM webhook_outbox WHERE tenant_id = ${tenant.id}`
    const pageId = await visiblePage('g862 privatise visible')
    await setPagePrivate(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: 'dev-user' })
    await settle()
    const [row] = await rowsFor('page.made_private')
    expect(row, 'the privatise enqueued a page.made_private').toBeTruthy()
    expect(row!.settled_disposition, 'read before the marker that hides the page landed').toBe('deliver')
    const before = await hookFailures()
    await admin`UPDATE webhooks SET active = TRUE WHERE id = ${hookId}`
    await drainWebhookOutbox(fgaClient)
    expect(await hookFailures(), 'and it was actually sent, not suppressed by the marker it announces').toBeGreaterThan(before)
  }, 120_000)

  it('⚠️ and the share_link.revoked events raised beside it are settled too', async () => {
    // The half the title of the walk above used to claim and never measured: `page.made_private` is one
    // row, and the links the privatise revokes are others. ADR-108 §G calls this member the worse one,
    // because the code beside that emit says a consumer mirroring access has to hear about the links
    // that went — and it was the marker written two lines earlier that stopped them.
    await admin`DELETE FROM webhook_outbox WHERE tenant_id = ${tenant.id}`
    const pageId = await visiblePage('g862 privatise with a link')
    await createShareLink(db, fgaClient, {
      tenantId: tenant.id, plan: 'business', userId: 'dev-user',
      resource: { type: 'page', id: pageId }, capability: 'view', expiresInSeconds: null,
    })
    await setPagePrivate(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: 'dev-user' })
    await settle()
    const rows = await rowsFor('share_link.revoked')
    expect(rows.length, 'the revoke of the live link was enqueued').toBeGreaterThan(0)
    for (const r of rows) expect(r.settled_disposition, 'and settled from before the marker landed').toBe('deliver')
  }, 120_000)

  it('⚠️ and an already-hidden page still settles as suppress', async () => {
    await admin`DELETE FROM webhook_outbox WHERE tenant_id = ${tenant.id}`
    const pageId = await draftPage('g862 privatise draft')
    await setPagePrivate(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: 'dev-user' })
    await settle()
    const [row] = await rowsFor('page.made_private')
    expect(row, 'the row is written').toBeTruthy()
    expect(row!.settled_disposition, 'a draft was never disclosed and privatising it discloses nothing').toBe('suppress')
  }, 120_000)
})
