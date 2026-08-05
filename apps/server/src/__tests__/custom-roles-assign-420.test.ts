// #420 / ADR-164 increment 3: the ASSIGNMENT write-path (role → fixed-relation tuple expansion).
// Anti-tests:
//  (1) assign expands to the capability leaves (FGA checks flip), provenance recorded; unassign
//      reverts them.
//  (2) REFERENCE COUNT, other-role case: two roles sharing a capability on the same
//      principal+resource — unassigning one keeps the shared leaf; unassigning both removes it.
//  (3) ownership case: a capability granted DIRECTLY before the role is assigned is NOT owned
//      by the assignment and survives unassign.
//  (4) space-scope: expansion writes the space relations (page verbs arrive via inheritance on a
//      published page); a role with a space-inapplicable capability (comment) is refused whole.
//  (5) guest boundary + entitlement: share_link/user:* principals 400; customRoles OFF refuses
//      assign/unassign (issuance semantics).
// Real Postgres + OpenFGA + the app via inject (dev bearer = tenant admin dev-user).
import { seatMembers, unseatMembers } from './helpers/seat-members.js'
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
const seated = new Set<string>() // #624: subs this file seated, removed in afterAll
async function assign(roleId: string, resourceType: string, resourceId: string, principal: string) {
  // #624: a role assignment names somebody who is HERE — the route refuses a principal with no members
  // row now. Seated here so every case in this file keeps meaning "a member, who is then assigned".
  if (principal.startsWith('user:')) {
    seated.add(principal.slice('user:'.length))
    await seatMembers(admin, tenant.id, [principal.slice('user:'.length)])
  }
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
  await unseatMembers(admin, tenant.id, [...seated])
  resetEntitlementsResolver()
  // Scoped to the roles THIS file created. The wholesale delete that used to be here also removed the
  // assignments of every other suite file sharing `tenant_dev` — the shape of defect that made the
  // audit assertions flake (#482). It was redundant besides: role_assignments.role_id is
  // ON DELETE CASCADE, so the prefixed `roles` delete on the next line already takes them.
  await admin`DELETE FROM role_assignments WHERE tenant_id = ${tenant.id} AND role_id IN (SELECT id FROM roles WHERE tenant_id = ${tenant.id} AND name LIKE 'cra420%')`
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

    expect((await unassign(asgId)).statusCode).toBe(200) // #596: 200 + honesty payload
    expect(await check(fgaClient, u, 'delete', P(pageId))).toBe(false)
    expect(await check(fgaClient, u, 'view', P(pageId))).toBe(false)
  })

  it('anti-test 2 (other-role case): a leaf two roles produce survives one unassign, dies after both', async () => {
    const r1 = await makeRole('cra420-del-a', ['delete'])
    const r2 = await makeRole('cra420-del-b', ['delete', 'comment'])
    const u = 'user:cra420-bob'
    const a1 = (await assign(r1, 'page', pageId, u)).json() as { id: string; ownedCapabilities: string[] }
    const a2res = await assign(r2, 'page', pageId, u)
    const a2 = a2res.json() as { id: string; ownedCapabilities: string[] }
    // The second assignment did not re-create the delete leaf (already exists) — not owned.
    expect(a2.ownedCapabilities).not.toContain('delete')
    expect(a2.ownedCapabilities).toContain('comment')

    expect((await unassign(a1.id)).statusCode).toBe(200) // #596
    // r2 still includes 'delete' → the shared leaf must SURVIVE (the multi-source pin), and
    // OWNERSHIP TRANSFERS to r2's assignment (else unassigning the coverer later would orphan it).
    expect(await check(fgaClient, u, 'delete', P(pageId)), 'shared leaf survives the first unassign').toBe(true)
    expect((await unassign(a2.id)).statusCode).toBe(200) // #596
    expect(await check(fgaClient, u, 'delete', P(pageId)), 'the last covering assignment removes the leaf (no orphan)').toBe(false)
    expect(await check(fgaClient, u, 'comment', P(pageId)), 'comment leaf removed with its owner').toBe(false)
  })

  it('anti-test 3 (direct-grant case): a directly-granted capability survives role unassign', async () => {
    const u = 'user:cra420-carol'
    await grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: 'dev-user', grantee: u, relation: 'share' })
    const roleId = await makeRole('cra420-sharer', ['share', 'settings'])
    const res = await assign(roleId, 'page', pageId, u)
    const a = res.json() as { id: string; ownedCapabilities: string[] }
    expect(a.ownedCapabilities, 'pre-existing direct grant is NOT owned').not.toContain('share')
    expect(a.ownedCapabilities).toContain('settings')
    expect((await unassign(a.id)).statusCode).toBe(200) // #596
    expect(await check(fgaClient, u, 'share', P(pageId)), 'the direct grant survives').toBe(true)
    expect(await check(fgaClient, u, 'settings', P(pageId)), 'the owned leaf is removed').toBe(false)
  })

  it('anti-test 4: space-scope expansion — publisher via inheritance; comment expands too (#529)', async () => {
    const roleId = await makeRole('cra420-publisher', ['publish'])
    const u = 'user:cra420-dave'
    const res = await assign(roleId, 'space', spaceId, u)
    expect(res.statusCode).toBe(201)
    const a = res.json() as { id: string }
    expect(await check(fgaClient, u, 'publish', P(pageId)), 'publisher reaches the published page via the space').toBe(true)
    expect(await check(fgaClient, u, 'edit', P(pageId))).toBe(false)
    expect((await unassign(a.id)).statusCode).toBe(200) // #596
    expect(await check(fgaClient, u, 'publish', P(pageId))).toBe(false)

    // #529 / ADR-193: `comment` gained its space leaf (space#commenter), so a comment-bearing role is
    // assignable at space scope now — it used to be refused outright, which is exactly the gap that
    // ticket closed. The grant must reach the space's pages as COMMENT, and stay short of edit.
    const commentRole = await makeRole('cra420-commenter', ['comment', 'view'])
    const ok = await assign(commentRole, 'space', spaceId, u)
    expect(ok.statusCode, 'comment IS assignable at space scope (#529)').toBe(201)
    const c = ok.json() as { id: string }
    expect(await check(fgaClient, u, 'comment', P(pageId)), 'the space grant reaches the page').toBe(true)
    expect(await check(fgaClient, u, 'edit', P(pageId)), 'and confers no edit').toBe(false)
    expect((await unassign(c.id)).statusCode).toBe(200) // #596
    expect(await check(fgaClient, u, 'comment', P(pageId)), 'revoked cleanly').toBe(false)
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
      // RE-AIMED by #603 / ADR-207 §R4-3: the entitlement gate applies to GRANTING, never to revoking
      // — a plan gate that blocks removal strands the power when a tenant downgrades (fail-open). With
      // no gate in the way, an unknown assignment id is the uniform 404.
      expect((await unassign('any-id')).statusCode).toBe(404)
    } finally {
      resetEntitlementsResolver()
    }
  })
})

describe('role-edit re-expansion (#420 increment 4, Fork B1)', () => {
  it('adding a capability grants it to every live assignment; removing revokes it — with the multi-source guard', async () => {
    const r1 = await makeRole('cra420-evolve', ['view'])
    const r2 = await makeRole('cra420-cover', ['delete'])
    const u = 'user:cra420-frank'
    const a1 = (await assign(r1, 'page', pageId, u)).json() as { id: string }
    const a2 = (await assign(r2, 'page', pageId, u)).json() as { id: string }
    try {
      expect(await check(fgaClient, u, 'delete', P(pageId))).toBe(true) // via r2
      // EDIT r1: add delete + settings → live re-expansion. delete already exists (r2 owns) → not owned here.
      const put1 = await app.inject({ method: 'PUT', url: `/admin/roles/${r1}`, headers: H, payload: { name: 'cra420-evolve', capabilities: ['view', 'delete', 'settings'] } })
      expect(put1.statusCode).toBe(200)
      expect(await check(fgaClient, u, 'settings', P(pageId)), 'added capability granted live').toBe(true)
      // EDIT r1: remove delete+settings again. settings (owned by r1's assignment) is revoked; delete
      // is STILL covered by r2 → the shared leaf survives (the role-edit reinforcement).
      const put2 = await app.inject({ method: 'PUT', url: `/admin/roles/${r1}`, headers: H, payload: { name: 'cra420-evolve', capabilities: ['view'] } })
      expect(put2.statusCode).toBe(200)
      expect(await check(fgaClient, u, 'settings', P(pageId)), 'removed capability revoked everywhere').toBe(false)
      expect(await check(fgaClient, u, 'delete', P(pageId)), 'a leaf another role still covers survives').toBe(true)
      // r2's edit removing delete now takes the leaf with it (last source).
      const put3 = await app.inject({ method: 'PUT', url: `/admin/roles/${r2}`, headers: H, payload: { name: 'cra420-cover', capabilities: ['comment'] } })
      expect(put3.statusCode).toBe(200)
      expect(await check(fgaClient, u, 'delete', P(pageId)), 'last covering source removes the leaf').toBe(false)
      expect(await check(fgaClient, u, 'comment', P(pageId)), 'swap-in capability granted').toBe(true)
    } finally {
      await unassign(a1.id)
      await unassign(a2.id)
    }
  })

  it('a direct grant survives a role-edit removal (ownership guard); a resource role refuses a TENANT capability', async () => {
    const u = 'user:cra420-grace'
    await grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: 'dev-user', grantee: u, relation: 'publish' })
    const roleId = await makeRole('cra420-pub2', ['publish', 'view'])
    const a = (await assign(roleId, 'page', pageId, u)).json() as { id: string }
    const sAsg = (await assign(roleId, 'space', spaceId, 'user:cra420-heidi')).json() as { id: string }
    try {
      // Remove publish from the role: the page assignment never owned it (direct grant first) → survives.
      const put = await app.inject({ method: 'PUT', url: `/admin/roles/${roleId}`, headers: H, payload: { name: 'cra420-pub2', capabilities: ['view'] } })
      expect(put.statusCode).toBe(200)
      expect(await check(fgaClient, u, 'publish', P(pageId)), 'direct grant survives the role edit').toBe(true)
      // #529 / ADR-193: `comment` is space-assignable now, so the old "space-inapplicable capability"
      // case no longer exists for resource roles. The rule that still refuses a mismatched addition is
      // the tenant/resource split: a RESOURCE role cannot carry a TENANT capability.
      const bad = await app.inject({ method: 'PUT', url: `/admin/roles/${roleId}`, headers: H, payload: { name: 'cra420-pub2', capabilities: ['view', 'createSpaces'] } })
      expect(bad.statusCode).toBe(400)
      const [role] = await admin<{ capabilities: string[] }[]>`SELECT capabilities FROM roles WHERE id = ${roleId}`
      expect(role!.capabilities).toEqual(['view'])
    } finally {
      await unassign(a.id)
      await unassign(sAsg.id)
    }
  })

  // #523 / ADR-190 (slice E): the assignment list NAMES its user principals, so the in-space role picker
  // stops showing a raw sub for an un-customised member (the last hash on that screen). The disclosure is
  // bounded exactly as slice A's grant list is: this endpoint is requireListAuthority-gated and answers for
  // ONE resource, so it is a server-set view-gated set — NOT an arbitrary-sub lookup. The oracle boundary
  // (/members/identities stays customized-only) is asserted here too, so a later change cannot widen it
  // silently.
  it('#523 slice E: user principals are named on the gated list; the arbitrary-sub oracle stays closed', async () => {
    const sub = 'cra420-named'
    // An UN-CUSTOMISED member: an OIDC display_name, no override and no avatar. Under the old
    // customized-only lookup this member resolved to nothing and the UI printed the raw sub.
    await admin`INSERT INTO members (tenant_id, sub, role, display_name) VALUES (${tenant.id}, ${sub}, 'member', 'Naomi Ito')
                ON CONFLICT (tenant_id, sub) DO UPDATE SET display_name = 'Naomi Ito', display_name_override = NULL, avatar_image_key = NULL`
    const roleId = await makeRole('cra420-named-role', ['view'])
    const a = (await assign(roleId, 'space', spaceId, `user:${sub}`)).json() as { id: string }
    try {
      const list = (await app.inject({ method: 'GET', url: `/admin/roles/assignments?resourceType=space&resourceId=${spaceId}`, headers: H }))
        .json() as { principal: string; displayName?: string | null }[]
      const row = list.find((r) => r.principal === `user:${sub}`)
      expect(row, 'the assignment is listed').toBeTruthy()
      expect(row!.displayName, 'an un-customised member resolves to their OIDC name, not a sub').toBe('Naomi Ito')

      // A GROUP principal carries its own name and is never resolved through the member table.
      const gAsg = (await assign(roleId, 'space', spaceId, 'group:cra420-grp#member')).json() as { id: string }
      try {
        const withGroup = (await app.inject({ method: 'GET', url: `/admin/roles/assignments?resourceType=space&resourceId=${spaceId}`, headers: H }))
          .json() as { principal: string; displayName?: string | null }[]
        expect(withGroup.find((r) => r.principal.startsWith('group:'))!.displayName, 'groups are not name-resolved').toBeUndefined()
      } finally { await unassign(gAsg.id) }

      // ORACLE BOUNDARY (unchanged): the arbitrary-sub endpoint still answers customized-only, so this
      // same member — nameable on the gated list above — is NOT nameable by asking about a sub directly.
      const probe = (await app.inject({ method: 'POST', url: '/members/identities', headers: H, payload: { subs: [sub] } }))
        .json() as { identities: Record<string, unknown> }
      expect(probe.identities[sub], 'an un-customised member is not disclosed by arbitrary-sub lookup').toBeUndefined()
    } finally {
      await unassign(a.id)
      await admin`DELETE FROM members WHERE tenant_id = ${tenant.id} AND sub = ${sub}`.catch(() => {})
    }
  })
})
