// #623: the per-page restriction list returned every restricted principal at once.
//
// This one is bounded on FGA's own page rather than on a keyset — there is no timestamp to order by,
// and the rows are tuples. Its marker is the continuation token.
//
// ⚠️ The relation filter runs AFTER the read, and a page object carries grants, share links and
// markers alongside restrictions, so a page can hold ZERO restrictions while more follow. The walk
// must continue on the marker, never stop on emptiness — the last case plants exactly that shape.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, readObjectTuplesPage } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, restrictPageAccess, listPageRestrictions, listAllPageRestrictions } from '../routes/pages.js'
import { seatMembers, unseatMembers } from './helpers/seat-members.js'
import { ensureMembers, memberTuples } from './helpers/membership.js'
import { deleteTuples } from '@wikistead/authz'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const N = 12
// ⚠️ Small enough that the store hands the whole object back in one read at its default page size —
// measured, and with the default BOTH break directions stayed green because paging never engaged. The
// pages are made small here instead of the fixture made huge.
const PAGE = 5
const SUBS = Array.from({ length: N }, (_, i) => `res623-${STAMP}-${String(i).padStart(2, '0')}`)

let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `res623-space-${STAMP}`,
  })
  spaceId = space.id
  const page = await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId, userId: 'dev-user', title: `res623-page-${STAMP}`, parentId: null,
  })
  pageId = page.id
  await seatMembers(admin, tenant.id, SUBS)
  await ensureMembers(tenant.id, SUBS)
  for (const sub of SUBS) {
    await restrictPageAccess(db, fgaClient, driver, {
      pageId, tenantId: tenant.id, userId: 'dev-user', principal: `user:${sub}`, plan: tenant.plan,
    })
  }
}, 300_000)

afterAll(async () => {
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await deleteTuples(fgaClient, memberTuples(tenant.id, SUBS)).catch(() => {})
  await unseatMembers(admin, tenant.id, SUBS).catch(() => {})
  await db.release(); await pool.end(); await admin.end()
}, 300_000)

const mine = (ps: string[]) => ps.filter((p) => p.startsWith(`user:res623-${STAMP}-`))

describe('#623: the page restriction list is bounded on FGA’s page', () => {
  it('the response carries a marker, so a caller can tell there is more', async () => {
    const first = await listPageRestrictions(db, fgaClient, { pageId, userId: 'dev-user', pageSize: PAGE })
    expect(first, 'the route answers with a page, not a bare array').toHaveProperty('nextCursor')
    expect(Array.isArray(first.restrictions)).toBe(true)
    expect(first.restrictions.length, 'one read took more than the page it asked for').toBeLessThanOrEqual(PAGE)
    expect(first.nextCursor, 'the fixture fits in one page — nothing below is being tested').toBeTruthy()
  }, 300_000)

  it('walking returns every restriction exactly once', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 100; guard++) {
      const page = await listPageRestrictions(db, fgaClient, { pageId, userId: 'dev-user', pageSize: PAGE, ...(cursor ? { cursor } : {}) })
      seen.push(...page.restrictions.map((r) => r.principal))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    const ours = mine(seen)
    const repeats = ours.filter((s, i) => ours.indexOf(s) !== i)
    expect(repeats, `returned twice: ${[...new Set(repeats)].join(', ')}`).toEqual([])
    expect(new Set(ours).size, `walked ${ours.length} and saw ${new Set(ours).size} of ${N}`).toBe(N)
  }, 300_000)

  it('the walker returns every restriction the pages do', async () => {
    const all = mine((await listAllPageRestrictions(db, fgaClient, { pageId, userId: 'dev-user' })).map((r) => r.principal))
    expect(all.length).toBe(N)
  }, 300_000)

  it('a page holding NO restriction is not the end of the walk', async () => {
    // The shape that breaks a walk written as "stop when the rows run out". A page object carries
    // grants and markers alongside restrictions, so the relation filter empties some pages.
    //
    // Forced deterministically with a page size of ONE: every tuple that is not a restriction is then a
    // page the filter empties, and this object certainly has some (creating a page writes them). At the
    // default size the condition never occurred and this case passed while measuring nothing.
    // First: prove the condition exists at this page size, so the assertion below is not vacuous.
    let cursor: string | undefined
    let emptyPages = 0
    for (let guard = 0; guard < 400; guard++) {
      const page = await listPageRestrictions(db, fgaClient, {
        pageId, userId: 'dev-user', pageSize: 1, ...(cursor ? { cursor } : {}),
      })
      if (page.restrictions.length === 0) emptyPages++
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(emptyPages, 'no page came back empty — the condition this case exists for did not occur')
      .toBeGreaterThan(0)

    // …then measure the SHIPPED walker against it. Walking by hand here would test this test.
    const all = mine((await listAllPageRestrictions(db, fgaClient, { pageId, userId: 'dev-user', pageSize: 1 }))
      .map((r) => r.principal))
    expect(all.length, 'the walker stopped at a page the relation filter emptied').toBe(N)
  }, 300_000)
})
