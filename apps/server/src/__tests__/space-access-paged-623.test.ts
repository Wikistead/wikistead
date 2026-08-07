// #623: the space roster returned everyone at once.
//
// Third route on the same mechanism (page of FGA tuples + continuation token, explicit page size), and
// the one with the most filtering after the read: the relation map, the principal shape, the
// custom-role expansion, plus the per-row `revocable` / `managed` signals #607 added. All of it runs on
// what the read handed back, so a page can hold ZERO rows while more follow.
//
// The tuples the filters drop are written FIRST, deliberately: a walk that stops on an empty page only
// loses what comes after it, so dropped-last measures nothing (learned on the page roster the same
// day).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, deleteTuples, writeTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace, grantSpaceAccess, listSpaceAccess, listAllSpaceAccess } from '../routes/spaces.js'
import { createShareLink } from '../routes/share-links.js'
import { seatMembers, unseatMembers } from './helpers/seat-members.js'
import { ensureMembers, memberTuples } from './helpers/membership.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
// ⚠️ SEATS IN A SHARED TENANT. `seatMembers` writes `members` rows, and the seat-cap suites
// (invite acceptance, plan freeze) count them — measured: a killed run of this file left 12 seats
// behind and both of those went red until they were removed. The fixture is deliberately small, and
// afterAll removes every seat it took.
const N = 6
const PAGE = 2
const SUBS = Array.from({ length: N }, (_, i) => `sa623-${STAMP}-${String(i).padStart(2, '0')}`)

let tenant: Tenant
let db: TenantDb
let spaceId: string

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `sa623-space-${STAMP}`,
  })
  spaceId = space.id
  // ⚠️ Tuples this list DROPS, written FIRST. Share links on the space are exactly that: the principal
  // filter refuses `share_link:` grantees, so each is a page the filters empty. Written before the
  // grants because a walk that stops on an empty page loses only what follows.
  for (let i = 0; i < 3; i++) {
    await createShareLink(db, fgaClient, {
      tenantId: tenant.id, plan: tenant.plan, userId: 'dev-user',
      resource: { type: 'space', id: spaceId }, capability: 'view', expiresInSeconds: null,
    })
  }
  await seatMembers(admin, tenant.id, SUBS)
  await ensureMembers(tenant.id, SUBS)
  for (const sub of SUBS) {
    await grantSpaceAccess(db, fgaClient, driver, {
      spaceId, tenantId: tenant.id, userId: 'dev-user', grantee: `user:${sub}`, capability: 'view', plan: tenant.plan,
    })
  }
}, 300_000)

afterAll(async () => {
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await deleteTuples(fgaClient, memberTuples(tenant.id, SUBS)).catch(() => {})
  await unseatMembers(admin, tenant.id, SUBS).catch(() => {})
  await db.release(); await pool.end(); await admin.end()
}, 300_000)

const mine = (gs: string[]) => gs.filter((g) => g.startsWith(`user:sa623-${STAMP}-`))
const ARGS = () => ({ spaceId, tenantId: tenant.id, userId: 'dev-user' })

describe('#623: the space roster is bounded on a page of tuples', () => {
  it('one read does not carry the whole roster', async () => {
    const first = await listSpaceAccess(fgaClient, db, { ...ARGS(), pageSize: PAGE })
    expect(first).toHaveProperty('nextCursor')
    expect(first.grants.length, 'one read took more than the page it asked for').toBeLessThanOrEqual(PAGE)
    expect(first.nextCursor, 'the fixture fits in one page — nothing below is being tested').toBeTruthy()
  }, 300_000)

  it('walking returns every grant exactly once', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 200; guard++) {
      const page = await listSpaceAccess(fgaClient, db, { ...ARGS(), pageSize: PAGE, ...(cursor ? { cursor } : {}) })
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
    let cursor: string | undefined
    let emptyPages = 0
    for (let guard = 0; guard < 400; guard++) {
      const page = await listSpaceAccess(fgaClient, db, { ...ARGS(), pageSize: 1, ...(cursor ? { cursor } : {}) })
      if (page.grants.length === 0) emptyPages++
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(emptyPages, 'no page came back empty — the condition this case exists for did not occur')
      .toBeGreaterThan(0)
    const all = mine((await listAllSpaceAccess(fgaClient, db, { ...ARGS(), pageSize: 1 })).map((g) => g.grantee))
    expect(all.length, 'the walker stopped at a page the filters emptied').toBe(N)
  }, 300_000)

  it('the per-row signals survive the paging', async () => {
    // #607: each row says whether THIS caller may revoke it. That is computed per row, so it must not
    // depend on which page the row landed on — a signal that only appears on page one is a × the
    // screen draws for some rows and not others.
    const all = (await listAllSpaceAccess(fgaClient, db, { ...ARGS(), pageSize: PAGE }))
      .filter((g) => g.grantee.startsWith(`user:sa623-${STAMP}-`))
    expect(all.length).toBe(N)
    expect(all.every((g) => typeof g.revocable === 'boolean'), 'a row lost its revocable signal').toBe(true)
  }, 300_000)
})
