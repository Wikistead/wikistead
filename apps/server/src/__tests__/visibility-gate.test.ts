// Integration test — real Postgres + OpenFGA + Meilisearch, no mocks.
// Phase 4a visibility gate (THE launch blocker). An UNPUBLISHED page is strictly
// private to its creator + explicitly-granted users — NOT to space members (the
// gate withholds `page#space`, so no inheritance reaches a draft). Publishing
// writes `page#space` and releases space inheritance everywhere (FGA + search).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, writeTuples, deleteTuples, deleteObjectTuples } from '@wikistead/authz'
import { LogicalSearchDriver, buildSearchDoc } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, publishPage, movePage } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const VIEWER = 'user:vg-viewer'   // a SPACE viewer (not the creator)
const INVITED = 'user:vg-invited' // a directly-granted viewer
const TITLE = `vggate${Date.now().toString(36)}`
const ydoc = (t: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, t); return d })()))
const wait = () => new Promise((r) => setTimeout(r, 500))
const spaceLinked = async (pageId: string) =>
  ((await fgaClient.read({ object: `page:${pageId}` })).tuples ?? []).some((t) => t.key?.relation === 'space')

let db: TenantDb, spaceId: string, spaceB: string, draftId: string

beforeAll(async () => {
  await driver.ensureIndex()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: 'vg-space' })).id
  spaceB = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: 'vg-space-b' })).id
  await writeTuples(fgaClient, [{ user: VIEWER, relation: 'viewer', object: `space:${spaceId}` }])
  draftId = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: TITLE })).id
  await admin`UPDATE pages SET ydoc = ${ydoc(`# ${TITLE}\n\nbody ${TITLE}\n`)} WHERE id = ${draftId}`
}, 30_000)

afterAll(async () => {
  await driver.deleteDoc(draftId).catch(() => {})
  await deleteTuples(fgaClient, [{ user: VIEWER, relation: 'viewer', object: `space:${spaceId}` }]).catch(() => {})
  await deleteObjectTuples(fgaClient, `page:${draftId}`).catch(() => {})
  await admin`DELETE FROM revisions WHERE page_id = ${draftId}`.catch(() => {})
  await admin`DELETE FROM search_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM pages WHERE space_id IN (${spaceId}, ${spaceB})`.catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId: spaceB, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await admin.end()
  await pool.end()
}, 30_000)

describe('Phase 4 visibility gate', () => {
  it('an unpublished page is creator-only: a space viewer cannot view; creator + a direct grant can', async () => {
    expect(await spaceLinked(draftId)).toBe(false)                                              // no page#space (draft)
    expect(await check(fgaClient, 'user:dev-user', 'view', { type: 'page', id: draftId })).toBe(true)  // creator (direct manage)
    expect(await check(fgaClient, VIEWER, 'view', { type: 'page', id: draftId })).toBe(false)   // space viewer GATED
    // explicit invite = a direct page grant
    await writeTuples(fgaClient, [{ user: INVITED, relation: 'view', object: `page:${draftId}` }])
    expect(await check(fgaClient, INVITED, 'view', { type: 'page', id: draftId })).toBe(true)
  })

  it('an unpublished page does NOT surface to space members in search; publish releases it', async () => {
    // draft: viewerUsers exclude the space viewer (the launch-blocker fix)
    const before = await buildSearchDoc(pool, fgaClient, draftId, TENANT)
    expect(before!.viewerUsers).toContain('user:dev-user')
    expect(before!.viewerUsers).not.toContain(VIEWER)
    await driver.upsertDoc(before!)
    await wait()
    expect((await driver.search({ tenantId: TENANT, userId: 'vg-viewer', groups: [], q: TITLE })).some((h) => h.id === draftId)).toBe(false)

    // publish → page#space written → space inheritance released (FGA + search)
    await publishPage(db, fgaClient, driver, { pageId: draftId, subject: 'user:dev-user', createdBy: 'user:dev-user' })
    expect(await spaceLinked(draftId)).toBe(true)
    expect(await check(fgaClient, VIEWER, 'view', { type: 'page', id: draftId })).toBe(true)
    const after = await buildSearchDoc(pool, fgaClient, draftId, TENANT)
    expect(after!.viewerUsers).toContain(VIEWER)
    await driver.upsertDoc(after!)
    await wait()
    expect((await driver.search({ tenantId: TENANT, userId: 'vg-viewer', groups: [], q: TITLE })).some((h) => h.id === draftId)).toBe(true)
  })

  it('moving an unpublished page does NOT write page#space (stays gated in the new space)', async () => {
    const d2 = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'vg-move' })).id
    await movePage(db, fgaClient, driver, { pageId: d2, userId: 'dev-user', parentId: null, afterId: null, spaceId: spaceB })
    expect(await spaceLinked(d2)).toBe(false)                                                   // still no page#space
    expect(await check(fgaClient, 'user:dev-user', 'view', { type: 'page', id: d2 })).toBe(true) // creator keeps direct access
    await deleteObjectTuples(fgaClient, `page:${d2}`).catch(() => {})
  })
})
