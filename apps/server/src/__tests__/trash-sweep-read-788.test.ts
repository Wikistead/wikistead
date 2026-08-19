// #788: the retention sweep asks the store for the markers it wants, not for the whole type.
//
// `sweepExpiredTrash` opened with every `user:*` tuple on every page and filtered for `trashed` in
// memory. Both relations take the typed wildcard — `view_base@user:*` is what makes a page PUBLIC and
// `trashed@user:*` is the trash marker — so the read grew with how much a workspace had published,
// which has nothing to do with how much it had thrown away. Measured on the test store: 41,257 tuples
// carried home in 43 seconds to find the ONE that was trashed, on every sweep, and the retention test
// spent its whole 60-second budget there.
//
// The narrowing is safe because it is the SAME PREDICATE moved to where the rows are — and that is
// what this pins. If the store's relation filter ever answered differently, the sweep would stop
// seeing markers and expired pages would quietly never be purged: a retention promise failing
// silently, which is the failure mode worth a test rather than the speed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples, readUserTuplesByType } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const STAMP = Date.now().toString(36)
let tenant: Tenant
let db: TenantDb
let spaceId: string
let publicPage: string
let trashedPage: string

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `sweep788-${STAMP}`,
  })).id
  publicPage = (await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId, userId: 'dev-user', title: `sweep788-public-${STAMP}`,
  })).id
  trashedPage = (await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId, userId: 'dev-user', title: `sweep788-trashed-${STAMP}`,
  })).id
  // The two shapes the wildcard carries on a page, side by side — this is the mixture the sweep reads
  // through in a real store, where the public half is the overwhelming majority.
  await writeTuples(fgaClient, [
    { user: 'user:*', relation: 'view_base', object: `page:${publicPage}` },
    { user: 'user:*', relation: 'trashed', object: `page:${trashedPage}` },
  ])
}, 300_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [
    { user: 'user:*', relation: 'view_base', object: `page:${publicPage}` },
    { user: 'user:*', relation: 'trashed', object: `page:${trashedPage}` },
  ]).catch(() => {})
  for (const id of [publicPage, trashedPage]) {
    await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  }
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end({ timeout: 5 })
}, 300_000)

describe('#788: narrowing the sweep\'s read does not narrow what it finds', () => {
  // ⚠️ These ask the NARROW read only. The obvious pin — read the whole type, filter here, compare the
  // sets — costs what the defect cost (41,257 tuples, ~40s) on every suite run, which is the bill this
  // change exists to stop paying. That comparison was made once, on this store, and is recorded with
  // the change: identical sets, 41,705ms against 20ms. What remains here is the part that can go
  // wrong later, measured cheaply: the filter must include the marker and exclude everything else.
  it('the marker this fixture wrote is in the answer — nothing trashed is missed', async () => {
    // The failure that matters: if the store's relation filter ever answered with less, the sweep
    // would stop seeing markers and expired pages would quietly never be purged. A retention promise
    // failing silently is worth a test; a stopwatch is not.
    const narrow = await readUserTuplesByType(fgaClient, 'user:*', 'page:', 'trashed')
    expect(narrow.map((t) => t.object)).toContain(`page:${trashedPage}`)
  }, 300_000)

  it('the public marker is NOT in it, so the filter is doing something', async () => {
    // Without this, an implementation that ignored the argument would satisfy the assertion above by
    // returning everything. Both wildcard shapes live on pages — `view_base@user:*` is what makes a
    // page public and is the overwhelming majority in a real store — so excluding one is the property.
    const narrow = await readUserTuplesByType(fgaClient, 'user:*', 'page:', 'trashed')
    expect(narrow.map((t) => t.object)).not.toContain(`page:${publicPage}`)
    expect(narrow.every((t) => t.relation === 'trashed'), 'every tuple it returned is the relation asked for').toBe(true)
  }, 300_000)
})
