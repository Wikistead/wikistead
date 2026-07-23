// #497 / ADR-183: declarative group → role MAPPINGS. authz-critical anti-tests — a mapping is a ROW
// that OWNS a group-principal role assignment; it rides the existing #111 group-sync + assign/
// unassign path and adds NO new FGA write path. The strong pins:
//  (1) end-to-end: a mapping to group "Eng" → a member SYNCED into that group gets the role's leaves
//      LIVE (group#member resolves at check time); deleting the mapping reverts them and drops the
//      assignment (the unassign). The assignment carries origin='mapping'.
//  (2) custom-only: a built-in / unknown role id 404s (built-ins are virtual — no roles row).
//  (3) scope: a tenant role at space scope 400s; page scope is refused at the resourceType gate.
//  (4) orphan badge: a mapping whose group name no member carries is flagged orphaned (never migrated).
//  (5) entitlement gate: customRoles OFF refuses create.
// Real Postgres + OpenFGA + the app via inject (dev bearer = tenant admin dev-user).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { registerEntitlementsResolver, resetEntitlementsResolver, UNLIMITED } from '@wikistead/entitlements'
import { fgaClient, check, writeTuples, deleteTuples } from '@wikistead/authz'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { LogicalSearchDriver } from '../search/index.js'
import { buildApp } from '../app.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { groupGrantee, groupFgaId, syncMemberGroups } from '../auth/group-sync.js'
import { ensureMembers, memberTuples } from './helpers/membership.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' } // dev-user = tenant admin
const driver = new LogicalSearchDriver()
const tag = Date.now().toString(36)
const MEMBER = `grm497-plain-${Date.now().toString(36)}` // a non-admin member (session cookie)
const MGR = `grm497-mgr-${Date.now().toString(36)}` // a SPACE manager of spaceId (not a tenant admin)
let memberSid = ''
let mgrSid = ''
const HMEMBER = () => ({ host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${memberSid}` })
const HMGR = () => ({ host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${mgrSid}` })

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string
const P = (id: string) => ({ type: 'page' as const, id })

async function makeRole(name: string, capabilities: string[], scope = 'resource'): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/admin/roles', headers: H, payload: { name, capabilities, scope } })
  expect(r.statusCode, `create role ${name}`).toBe(201)
  return (r.json() as { id: string }).id
}
async function createMapping(body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/admin/roles/mappings', headers: H, payload: body })
}
async function listMappings() {
  return (await app.inject({ method: 'GET', url: '/admin/roles/mappings', headers: H })).json() as {
    id: string; groupName: string; roleId: string; roleName: string; resourceType: string; resourceId: string; assignmentId: string | null; orphaned: boolean
  }[]
}
async function deleteMapping(id: string) {
  return app.inject({ method: 'DELETE', url: `/admin/roles/mappings/${id}`, headers: H })
}

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  app = await buildApp()
  await app.ready()
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `grm497-${tag}` })).id
  pageId = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'grm target' })).id
  // Publish-shape tuples so a space-scoped capability reaches the page.
  await writeTuples(fgaClient, [
    { user: `space:${spaceId}`, relation: 'space', object: `page:${pageId}` },
    { user: 'user:*', relation: 'published', object: `page:${pageId}` },
    { user: 'share_link:*', relation: 'published', object: `page:${pageId}` },
  ])
  // A plain (non-admin) member and a SPACE MANAGER of spaceId, both with real sessions — for the
  // per-scope authority pins (ADR-183 §1 / #485: a space manager may map a role in their own space).
  await ensureMembers(tenant.id, [MEMBER, MGR])
  await admin`INSERT INTO members (tenant_id, sub, role) VALUES (${tenant.id}, ${MEMBER}, 'member'), (${tenant.id}, ${MGR}, 'member') ON CONFLICT (tenant_id, sub) DO NOTHING`
  await writeTuples(fgaClient, [{ user: `user:${MGR}`, relation: 'manager', object: `space:${spaceId}` }])
  memberSid = await createSession(valkey, { tenantId: tenant.id, sub: MEMBER, role: 'member' })
  mgrSid = await createSession(valkey, { tenantId: tenant.id, sub: MGR, role: 'member' })
}, 60_000)

afterAll(async () => {
  resetEntitlementsResolver()
  await admin`DELETE FROM group_role_mappings WHERE tenant_id = ${tenant.id}`
  await admin`DELETE FROM role_assignments WHERE tenant_id = ${tenant.id}`
  await admin`DELETE FROM roles WHERE tenant_id = ${tenant.id} AND name LIKE 'grm497%'`
  await admin`DELETE FROM members WHERE tenant_id = ${tenant.id} AND sub LIKE 'grm497%'`
  await deleteTuples(fgaClient, memberTuples(tenant.id, [MEMBER, MGR])).catch(() => {})
  await deleteTuples(fgaClient, [{ user: `user:${MGR}`, relation: 'manager', object: `space:${spaceId}` }]).catch(() => {})
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await app?.close()
  await db.release()
  await valkey.quit()
  await pool.end()
  await admin.end()
}, 60_000)

describe('group → role mappings (#497 / ADR-183)', () => {
  it('anti-test 1 (end-to-end): a mapping grants the role to a synced group member LIVE; delete reverts it', async () => {
    const roleId = await makeRole('grm497-editor', ['edit', 'view'], 'resource')
    const groupName = `Eng-${tag}`
    const member = `grm497-alice-${tag}`
    // A member synced into the group (the #111 FGA group#member tuple — the real login path).
    await syncMemberGroups(fgaClient, tenant.id, member, [], [groupName])
    // Before the mapping: the member has nothing on the page.
    expect(await check(fgaClient, `user:${member}`, 'edit', P(pageId))).toBe(false)

    const res = await createMapping({ groupName, roleId, resourceType: 'space', resourceId: spaceId })
    expect(res.statusCode).toBe(201)
    const { id: mappingId, assignmentId } = res.json() as { id: string; assignmentId: string }
    // The assignment landed on group:<id>#member (the SAME id the sync wrote) with origin='mapping'.
    const [asg] = await admin<{ principal: string; origin: string }[]>`SELECT principal, origin FROM role_assignments WHERE id = ${assignmentId}`
    expect(asg!.principal).toBe(groupGrantee(tenant.id, groupName))
    expect(asg!.principal).toBe(`group:${groupFgaId(tenant.id, groupName)}#member`)
    expect(asg!.origin).toBe('mapping')
    // The synced member now reaches the role's leaves through group membership, LIVE.
    expect(await check(fgaClient, `user:${member}`, 'edit', P(pageId)), 'group member gets edit via the mapping').toBe(true)
    expect(await check(fgaClient, `user:${member}`, 'view', P(pageId))).toBe(true)

    // Delete the mapping → the unassign reverts the leaves and drops both rows.
    expect((await deleteMapping(mappingId)).statusCode).toBe(204)
    expect(await check(fgaClient, `user:${member}`, 'edit', P(pageId)), 'mapping delete revokes the leaf').toBe(false)
    const [{ n }] = await admin<[{ n: string }]>`SELECT count(*)::text AS n FROM role_assignments WHERE id = ${assignmentId}`
    expect(n).toBe('0')
    const [{ m }] = await admin<[{ m: string }]>`SELECT count(*)::text AS m FROM group_role_mappings WHERE id = ${mappingId}`
    expect(m).toBe('0')
  })

  it('anti-test 2 (custom-only): a built-in / unknown role id 404s (built-ins have no roles row)', async () => {
    for (const roleId of ['owner', 'editor', 'viewer', `nope-${tag}`]) {
      const r = await createMapping({ groupName: `Any-${tag}`, roleId, resourceType: 'space', resourceId: spaceId })
      expect(r.statusCode, `built-in/unknown ${roleId}`).toBe(404)
    }
  })

  it('anti-test 3 (scope): a tenant role at space scope 400s; page scope is refused', async () => {
    const tenantRole = await makeRole('grm497-tenrole', ['createSpaces'], 'tenant')
    const spaceRole = await makeRole('grm497-sprole', ['view'], 'resource')
    // tenant role mapped at space scope → 400 (scope mismatch)
    expect((await createMapping({ groupName: `X-${tag}`, roleId: tenantRole, resourceType: 'space', resourceId: spaceId })).statusCode).toBe(400)
    // space role mapped at tenant scope → 400 (scope mismatch)
    expect((await createMapping({ groupName: `X-${tag}`, roleId: spaceRole, resourceType: 'tenant', resourceId: tenant.id })).statusCode).toBe(400)
    // page scope is out of v1 — refused at the resourceType gate (400), not silently accepted
    expect((await createMapping({ groupName: `X-${tag}`, roleId: spaceRole, resourceType: 'page', resourceId: pageId })).statusCode).toBe(400)
    // no assignment leaked from any of the rejects
    const [{ n }] = await admin<[{ n: string }]>`SELECT count(*)::text AS n FROM role_assignments WHERE tenant_id = ${tenant.id} AND origin = 'mapping'`
    expect(n).toBe('0')
  })

  it('anti-test 4 (orphan badge): a mapping whose group no member carries is flagged orphaned', async () => {
    const roleId = await makeRole('grm497-badge', ['view'], 'resource')
    const liveGroup = `Live-${tag}`
    const goneGroup = `Gone-${tag}`
    // A member carries liveGroup in members.groups (the badge reads the DB column, not FGA).
    await admin`INSERT INTO members (tenant_id, sub, role, groups) VALUES (${tenant.id}, ${`grm497-bob-${tag}`}, 'member', ${[liveGroup]}) ON CONFLICT (tenant_id, sub) DO UPDATE SET groups = EXCLUDED.groups`
    const live = await createMapping({ groupName: liveGroup, roleId, resourceType: 'space', resourceId: spaceId })
    const gone = await createMapping({ groupName: goneGroup, roleId, resourceType: 'space', resourceId: spaceId })
    expect(live.statusCode).toBe(201)
    expect(gone.statusCode).toBe(201)
    const rows = await listMappings()
    const liveRow = rows.find((r) => r.groupName === liveGroup)!
    const goneRow = rows.find((r) => r.groupName === goneGroup)!
    expect(liveRow.orphaned, 'a group a member carries is NOT orphaned').toBe(false)
    expect(goneRow.orphaned, 'a group no member carries IS orphaned').toBe(true)
    await deleteMapping(liveRow.id)
    await deleteMapping(goneRow.id)
  })

  it('anti-test 5 (cross-tenant / existence bind): an unknown space id and a foreign tenant id are a uniform 404', async () => {
    const roleId = await makeRole('grm497-bind', ['view'], 'resource')
    const tenantRole = await makeRole('grm497-bindten', ['createSpaces'], 'tenant')
    // A space id not visible under this tenant's RLS handle (cross-tenant / nonexistent are
    // indistinguishable — that IS the existence-hiding, #445 bind) → 404, never a 403 that confirms it.
    expect((await createMapping({ groupName: `B-${tag}`, roleId, resourceType: 'space', resourceId: `no-such-space-${tag}` })).statusCode).toBe(404)
    // A tenant-scoped mapping bound to a FOREIGN tenant id must 404 (the caller may only map its own).
    expect((await createMapping({ groupName: `B-${tag}`, roleId: tenantRole, resourceType: 'tenant', resourceId: `other-tenant-${tag}` })).statusCode).toBe(404)
    // nothing leaked
    const [{ n }] = await admin<[{ n: string }]>`SELECT count(*)::text AS n FROM role_assignments WHERE tenant_id = ${tenant.id} AND origin = 'mapping'`
    expect(n).toBe('0')
  })

  it('anti-test 6 (per-scope authority, ADR-183 §1 / #485): a space MANAGER maps in their own space; a plain member cannot; tenant scope stays admin-only', async () => {
    const spaceRole = await makeRole('grm497-gate2', ['view'], 'resource')
    const tenantRole = await makeRole('grm497-gate2t', ['createSpaces'], 'tenant')
    // A plain member (no space authority) cannot create — 403, and nothing is written.
    const memberCreate = await app.inject({ method: 'POST', url: '/admin/roles/mappings', headers: HMEMBER(), payload: { groupName: `M-${tag}`, roleId: spaceRole, resourceType: 'space', resourceId: spaceId } })
    expect(memberCreate.statusCode, 'a plain member cannot map in a space they do not manage').toBe(403)
    expect((await app.inject({ method: 'GET', url: '/admin/roles/mappings', headers: HMEMBER() })).statusCode, 'the tenant-wide list is admin-only').toBe(403)
    const [{ n0 }] = await admin<[{ n0: string }]>`SELECT count(*)::text AS n0 FROM group_role_mappings WHERE tenant_id = ${tenant.id}`
    expect(n0).toBe('0')

    // The SPACE MANAGER may create a space-scope mapping in their own space (the ADR §1 pin) → 201.
    const mgrCreate = await app.inject({ method: 'POST', url: '/admin/roles/mappings', headers: HMGR(), payload: { groupName: `Mgr-${tag}`, roleId: spaceRole, resourceType: 'space', resourceId: spaceId } })
    expect(mgrCreate.statusCode, 'a space manager maps a role in their own space').toBe(201)
    const mgrMapping = (mgrCreate.json() as { id: string }).id
    // …and may LIST + DELETE it via the per-resource authority, but NOT a tenant-scope mapping.
    expect((await app.inject({ method: 'GET', url: `/admin/roles/mappings?resourceType=space&resourceId=${spaceId}`, headers: HMGR() })).statusCode, 'the manager lists their own space mappings').toBe(200)
    const mgrTenant = await app.inject({ method: 'POST', url: '/admin/roles/mappings', headers: HMGR(), payload: { groupName: `MgrT-${tag}`, roleId: tenantRole, resourceType: 'tenant', resourceId: tenant.id } })
    expect(mgrTenant.statusCode, 'a space manager cannot map a TENANT role — admin-only').toBe(403)
    // The manager deletes their own mapping.
    expect((await app.inject({ method: 'DELETE', url: `/admin/roles/mappings/${mgrMapping}`, headers: HMGR() })).statusCode).toBe(204)
    const [{ n1 }] = await admin<[{ n1: string }]>`SELECT count(*)::text AS n1 FROM group_role_mappings WHERE tenant_id = ${tenant.id}`
    expect(n1, 'no mapping survives the test').toBe('0')
  })

  it('anti-test 7 (entitlement): customRoles OFF refuses create', async () => {
    const roleId = await makeRole('grm497-gate', ['view'], 'resource')
    registerEntitlementsResolver(() => ({ ...UNLIMITED, customRoles: false }))
    try {
      const r = await createMapping({ groupName: `Gate-${tag}`, roleId, resourceType: 'space', resourceId: spaceId })
      expect(r.statusCode).toBe(403)
    } finally {
      resetEntitlementsResolver()
    }
  })
})
