// #623: the per-page grant list returned everyone at once.
//
// Same mechanism as the restriction list next door — the rows are FGA tuples, so the bound is a page of
// tuples and the marker is the store's continuation token. The page size is asked for explicitly, both
// so the bound belongs here rather than to a server setting and so a pin can make the pages small
// enough to cross a boundary.
//
// ⚠️ This list filters HARDER than the restriction one: by relation, by principal shape, and by whether
// a capability is a custom role's expansion. Every one of those runs after the read, so a page can hold
// zero grants while more follow — and the walk must continue on the marker, never stop on emptiness.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, grantPageAccess, restrictPageAccess, listPageAccess, listAllPageAccess } from '../routes/pages.js'
import { seatMembers, unseatMembers } from './helpers/seat-members.js'
import { ensureMembers, memberTuples } from './helpers/membership.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const N = 12
const PAGE = 5
const SUBS = Array.from({ length: N }, (_, i) => `pa623-${STAMP}-${String(i).padStart(2, '0')}`)
const RESTRICTED = Array.from({ length: 3 }, (_, i) => `pa623x-${STAMP}-${i}`)
const ALL_SUBS = [...SUBS, ...RESTRICTED]

let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `pa623-space-${STAMP}`,
  })
  spaceId = space.id
  const page = await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId, userId: 'dev-user', title: `pa623-page-${STAMP}`, parentId: null,
  })
  pageId = page.id
  await seatMembers(admin, tenant.id, ALL_SUBS)
  await ensureMembers(tenant.id, ALL_SUBS)
  // ⚠️ Restrictions FIRST, and on the same page object. They are tuples this list's filters drop, which
  // is the only way a page of tuples comes back empty of grants — and they have to come BEFORE the
  // grants, because a walk that stops on an empty page loses only what follows it.
  //
  // Measured both wrong ways: without them the empty-page case could not occur at all (a fresh page
  // object carries nothing but grants), and with them written last the break stayed green — every grant
  // had already been collected before the first empty page appeared.
  for (const sub of RESTRICTED) {
    await restrictPageAccess(db, fgaClient, driver, {
      pageId, tenantId: tenant.id, userId: 'dev-user', principal: `user:${sub}`, plan: tenant.plan,
    })
  }
  for (const sub of SUBS) {
    await grantPageAccess(db, fgaClient, driver, {
      pageId, tenantId: tenant.id, userId: 'dev-user', grantee: `user:${sub}`, relation: 'view', plan: tenant.plan,
    })
  }
}, 300_000)

afterAll(async () => {
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await deleteTuples(fgaClient, memberTuples(tenant.id, ALL_SUBS)).catch(() => {})
  await unseatMembers(admin, tenant.id, ALL_SUBS).catch(() => {})
  await db.release(); await pool.end(); await admin.end()
}, 300_000)

const mine = (gs: string[]) => gs.filter((g) => g.startsWith(`user:pa623-${STAMP}-`))
const ARGS = { pageId: '', tenantId: '', userId: 'dev-user' }

describe('#623: the page access list is bounded on a page of tuples', () => {
  it('one read does not carry every grant', async () => {
    const first = await listPageAccess(fgaClient, db, { ...ARGS, pageId, tenantId: tenant.id, pageSize: PAGE })
    expect(first).toHaveProperty('nextCursor')
    expect(first.grants.length, 'one read took more than the page it asked for').toBeLessThanOrEqual(PAGE)
    expect(first.nextCursor, 'the fixture fits in one page — nothing below is being tested').toBeTruthy()
  }, 300_000)

  it('walking returns every grant exactly once', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 200; guard++) {
      const page = await listPageAccess(fgaClient, db, {
        ...ARGS, pageId, tenantId: tenant.id, pageSize: PAGE, ...(cursor ? { cursor } : {}),
      })
      seen.push(...page.grants.map((g) => g.grantee))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    const ours = mine(seen)
    const repeats = ours.filter((s, i) => ours.indexOf(s) !== i)
    expect(repeats, `returned twice: ${[...new Set(repeats)].join(', ')}`).toEqual([])
    expect(new Set(ours).size, `walked ${ours.length} and saw ${new Set(ours).size} of ${N}`).toBe(N)
  }, 300_000)

  it('a page the filters empty is not the end of the walk', async () => {
    // Forced with a page size of ONE: every tuple that is not a direct member grant is then a page the
    // filters empty, and this object certainly has some (creating a page writes them). The condition is
    // proved to have occurred before anything is asserted about surviving it, and the SHIPPED walker is
    // what gets measured — walking by hand here would test this test.
    let cursor: string | undefined
    let emptyPages = 0
    for (let guard = 0; guard < 400; guard++) {
      const page = await listPageAccess(fgaClient, db, {
        ...ARGS, pageId, tenantId: tenant.id, pageSize: 1, ...(cursor ? { cursor } : {}),
      })
      if (page.grants.length === 0) emptyPages++
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(emptyPages, 'no page came back empty — the condition this case exists for did not occur')
      .toBeGreaterThan(0)
    const all = mine((await listAllPageAccess(fgaClient, db, { ...ARGS, pageId, tenantId: tenant.id, pageSize: 1 }))
      .map((g) => g.grantee))
    expect(all.length, 'the walker stopped at a page the filters emptied').toBe(N)
  }, 300_000)

  it('the walker returns every grant the pages do', async () => {
    const all = mine((await listAllPageAccess(fgaClient, db, { ...ARGS, pageId, tenantId: tenant.id })).map((g) => g.grantee))
    expect(all.length).toBe(N)
  }, 300_000)
})
