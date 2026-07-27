// #514 / ADR-188 §6, the gate that must exist BEFORE the unification. Built-in space roles are granted
// through one path (spaces.ts CAP_TO_RELATION → a single relation leaf) and custom roles through another
// (roles.ts expansionTuples → the capability bundle). §6 folds the first into the second — and the design
// review caught what makes that dangerous: `manager` is NOT a capability bundle. It is a superset LEAF
// (ROLE_CAPABILITIES has no `manage`, and the built-in manager bundle does not even list `moderate`), so a
// naive "expand manager into its listed capabilities" would silently drop space manage, page
// manage_from_space and moderator from every manager grant.
//
// These pin what a manager grant RESOLVES TO today, per the ADR's mandatory manager→manage and
// manager→moderate equivalences. They are written against the current direct-grant path so the unification
// has something to be equivalent TO: if the folded path ever stops conferring one of these, this goes red
// rather than the loss being discovered by a user who can no longer manage their own space.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, check, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace, grantSpaceAccess } from '../routes/spaces.js'
import { createPage, deletePage, publishPage } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const OWNER = 'dev-user'
const GRANTEE = `builtin-mgr-${Date.now().toString(36)}`

let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: OWNER, plan: tenant.plan, name: 'builtin-equiv-514' })).id
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: OWNER, title: 'managed' })
  pageId = p.id
  await publishPage(db, fgaClient, driver, { putObject: async () => {}, getObject: async () => Buffer.alloc(0) } as never, {
    pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}`,
  })
}, 120_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [{ user: `user:${GRANTEE}`, relation: 'manager', object: `space:${spaceId}` }]).catch(() => {})
  await deletePage(db, fgaClient, driver, { pageId, userId: OWNER }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: OWNER }).catch(() => {})
  await db.release()
  await pool.end()
}, 120_000)

describe('#514 §6 — what a built-in `manager` grant confers (the equivalence the unification must preserve)', () => {
  it('confers space MANAGE and MODERATE, neither of which appears in the built-in capability list', async () => {
    const sub = `user:${GRANTEE}`
    expect(await check(fgaClient, sub, 'manage', { type: 'space', id: spaceId }), 'nothing before the grant').toBe(false)

    await grantSpaceAccess(db, fgaClient, driver, {
      spaceId, tenantId: tenant.id, userId: OWNER, grantee: sub, capability: 'manage', plan: tenant.plan,
    })

    // the two the ADR names as mandatory — both come from the `manager` LEAF, not from any listed capability
    expect(await check(fgaClient, sub, 'manage', { type: 'space', id: spaceId }), 'manager ⇒ space manage').toBe(true)
    expect(await check(fgaClient, sub, 'moderate', { type: 'space', id: spaceId }), 'manager ⇒ moderate (absent from the bundle)').toBe(true)
    // …and it reaches the space's pages, which is what a "manager" is for
    expect(await check(fgaClient, sub, 'manage', { type: 'page', id: pageId }), 'manager ⇒ page manage_from_space').toBe(true)
  }, 120_000)

  it('the listed capabilities resolve too — the superset really is a superset', async () => {
    const sub = `user:${GRANTEE}`
    // Space-level verbs only — `comment` is a PAGE verb (the space type carries the `commenter` grantee
    // relation that pages inherit from, not a `comment` verb of its own), so it is asserted below.
    for (const verb of ['view', 'edit'] as const) {
      expect(await check(fgaClient, sub, verb, { type: 'space', id: spaceId }), `manager ⇒ space ${verb}`).toBe(true)
    }
    for (const verb of ['view', 'edit', 'comment', 'publish', 'delete'] as const) {
      expect(await check(fgaClient, sub, verb, { type: 'page', id: pageId }), `manager ⇒ page ${verb}`).toBe(true)
    }
  }, 120_000)
})
