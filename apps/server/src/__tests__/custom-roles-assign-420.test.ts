// #420 / ADR-164 increment 3: the ASSIGNMENT write-path (role → fixed-relation tuple expansion).
// Anti-tests:
//  (1) assign expands to the capability leaves (FGA checks flip), provenance recorded; unassign
//      reverts them.
//  (2)REFERENCE COUNT, other-role case: two roles sharing a capability on the same
//      principal+resource — unassigning one keeps the shared leaf; unassigning both removes it.
//  (3)ownership case: a capability granted DIRECTLY before the role is assigned is NOT owned
//      by the assignment and survives unassign.
//  (4) space-scope: expansion writes the space relations (page verbs arrive via inheritance on a
//      published page); a role with a space-inapplicable capability (comment) is refused whole.
//  (5) guest boundary + entitlement: share_link/user:* principals 400; customRoles OFF refuses
//      assign/unassign (issuance semantics).
// Real Postgres + OpenFGA + the app via inject (dev bearer = tenant admin dev-user).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { registerEntitlementsResolver, resetEntitlementsResolver, UNLIMITED } from '@wikistead/entitlements'
import { fgaClient, check, writeTuples } from '@wikistead/authz'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { LogicalSearchDriver } from '../search/index.js'
import { buildApp } from '../app.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, grantPageAccess } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
const driver = new LogicalSearchDriver()

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string
const P = (id: string) => ({ type: 'page' as const, id })

async function makeRole(name: string, capabilities: string[]): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/admin/roles', headers: H, payload: { name, capabilities } })
  expect(r.statusCode, `create role ${name}`).toBe(201)
  return (r.json() as { id: string }).id
}
async function assign(roleId: string, resourceType: string, resourceId: string, principal: string) {
  return app.inject({ method: 'POST', url: `/admin/roles/${roleId}/assignments`, headers: H, payload: { resourceType, resourceId, principal } })
}
async function unassign(assignmentId: string) {
  return app.inject({ method: 'DELETE', url: `/admin/roles/assignments/${assignmentId}`, headers: H })
}

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  app = await buildApp()
  await app.ready()
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'cra420' })).id
  pageId = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'assign target' })).id
  // Publish-shape tuples so space-scoped capabilities can reach the page.
  await writeTuples(fgaClient, [
    { user: `space:${spaceId}`, relation: 'space', object: `page:${pageId}` },
    { user: 'user:*', relation: 'published', object: `page:${pageId}` },
    { user: 'share_link:*', relation: 'published', object: `page:${pageId}` },
  ])
}, 60_000)

afterAll(async () => {
  resetEntitlementsResolver()
  await admin`DELETE FROM role_assignments WHERE tenant_id = ${tenant.id}`
  await admin`DELETE FROM roles WHERE tenant_id = ${tenant.id} AND name LIKE 'cra420%'`
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await app?.close()
  await db.release()
  await pool.end()
  await admin.end()
}, 60_000)

describe('role assignment expansion (#420 increment 3)', () => {
  it('anti-test 1: assign expands to the leaves (checks flip true), provenance recorded; unassign reverts', async () => {
    const roleId = await makeRole('cra420-recycler', ['delete', 'view'])
    const u = 'user:cra420-alice'
    const res = await assign(roleId, 'page', pageId, u)
    expect(res.statusCode).toBe(201)
    const { id: asgId, ownedCapabilities } = res.json() as { id: string; ownedCapabilities: string[] }
    expect(ownedCapabilities.sort()).toEqual(['delete', 'view'])
    expect(await check(fgaClient, u, 'delete', P(pageId))).toBe(true)
    expect(await check(fgaClient, u, 'view', P(pageId))).toBe(true)
    expect(await check(fgaClient, u, 'edit', P(pageId))).toBe(false)
    // provenance listed on the resource
    const list = (await app.inject({ method: 'GET', url: `/admin/roles/assignments?resourceType=page&resourceId=${pageId}`, headers: H })).json() as { principal: string; roleName: string }[]
    expect(list.some((a) => a.principal === u && a.roleName === 'cra420-recycler')).toBe(true)
    // duplicate assignment → 409
    expect((await assign(roleId, 'page', pageId, u)).statusCode).toBe(409)

    expect((await unassign(asgId)).statusCode).toBe(204)
    expect(await check(fgaClient, u, 'delete', P(pageId))).toBe(false)
    expect(await check(fgaClient, u, 'view', P(pageId))).toBe(false)
  })

  it('anti-test 2 (, other-role case): a leaf two roles produce survives one unassign, dies after both', async () => {
    const r1 = await makeRole('cra420-del-a', ['delete'])
    const r2 = await makeRole('cra420-del-b', ['delete', 'comment'])
    const u = 'user:cra420-bob'
    const a1 = (await assign(r1, 'page', pageId, u)).json() as { id: string; ownedCapabilities: string[] }
    const a2res = await assign(r2, 'page', pageId, u)
    const a2 = a2res.json() as { id: string; ownedCapabilities: string[] }
    // The second assignment did not re-create the delete leaf (already exists) — not owned.
    expect(a2.ownedCapabilities).not.toContain('delete')
    expect(a2.ownedCapabilities).toContain('comment')

    expect((await unassign(a1.id)).statusCode).toBe(204)
    // r2 still includes 'delete' → the shared leaf must SURVIVE (themulti-source pin), and
    // OWNERSHIP TRANSFERS to r2's assignment (else unassigning the coverer later would orphan it).
    expect(await check(fgaClient, u, 'delete', P(pageId)), 'shared leaf survives the first unassign').toBe(true)
    expect((await unassign(a2.id)).statusCode).toBe(204)
    expect(await check(fgaClient, u, 'delete', P(pageId)), 'the last covering assignment removes the leaf (no orphan)').toBe(false)
    expect(await check(fgaClient, u, 'comment', P(pageId)), 'comment leaf removed with its owner').toBe(false)
  })

  it('anti-test 3 (, direct-grant case): a directly-granted capability survives role unassign', async () => {
    const u = 'user:cra420-carol'
    await grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: 'dev-user', grantee: u, relation: 'share' })
    const roleId = await makeRole('cra420-sharer', ['share', 'settings'])
    const res = await assign(roleId, 'page', pageId, u)
    const a = res.json() as { id: string; ownedCapabilities: string[] }
    expect(a.ownedCapabilities, 'pre-existing direct grant is NOT owned').not.toContain('share')
    expect(a.ownedCapabilities).toContain('settings')
    expect((await unassign(a.id)).statusCode).toBe(204)
    expect(await check(fgaClient, u, 'share', P(pageId)), 'the direct grant survives').toBe(true)
    expect(await check(fgaClient, u, 'settings', P(pageId)), 'the owned leaf is removed').toBe(false)
  })

  it('anti-test 4: space-scope expansion — publisher via inheritance; comment-bearing roles refused at space scope', async () => {
    const roleId = await makeRole('cra420-publisher', ['publish'])
    const u = 'user:cra420-dave'
    const res = await assign(roleId, 'space', spaceId, u)
    expect(res.statusCode).toBe(201)
    const a = res.json() as { id: string }
    expect(await check(fgaClient, u, 'publish', P(pageId)), 'publisher reaches the published page via the space').toBe(true)
    expect(await check(fgaClient, u, 'edit', P(pageId))).toBe(false)
    expect((await unassign(a.id)).statusCode).toBe(204)
    expect(await check(fgaClient, u, 'publish', P(pageId))).toBe(false)

    const commentRole = await makeRole('cra420-commenter', ['comment', 'view'])
    const bad = await assign(commentRole, 'space', spaceId, u)
    expect(bad.statusCode, 'comment has no space-scoped relation — whole assignment refused').toBe(400)
    expect(await check(fgaClient, u, 'view', P(pageId)), 'no partial expansion').toBe(false)
  })

  it('anti-test 5: guest principals 400; entitlement OFF refuses assign/unassign', async () => {
    const roleId = await makeRole('cra420-gate', ['view'])
    for (const principal of ['share_link:cra420-x', 'user:*', 'page:whatever']) {
      const r = await assign(roleId, 'page', pageId, principal)
      expect(r.statusCode, principal).toBe(400)
    }
    registerEntitlementsResolver(() => ({ ...UNLIMITED, customRoles: false }))
    try {
      expect((await assign(roleId, 'page', pageId, 'user:cra420-eve')).statusCode).toBe(403)
      expect((await unassign('any-id')).statusCode).toBe(403)
    } finally {
      resetEntitlementsResolver()
    }
  })
})
