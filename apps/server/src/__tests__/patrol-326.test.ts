// #326 / ADR-142 (C-1 patrol): mark/unmark a feed event reviewed + the "unpatrolled only" filter. The
// permission-critical part is the WRITE gate ORDER: per-event view-confirm → uniform 404 → capability 403, so a
// caller with space#manage but no page#view on a strict-private event gets 404 (no write-side existence oracle).
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
import { markPatrolled, unmarkPatrolled, listFeed } from '../routes/notifications.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const storage = new LogicalStorageDriver()
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const ydoc = (t: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, t); return d })()))
const OWNER = 'patrol-owner', MOD = 'patrol-mod', RMGR = 'patrol-restricted-mgr'
let db!: TenantDb, spaceId!: string, pubPage!: string, privPage!: string, pubEvent!: string, privEvent!: string
const pageIds: string[] = []
const tuples: { user: string; relation: string; object: string }[] = []

async function publishAndEvent(pageId: string): Promise<string> {
  await admin`UPDATE pages SET ydoc = ${ydoc(`# body ${pageId}`)} WHERE id = ${pageId}`
  await publishPage(db, fgaClient, driver, storage, { pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  const [ev] = await admin<{ id: string }[]>`SELECT id FROM feed_events WHERE page_id = ${pageId} AND event_type = 'page.published' ORDER BY created_at DESC LIMIT 1`
  return ev!.id
}

beforeAll(async () => {
  await driver.ensureIndex(); await storage.ensureBucket()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'free', name: `patrol-${Date.now().toString(36)}` })).id
  // MOD is a space MANAGER (→ page manage via inheritance) but is NOT on the private page's allowlist.
  const g = [{ user: `user:${MOD}`, relation: 'manager', object: `space:${spaceId}` }]
  await writeTuples(fgaClient, g); tuples.push(...g)
  pubPage = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: OWNER, title: 'Patrol Public' })).id
  privPage = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: OWNER, title: 'Patrol Private' })).id
  pageIds.push(pubPage, privPage)
  pubEvent = await publishAndEvent(pubPage)
  privEvent = await publishAndEvent(privPage)
  // Make privPage STRICT-PRIVATE: the marker pair cuts space inheritance; only OWNER (creator manage) is allowed.
  const pv = [
    { user: 'user:*', relation: 'private', object: `page:${privPage}` },
    { user: 'share_link:*', relation: 'private', object: `page:${privPage}` },
    // RMGR has a DIRECT manage grant on privPage (survives the private cut) but is also `restricted` → view is
    // subtracted. So RMGR has manage=true / view=false — the strongest existence-oracle case: only a view-FIRST
    // gate returns 404; a capability-first gate would pass manage and leak a 200 (reviewer's coverage note).
    { user: `user:${RMGR}`, relation: 'manage', object: `page:${privPage}` },
    { user: `user:${RMGR}`, relation: 'restricted', object: `page:${privPage}` },
  ]
  await writeTuples(fgaClient, pv); tuples.push(...pv)
}, 60_000)

afterAll(async () => {
  await deleteTuples(fgaClient, tuples).catch(() => {})
  for (const id of pageIds) {
    await admin`DELETE FROM patrolled_events WHERE feed_event_id IN (SELECT id FROM feed_events WHERE page_id = ${id})`.catch(() => {})
    await admin`DELETE FROM feed_events WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM revisions WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM pages WHERE id = ${id}`.catch(() => {})
  }
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await db.release(); await admin.end(); await pool.end()
}, 60_000)

describe('patrol mark/unmark + gate order (#326 / ADR-142)', () => {
  it('a manager marks a viewable event → row written; unmark removes it', async () => {
    await markPatrolled(db, fgaClient, { tenantId: TENANT, subject: `user:${MOD}`, memberSub: MOD, feedEventId: pubEvent })
    const [row] = await admin<{ patrolled_by: string }[]>`SELECT patrolled_by FROM patrolled_events WHERE feed_event_id = ${pubEvent}`
    expect(row!.patrolled_by).toBe(MOD)
    await unmarkPatrolled(db, fgaClient, { tenantId: TENANT, subject: `user:${MOD}`, feedEventId: pubEvent })
    const after = await admin`SELECT 1 FROM patrolled_events WHERE feed_event_id = ${pubEvent}`
    expect(after.length).toBe(0)
  })

  it('idempotent: marking twice keeps one row', async () => {
    await markPatrolled(db, fgaClient, { tenantId: TENANT, subject: `user:${MOD}`, memberSub: MOD, feedEventId: pubEvent })
    await markPatrolled(db, fgaClient, { tenantId: TENANT, subject: `user:${MOD}`, memberSub: MOD, feedEventId: pubEvent })
    const rows = await admin`SELECT 1 FROM patrolled_events WHERE feed_event_id = ${pubEvent}`
    expect(rows.length).toBe(1)
    await unmarkPatrolled(db, fgaClient, { tenantId: TENANT, subject: `user:${MOD}`, feedEventId: pubEvent })
  })

  it('ANTI-TEST: space#manage but NO page#view (strict-private) → uniform 404, NOT 403/200 (no write oracle)', async () => {
    await expect(markPatrolled(db, fgaClient, { tenantId: TENANT, subject: `user:${MOD}`, memberSub: MOD, feedEventId: privEvent }))
      .rejects.toMatchObject({ statusCode: 404 })
    // and NO row was written (the write never reached the table)
    const rows = await admin`SELECT 1 FROM patrolled_events WHERE feed_event_id = ${privEvent}`
    expect(rows.length).toBe(0)
  })

  it('ANTI-TEST (strongest): a principal WITH manage but restricted-out of view → 404, NOT a 200 leak', async () => {
    // RMGR: manage=true, view=false. A capability-first gate would INSERT + 200 (existence leak); the view-first
    // gate returns 404 and writes nothing. This is the case that actually distinguishes the gate order.
    await expect(markPatrolled(db, fgaClient, { tenantId: TENANT, subject: `user:${RMGR}`, memberSub: RMGR, feedEventId: privEvent }))
      .rejects.toMatchObject({ statusCode: 404 })
    const rows = await admin`SELECT 1 FROM patrolled_events WHERE feed_event_id = ${privEvent}`
    expect(rows.length).toBe(0)
  })

  it('a nonexistent / cross-tenant event id is the same uniform 404', async () => {
    await expect(markPatrolled(db, fgaClient, { tenantId: TENANT, subject: `user:${MOD}`, memberSub: MOD, feedEventId: 'no-such-event' }))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('unpatrolledOnly filter: a marked event drops out; unmarking brings it back', async () => {
    const before = await listFeed(db, fgaClient, { subject: `user:${MOD}`, spaceId, unpatrolledOnly: true })
    expect(before.some((e) => e.id === pubEvent)).toBe(true)
    await markPatrolled(db, fgaClient, { tenantId: TENANT, subject: `user:${MOD}`, memberSub: MOD, feedEventId: pubEvent })
    const after = await listFeed(db, fgaClient, { subject: `user:${MOD}`, spaceId, unpatrolledOnly: true })
    expect(after.some((e) => e.id === pubEvent)).toBe(false)
    // …and the unfiltered feed still shows it, now flagged patrolled
    const all = await listFeed(db, fgaClient, { subject: `user:${MOD}`, spaceId })
    expect(all.find((e) => e.id === pubEvent)?.patrolled).toBe(true)
    await unmarkPatrolled(db, fgaClient, { tenantId: TENANT, subject: `user:${MOD}`, feedEventId: pubEvent })
  })
})
