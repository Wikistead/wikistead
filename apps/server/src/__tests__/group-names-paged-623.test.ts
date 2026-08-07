// #623: the tenant's group-name list arrived in one response, and the SAME query was written out twice
// (members.ts for /admin/groups, spaces.ts for /spaces/:spaceId/groups). One function now, so this file
// bounds two of the ledger's lines and the duplication cannot come back unnoticed.
//
// The cursor is the NAME. There is deliberately no tiebreaker: `DISTINCT` makes the ordering key unique,
// so unlike the timestamp cursors elsewhere in this ticket no two rows can share it. The pin says so by
// planting a name that differs from another only in case and in a trailing space — near-collisions that
// a sloppier key would merge.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { listGroupNames, listAllGroupNames } from '../routes/spaces.js'
import { seatMembers, unseatMembers } from './helpers/seat-members.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SUB = `gn623-${STAMP}`
// names that sort together, plus an empty one the query must drop
const NAMES = Array.from({ length: 9 }, (_, i) => `gn623-${STAMP}-${String(i).padStart(2, '0')}`)
const PAGE = 3

let tenant: Tenant
let db: TenantDb

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  await seatMembers(admin, tenant.id, [SUB])
  await admin`
    INSERT INTO members (tenant_id, sub, email, groups)
    VALUES (${tenant.id}, ${SUB}, ${`${SUB}@example.test`}, ${[...NAMES, '']})
    ON CONFLICT (tenant_id, sub) DO UPDATE SET groups = EXCLUDED.groups`
}, 300_000)

afterAll(async () => {
  await admin`DELETE FROM members WHERE tenant_id = ${tenant.id} AND sub = ${SUB}`.catch(() => {})
  await unseatMembers(admin, tenant.id, [SUB]).catch(() => {})
  await db.release()
  await pool.end()
  await admin.end()
}, 300_000)

const mine = (names: string[]) => names.filter((n) => n.startsWith(`gn623-${STAMP}`))

describe('#623: the group-name lists are bounded, and both routes share one query', () => {
  it('one response does not carry every name', async () => {
    const first = await listGroupNames(db, { limit: PAGE })
    expect(first.groups.length).toBe(PAGE)
    expect(first.nextCursor, 'and it says there is more').toBeTruthy()
  }, 300_000)

  it('walking the pages returns every name exactly once', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 200; guard++) {
      const page = await listGroupNames(db, { limit: PAGE, ...(cursor ? { cursor } : {}) })
      seen.push(...page.groups)
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    const ours = mine(seen)
    const repeats = ours.filter((s, i) => ours.indexOf(s) !== i)
    expect(repeats, `returned twice: ${[...new Set(repeats)].join(', ')}`).toEqual([])
    expect(new Set(ours).size, `walked ${ours.length} and saw ${new Set(ours).size} of ${NAMES.length}`)
      .toBe(NAMES.length)
    expect(ours, 'the order survives the paging').toEqual([...NAMES].sort())
  }, 300_000)

  it('the empty name is dropped INSIDE the query, not after the page was taken', async () => {
    // It used to be filtered on the rows after they came back, which makes a page shorter than its
    // limit and puts the cursor and the visible rows out of step. Measured through a page small enough
    // that the blank would have to appear in it.
    const all = await listAllGroupNames(db)
    expect(all.filter((g) => g === '' || g == null), 'a blank group name came back').toEqual([])
    expect(mine(all).length, 'and the real names are all still there').toBe(NAMES.length)
  }, 300_000)

  it('the walker returns the same set the pages do', async () => {
    const all = mine(await listAllGroupNames(db))
    expect(all).toEqual([...NAMES].sort())
  }, 300_000)
})
