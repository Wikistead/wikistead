// #485 / ADR-171 Addendum 2 — role ASSIGNMENT opens to SPACE MANAGERS (space + page scope), gated on the
// TARGET resource's authority, with the page grant ceiling extended to the role bundle. authz-critical:
// the anti-tests exercise the authority decision DIRECTLY (like the grant-ceiling test calls
// grantPageAccess with a userId), against real OpenFGA tuples — a false-green would need the model itself
// to be wrong. Real Postgres + OpenFGA.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { requireAssignmentAuthority, requireListAuthority, type AnyRoleCapability } from '../routes/roles.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const tag = Date.now().toString(36)
const ADMIN = 'dev-user' // the dev tenant admin (short-circuits every scope)
const MGR = `ras-mgr-${tag}` // a SPACE manager of spaceA (not a tenant admin)
const SHR = `ras-shr-${tag}` // holds page share_direct on pageA (not a manager)
const OUT = `ras-out-${tag}` // no authority anywhere

let tenant: Tenant
let db: TenantDb
let spaceA: string, spaceB: string, pageA: string, pageB: string, pagePriv: string
const seeded: { user: string; relation: string; object: string }[] = []

const READER: AnyRoleCapability[] = ['view', 'comment', 'edit']
const WITH_ADMIN_CLASS: AnyRoleCapability[] = ['view', 'edit', 'delete'] // `delete` is admin-class → needs manage
const auth = (sub: string, resourceType: 'page' | 'space' | 'tenant', resourceId: string, capabilities: AnyRoleCapability[] = READER) =>
  requireAssignmentAuthority(fgaClient, { sub, tenantId: tenant.id, resourceType, resourceId, capabilities })
const list = (sub: string, resourceType: 'page' | 'space' | 'tenant', resourceId: string) =>
  requireListAuthority(fgaClient, { sub, tenantId: tenant.id, resourceType, resourceId })

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const sa = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: ADMIN, plan: tenant.plan, name: `ras-A-${tag}` })
  const sb = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: ADMIN, plan: tenant.plan, name: `ras-B-${tag}` })
  spaceA = sa.id; spaceB = sb.id
  pageA = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId: spaceA, userId: ADMIN, title: `ras-pA-${tag}` })).id
  pageB = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId: spaceB, userId: ADMIN, title: `ras-pB-${tag}` })).id
  // A PRIVATE page in spaceA — published (page#space) but with the ADR-098 private marker PAIR. The
  // no-back-door invariant: a space manager is cut from it (`manage_from_space … but not private`).
  pagePriv = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId: spaceA, userId: ADMIN, title: `ras-pPriv-${tag}` })).id
  // Publish both pages: publishPage writes `page#space` to release space inheritance (a fresh member
  // draft has none, so it stays creator-only — a space manager is correctly cut until publish). Writing
  // the link directly is the published-page shape without the rest of the publish flow.
  seeded.push({ user: `space:${spaceA}`, relation: 'space', object: `page:${pageA}` })
  seeded.push({ user: `space:${spaceB}`, relation: 'space', object: `page:${pageB}` })
  // pagePriv: published (space link) AND private (the ADR-098 user:*/share_link:* marker pair).
  seeded.push({ user: `space:${spaceA}`, relation: 'space', object: `page:${pagePriv}` })
  seeded.push({ user: 'user:*', relation: 'private', object: `page:${pagePriv}` })
  seeded.push({ user: 'share_link:*', relation: 'private', object: `page:${pagePriv}` })
  // MGR manages spaceA (→ page manage on its non-private published pages via manage_from_space); SHR can
  // only share pageA (a direct grant, not a manager).
  seeded.push({ user: `user:${MGR}`, relation: 'manager', object: `space:${spaceA}` })
  seeded.push({ user: `user:${SHR}`, relation: 'share_direct', object: `page:${pageA}` })
  await writeTuples(fgaClient, seeded)
}, 60_000)

afterAll(async () => {
  await deleteTuples(fgaClient, seeded).catch(() => {})
  await deletePage(db, fgaClient, driver, { pageId: pageA, userId: ADMIN }).catch(() => {})
  await deletePage(db, fgaClient, driver, { pageId: pageB, userId: ADMIN }).catch(() => {})
  await deletePage(db, fgaClient, driver, { pageId: pagePriv, userId: ADMIN }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: spaceA, userId: ADMIN }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: spaceB, userId: ADMIN }).catch(() => {})
  await db.release()
  await pool.end()
}, 60_000)

describe('requireAssignmentAuthority (#485 — space managers may assign in their space)', () => {
  it('a SPACE MANAGER may assign at SPACE scope in their own space; an outsider may not', async () => {
    await expect(auth(MGR, 'space', spaceA)).resolves.toBeUndefined()
    await expect(auth(OUT, 'space', spaceA)).rejects.toMatchObject({ statusCode: 403 })
    // …and not in a space they do not manage
    await expect(auth(MGR, 'space', spaceB)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a SPACE MANAGER may assign at PAGE scope on a (non-private) page in their space, incl. an admin-class bundle', async () => {
    // manage_from_space gives the manager page manage → passes both the share check and the ceiling
    await expect(auth(MGR, 'page', pageA, READER)).resolves.toBeUndefined()
    await expect(auth(MGR, 'page', pageA, WITH_ADMIN_CLASS)).resolves.toBeUndefined()
    // but NOT a page outside their space
    await expect(auth(MGR, 'page', pageB, READER)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('the PAGE GRANT CEILING extends to the bundle: a share-only holder assigns a READER role but not an admin-class one', async () => {
    await expect(auth(SHR, 'page', pageA, READER)).resolves.toBeUndefined() // view/comment/edit — reader class
    await expect(auth(SHR, 'page', pageA, WITH_ADMIN_CLASS)).rejects.toMatchObject({ statusCode: 403 }) // `delete` needs manage
    // the escalation is really closed: SHR has no page manage
    // (a partial grant is impossible — the WHOLE assignment is rejected)
  })

  it('TENANT scope stays admin-only — a space manager cannot assign a tenant role, the admin can', async () => {
    await expect(auth(MGR, 'tenant', tenant.id, ['createSpaces'])).rejects.toMatchObject({ statusCode: 403 })
    await expect(auth(ADMIN, 'tenant', tenant.id, ['createSpaces'])).resolves.toBeUndefined()
  })

  it('a TENANT ADMIN short-circuits every resource scope (non-regression — assigns anywhere as before)', async () => {
    await expect(auth(ADMIN, 'space', spaceB)).resolves.toBeUndefined()
    await expect(auth(ADMIN, 'page', pageB, WITH_ADMIN_CLASS)).resolves.toBeUndefined()
  })

  it('NO BACK DOOR (ADR-098): a space manager is CUT from a PRIVATE page in their own space; the admin is not', async () => {
    // `manage_from_space` / `share_from_space` carry `but not private`, so a private page is creator-only
    // even to the space manager — the assignment gate (page `share`) must 403 for MGR on pagePriv…
    await expect(auth(MGR, 'page', pagePriv, READER), 'manager cut from a private page').rejects.toMatchObject({ statusCode: 403 })
    await expect(auth(MGR, 'page', pagePriv, WITH_ADMIN_CLASS)).rejects.toMatchObject({ statusCode: 403 })
    // …while the tenant admin still reaches it via the short-circuit (non-regression), and the list
    // authority (page manage) is cut for MGR too.
    await expect(auth(ADMIN, 'page', pagePriv, WITH_ADMIN_CLASS)).resolves.toBeUndefined()
    await expect(list(MGR, 'page', pagePriv)).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('requireListAuthority (#485 — no cross-space enumeration)', () => {
  it('a space manager lists their own space/page; an outsider cannot; the admin can list anywhere', async () => {
    await expect(list(MGR, 'space', spaceA)).resolves.toBeUndefined()
    await expect(list(MGR, 'page', pageA)).resolves.toBeUndefined()
    await expect(list(OUT, 'space', spaceA)).rejects.toMatchObject({ statusCode: 403 })
    await expect(list(MGR, 'space', spaceB)).rejects.toMatchObject({ statusCode: 403 })
    await expect(list(ADMIN, 'space', spaceB)).resolves.toBeUndefined()
  })
})
