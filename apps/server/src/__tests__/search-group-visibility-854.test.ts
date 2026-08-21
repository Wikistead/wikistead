// #854: a page reachable only through a group was missing from that group's search.
//
// The index and the filter named the same group two different ways. `doc-builder` reads the FGA
// tuples, so `viewerGroups` holds the OBJECT ID — `group:<hash>` — while the filter was built from
// `req.user.groups`, which mirrors `members.groups`: the IdP's group NAMES. A hash never equals a
// name, so the term matched nothing, ever. Direct grants and public pages still came back, which is
// why it read as "that one page never shows up" rather than as a broken search.
//
// The existing suite could not see it: every call there passes `groups: []`, and the model-drift
// pin re-implements the filter with the same expression the driver used — a copy of a mistake agrees
// with it. So this walks the REAL driver against real Meilisearch and asks the question the way a
// signed-in member asks it: by group name.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples, groupFgaId } from '@wikistead/authz'
import { LogicalSearchDriver, buildSearchDoc } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const GROUP = 'search-854-engineering'
const MEMBER = 'search-854-member'
const TITLE = 'group-only-page-854-zxq'
let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string
let groupId: string

beforeAll(async () => {
  await driver.ensureIndex()
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'search-854-space',
  })
  spaceId = space.id
  const page = await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId, userId: 'dev-user', title: TITLE,
  })
  pageId = page.id

  // The grant this test is about: the member reaches the page ONLY through the group. The tuples are
  // written the way the product writes them — `syncMemberGroups` hashes the name for membership, and
  // a group grant on a page names the same object.
  groupId = groupFgaId(tenant.id, GROUP)
  await writeTuples(fgaClient, [
    { user: `user:${MEMBER}`, relation: 'member', object: `group:${groupId}` },
    { user: `group:${groupId}#member`, relation: 'view_direct', object: `page:${pageId}` },
  ])

  // Re-index after the grant, so the denormalised viewer set carries the group.
  const doc = await buildSearchDoc(pool, fgaClient, pageId, tenant.id)
  await driver.upsertDoc(doc!)
  await new Promise((r) => setTimeout(r, 1500))
}, 60_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [
    { user: `user:${MEMBER}`, relation: 'member', object: `group:${groupId}` },
    { user: `group:${groupId}#member`, relation: 'view_direct', object: `page:${pageId}` },
  ]).catch(() => {})
  try { await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }) } catch { /* already gone */ }
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' })
  await db.release()
  await pool.end()
}, 60_000)

describe('#854 a group grant reaches the group member through search', () => {
  it('the index records the group by its FGA object id, not by its name', () => {
    // Half of the mismatch, stated so a change on the indexing side has to say so here.
    expect(groupId, 'the id is a hash, and a name is not').not.toBe(GROUP)
  })

  it('the member finds the page by searching the way the product asks — with group NAMES', async () => {
    const hits = await driver.search({
      tenantId: tenant.id, userId: MEMBER, groups: [GROUP], q: TITLE,
    })
    expect(hits.map((h) => h.id), 'a group grant is a way to see a page').toContain(pageId)
  })

  it('and someone outside the group still does not (the fix widened nothing else)', async () => {
    const hits = await driver.search({
      tenantId: tenant.id, userId: 'search-854-stranger', groups: [], q: TITLE,
    })
    expect(hits.map((h) => h.id), 'no group, no direct grant, not public').not.toContain(pageId)
  })

  it('a group the member does not hold does not let them in either', async () => {
    const hits = await driver.search({
      tenantId: tenant.id, userId: 'search-854-stranger', groups: ['search-854-some-other-group'], q: TITLE,
    })
    expect(hits.map((h) => h.id), 'the filter names the group, not any group').not.toContain(pageId)
  })
})
