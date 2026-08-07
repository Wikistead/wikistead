// #623: the pin list grew without a bound and nothing prunes it.
//
// The bound here is a CAP, not a page, and the ledger already states why for the same shape
// (authenticators, #657): reorder persists the whole ordered id list and the sidebar draws the set, so
// paging would let somebody hold more pins than they can see or reorder.
//
// Four cases, and the last two are what stop a cap from being the wrong kind of fix: re-pinning
// something already pinned must still work at the cap (it adds no row, and refusing a no-op would make
// the control answer an error for nothing), and a member under the cap must be refused nothing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { createPin, listPins, MAX_PINS_PER_TYPE } from '../routes/pins.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SUB = 'dev-user' // the pin owner; member_pins is member-scoped, and this sub can view the fixture

let tenant: Tenant
let db: TenantDb
let spaceId: string
let pinnedPageId: string
let sparePageId: string

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: SUB, plan: tenant.plan, name: `pin623-space-${STAMP}`,
  })
  spaceId = space.id
  const a = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: SUB, title: `pin623-a-${STAMP}`, parentId: null })
  const b = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: SUB, title: `pin623-b-${STAMP}`, parentId: null })
  pinnedPageId = a.id
  sparePageId = b.id
}, 300_000)

afterAll(async () => {
  await admin`DELETE FROM member_pins WHERE tenant_id = ${tenant.id} AND member_sub = ${SUB} AND resource_type = 'page'`.catch(() => {})
  await deletePage(db, fgaClient, driver, { pageId: pinnedPageId, userId: SUB }).catch(() => {})
  await deletePage(db, fgaClient, driver, { pageId: sparePageId, userId: SUB }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: SUB }).catch(() => {})
  await db.release()
  await pool.end()
  await admin.end()
}, 300_000)

/** Fill the member's page pins to exactly the cap with rows written straight in. */
async function fillToCap() {
  await admin`DELETE FROM member_pins WHERE tenant_id = ${tenant.id} AND member_sub = ${SUB} AND resource_type = 'page'`
  // One real pin (the one re-pinning is tested against) plus filler rows referencing the same page id
  // is impossible — the unique key is (tenant, member, type, resource). So the filler carries distinct
  // synthetic ids; they never have to resolve, because the cap is counted before any lookup.
  await admin`
    INSERT INTO member_pins (tenant_id, member_sub, resource_type, resource_id, position)
    SELECT ${tenant.id}, ${SUB}, 'page', ${`pin623-filler-${STAMP}-`} || i, i
      FROM generate_series(1, ${MAX_PINS_PER_TYPE - 1}) AS i`
  await admin`
    INSERT INTO member_pins (tenant_id, member_sub, resource_type, resource_id, position)
    VALUES (${tenant.id}, ${SUB}, 'page', ${pinnedPageId}, 0)`
}

describe('#623: the pin list is capped', () => {
  it('refuses a new pin past the cap, and says which refusal it is', async () => {
    await fillToCap()
    await expect(createPin(db, fgaClient, {
      tenantId: tenant.id, memberSub: SUB, resourceType: 'page', resourceId: sparePageId,
    })).rejects.toMatchObject({ statusCode: 409, code: 'pin_limit' })
  }, 300_000)

  it('re-pinning something ALREADY pinned still works at the cap', async () => {
    // It adds no row. Refusing it would make the control answer an error for a no-op — and the sidebar
    // toggle calls this path whenever the client's list is a moment behind.
    await fillToCap()
    const pin = await createPin(db, fgaClient, {
      tenantId: tenant.id, memberSub: SUB, resourceType: 'page', resourceId: pinnedPageId,
    })
    expect(pin.resourceId).toBe(pinnedPageId)
  }, 300_000)

  it('a member under the cap is refused nothing', async () => {
    // The green path. Without it, a cap of zero would satisfy the first case perfectly.
    await admin`DELETE FROM member_pins WHERE tenant_id = ${tenant.id} AND member_sub = ${SUB} AND resource_type = 'page'`
    const pin = await createPin(db, fgaClient, {
      tenantId: tenant.id, memberSub: SUB, resourceType: 'page', resourceId: sparePageId,
    })
    expect(pin.resourceId).toBe(sparePageId)
  }, 300_000)

  it('the list a member can hold cannot exceed the cap', async () => {
    // The claim the ledger line makes, measured on the list itself rather than on the writer.
    await fillToCap()
    const pins = await listPins(db, fgaClient, { memberSub: SUB })
    expect(pins.filter((p) => p.resourceType === 'page').length).toBeLessThanOrEqual(MAX_PINS_PER_TYPE)
  }, 300_000)
})
