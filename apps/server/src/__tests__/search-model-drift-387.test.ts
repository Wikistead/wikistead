// #387: the search denormalizer (doc-builder) hand-mirrors model.fga's `view` graph, and every model
// change risks silent drift. This test PINS the mirror against the REAL authz graph: for a canonical
// matrix of principals × page shapes (all written through the PRODUCTION grant routes, never raw
// tuples), the stage-1 visibility derived from buildSearchDoc must EQUAL the live FGA `view` decision —
// with the KNOWN, documented over-inclusions as the only allowed divergence:
//   - `restricted` principals: doc-builder deliberately ignores the restricted subtraction (stage-2
//     filterAuthorized catches it at query time — an over-inclusion is safe, ADR-072/#109).
// An UNDER-inclusion (FGA says view, stage-1 says invisible) is NEVER allowed — that class silently
// hides authorized results (the availability bug this pin exists to catch). If model.fga's view graph
// changes without a doc-builder update, this file goes red naming the exact principal × page.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver, buildSearchDoc } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { createSpace, deleteSpace, grantSpaceAccess } from '../routes/spaces.js'
import { createPage, publishPage, grantPageAccess, restrictPageAccess, setPagePrivate, movePage } from '../routes/pages.js'
import type { Tenant, SearchDoc } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const storage = new LogicalStorageDriver()
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const OWNER = 'dev-user'

// The principal matrix. GM is granted via a GROUP; everyone else directly. OUT has nothing.
const V = 'drift-viewer', E = 'drift-editor', M = 'drift-manager', GM = 'drift-group-member'
const PD = 'drift-page-direct', AL = 'drift-allowlisted', RS = 'drift-restricted', OUT = 'drift-outsider'
const GROUP = 'group:drift-g'
const MEMBERS: { sub: string; groups: string[] }[] = [
  { sub: V, groups: [] }, { sub: E, groups: [] }, { sub: M, groups: [] }, { sub: GM, groups: ['drift-g'] },
  { sub: PD, groups: [] }, { sub: AL, groups: [] }, { sub: RS, groups: [] }, { sub: OUT, groups: [] },
]

let db: TenantDb
let spaceId: string
let pubPage: string, privPage: string, draftPage: string, folderPage: string, childPage: string, publicPage: string
const cleanupTuples: { user: string; relation: string; object: string }[] = []
const pages: string[] = []

const ydoc = (t: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, t); return d })()))
async function publishedPage(title: string): Promise<string> {
  const p = await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: OWNER, title })
  pages.push(p.id)
  await admin`UPDATE pages SET ydoc = ${ydoc(`${title} body`)} WHERE id = ${p.id}`
  await publishPage(db, fgaClient, driver, storage, { pageId: p.id, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  return p.id
}

// stage-1 visibility exactly as routes/search.ts filters: public OR the member OR one of their groups.
function stage1Visible(doc: SearchDoc, sub: string, groups: string[]): boolean {
  if (doc.isPublic) return true
  if (doc.viewerUsers.includes(`user:${sub}`)) return true
  return groups.some((g) => doc.viewerGroups.includes(`group:${g}`))
}

beforeAll(async () => {
  await driver.ensureIndex()
  await storage.ensureBucket()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'free', name: `drift-${Date.now().toString(36)}` })).id

  // Grants through the PRODUCTION routes (what the index really sees), one per principal class.
  await grantSpaceAccess(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: OWNER, grantee: `user:${V}`, capability: 'view' })
  await grantSpaceAccess(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: OWNER, grantee: `user:${E}`, capability: 'edit' })
  await grantSpaceAccess(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: OWNER, grantee: `user:${M}`, capability: 'manage' })
  await grantSpaceAccess(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: OWNER, grantee: `${GROUP}#member`, capability: 'view' })
  const groupTuple = { user: `user:${GM}`, relation: 'member', object: GROUP }
  await writeTuples(fgaClient, [groupTuple]); cleanupTuples.push(groupTuple)
  // RS is a space viewer whose view is then subtracted per-page (the documented over-inclusion case).
  await grantSpaceAccess(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: OWNER, grantee: `user:${RS}`, capability: 'view' })

  pubPage = await publishedPage('drift pub')
  privPage = await publishedPage('drift priv')
  folderPage = await publishedPage('drift folder')
  childPage = await publishedPage('drift child')
  publicPage = await publishedPage('drift public')
  draftPage = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: OWNER, title: 'drift draft' })).id
  pages.push(draftPage)

  await grantPageAccess(db, fgaClient, driver, { pageId: pubPage, tenantId: TENANT, userId: OWNER, grantee: `user:${PD}`, relation: 'view' })
  await grantPageAccess(db, fgaClient, driver, { pageId: draftPage, tenantId: TENANT, userId: OWNER, grantee: `user:${PD}`, relation: 'view' })
  await restrictPageAccess(db, fgaClient, driver, { pageId: pubPage, tenantId: TENANT, userId: OWNER, principal: `user:${RS}` })
  await setPagePrivate(db, fgaClient, driver, { pageId: privPage, tenantId: TENANT, userId: OWNER })
  await grantPageAccess(db, fgaClient, driver, { pageId: privPage, tenantId: TENANT, userId: OWNER, grantee: `user:${AL}`, relation: 'view' })
  await movePage(db, fgaClient, driver, { pageId: childPage, userId: OWNER, parentId: folderPage, afterId: null })
  await grantPageAccess(db, fgaClient, driver, { pageId: folderPage, tenantId: TENANT, userId: OWNER, grantee: `user:${PD}`, relation: 'view' })
  // public: the direct view_base@user:* grant (what setPagePublic writes; written directly to avoid the
  // tenant public-surface switch dependency — the tuple shape is the model contract being pinned).
  const pub = { user: 'user:*', relation: 'view_base', object: `page:${publicPage}` }
  await writeTuples(fgaClient, [pub]); cleanupTuples.push(pub)
}, 120_000)

afterAll(async () => {
  await deleteTuples(fgaClient, cleanupTuples).catch(() => {})
  for (const id of pages) {
    await admin`DELETE FROM revisions WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM search_outbox WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM pages WHERE id = ${id}`.catch(() => {})
  }
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await db.release()
  await admin.end()
  await pool.end()
}, 60_000)

describe('search denorm ↔ FGA view-model drift pin (#387)', () => {
  // The documented, deliberate over-inclusions (stage-2 catches them at query time). ANYTHING else —
  // over OR under — is drift and must fail this test until doc-builder and model.fga agree again.
  const ALLOWED_OVER: Record<string, string[]> = {
    // restricted subtracts view in the model; doc-builder ignores it by design (#109 / ADR-072).
    get pubPage() { return [RS] },
  }

  it('every principal × page: stage-1 visibility equals the live FGA view decision (allowed over-inclusions only)', async () => {
    const cases: [string, string][] = [
      ['pubPage', pubPage], ['privPage', privPage], ['draftPage', draftPage],
      ['folderPage', folderPage], ['childPage', childPage], ['publicPage', publicPage],
    ]
    const failures: string[] = []
    for (const [name, pageId] of cases) {
      const doc = await buildSearchDoc(pool, fgaClient, pageId, TENANT)
      expect(doc, `${name} indexed`).not.toBeNull()
      for (const m of MEMBERS) {
        const fgaView = await check(fgaClient, `user:${m.sub}`, 'view', { type: 'page', id: pageId })
        const s1 = stage1Visible(doc!, m.sub, m.groups)
        if (fgaView && !s1) failures.push(`UNDER-inclusion (authorized result hidden): ${m.sub} on ${name}`)
        if (!fgaView && s1 && !(ALLOWED_OVER[name] ?? []).includes(m.sub)) {
          failures.push(`over-inclusion beyond the documented set (stage-2 will catch, but the mirror drifted): ${m.sub} on ${name}`)
        }
      }
    }
    expect(failures, failures.join('\n')).toEqual([])
  }, 120_000)

  it('the public grant denormalizes to isPublic (and only there)', async () => {
    const doc = await buildSearchDoc(pool, fgaClient, publicPage, TENANT)
    expect(doc!.isPublic).toBe(true)
    const priv = await buildSearchDoc(pool, fgaClient, privPage, TENANT)
    expect(priv!.isPublic, 'a private page can never be public in the index').toBe(false)
  })
})
