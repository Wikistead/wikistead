// #497 / ADR-183 §2b: the admin-mapping CRUD surface. Declaring "this IdP group confers tenant admin"
// is the most powerful write in the product, so the gate is pinned rather than assumed: tenant admin
// (never a space manager, who may map SPACE roles under ADR-183 §1 — sharing a route file would have
// invited sharing that gate), plus the customRoles entitlement on the write side.
//
// The other load-bearing behaviour here is DELETE: removing a mapping must revoke the admins it
// materialised NOW, not at the next drift sweep — otherwise the console reports a revocation that the
// authority has not performed yet.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples, isTenantAdmin } from '@wikistead/authz'
import { evaluateAdminMapping } from '../auth/admin-mapping.js'
import { buildApp } from '../app.js'
import { createSession } from '../auth/session.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
// Its own tenant, addressed by its own host — this suite appoints an admin and revokes admins, which in
// the shared dev tenant perturbs the seat/admin counts other suites assert on.
const SLUG = `amr497-${Date.now().toString(36)}`
const HOST = `${SLUG}.localhost`
let TENANT = ''
const asTenant = (id: string): Tenant => ({ id, slug: SLUG, plan: 'business', isolation: 'logical' }) as Tenant
const GROUP = 'idp-admins-routes-497'
const ADMIN = 'amr-admin'
const PLAIN = 'amr-plain'     // an ordinary member — must not be able to declare anything
const TARGET = 'amr-target'   // materialised admin, revoked when the mapping goes
const subs = [ADMIN, PLAIN, TARGET]

let app: FastifyInstance
let db: TenantDb
const cookies: Record<string, string> = {}

const adminTuple = (sub: string) => ({ user: `user:${sub}`, relation: 'admin', object: `tenant:${TENANT}` })

async function seed(sub: string, role: 'admin' | 'member', groups: string[] = []) {
  await db.sql`
    INSERT INTO members (tenant_id, sub, role, admin_origin, groups)
    VALUES (${TENANT}, ${sub}, ${role}, 'manual', ${db.sql.array(groups)})
    ON CONFLICT (tenant_id, sub) DO UPDATE SET role = EXCLUDED.role, admin_origin = 'manual', groups = EXCLUDED.groups`
  await writeTuples(fgaClient, [{ user: `user:${sub}`, relation: 'member', object: `tenant:${TENANT}` }]).catch(() => {})
  if (role === 'admin') await writeTuples(fgaClient, [adminTuple(sub)]).catch(() => {})
  const sid = await createSession(app.valkey, { tenantId: TENANT, sub, role, groups })
  cookies[sub] = `wks_sess=${sid}`
}

const req = (sub: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as 'GET', url, headers: { host: HOST, cookie: cookies[sub]! }, payload: payload as object })

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const [t] = await adminPool<{ id: string }[]>`INSERT INTO tenants (slug, plan) VALUES (${SLUG}, 'business') RETURNING id`
  TENANT = t.id
  db = await acquireTenantDb(asTenant(TENANT))
  await seed(ADMIN, 'admin')
  await seed(PLAIN, 'member')
}, 60_000)

afterAll(async () => {
  for (const sub of subs) {
    await deleteTuples(fgaClient, [adminTuple(sub)]).catch(() => {})
    await deleteTuples(fgaClient, [{ user: `user:${sub}`, relation: 'member', object: `tenant:${TENANT}` }]).catch(() => {})
  }
  await adminPool`DELETE FROM group_admin_mappings WHERE tenant_id = ${TENANT}`.catch(() => {})
  await adminPool`DELETE FROM members WHERE tenant_id = ${TENANT}`.catch(() => {})
  // The tenant row goes away below, so anything still REFERRING to it must go first: an undrained
  // audit_outbox row whose tenant no longer exists can never be drained (withTenantTx cannot resolve it)
  // and just accumulates in the shared stack.
  await adminPool`DELETE FROM audit_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await adminPool`DELETE FROM audit_log WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release(); await app.close()
  await adminPool`DELETE FROM tenants WHERE id = ${TENANT}`.catch(() => {})
  await adminPool.end(); await pool.end()
}, 60_000)

beforeEach(async () => {
  await adminPool`DELETE FROM group_admin_mappings WHERE tenant_id = ${TENANT}`
  await deleteTuples(fgaClient, [adminTuple(TARGET)]).catch(() => {})
  await adminPool`DELETE FROM members WHERE sub = ${TARGET}`
})

describe('#497 §2b admin-mapping routes — only a tenant admin may declare an admin group', () => {
  it('an ordinary member cannot create, list or delete a mapping', async () => {
    expect((await req(PLAIN, 'POST', '/admin/roles/admin-mappings', { groupName: GROUP })).statusCode).toBe(403)
    expect((await req(PLAIN, 'GET', '/admin/roles/admin-mappings')).statusCode).toBe(403)
    expect((await req(PLAIN, 'DELETE', '/admin/roles/admin-mappings/whatever')).statusCode).toBe(403)
    expect(await adminPool`SELECT 1 FROM group_admin_mappings WHERE tenant_id = ${TENANT}`).toHaveLength(0)
  })

  it('an admin creates one, and creating it does NOT retro-promote the group members', async () => {
    await seed(TARGET, 'member', [GROUP])
    const res = await req(ADMIN, 'POST', '/admin/roles/admin-mappings', { groupName: GROUP })
    expect(res.statusCode).toBe(201)
    // A mass promotion on create would be exactly the silent grant option (a) was rejected for; each
    // member is materialised at a moment we can attribute (their login / a SCIM change).
    expect(await isTenantAdmin(fgaClient, TARGET, TENANT)).toBe(false)

    const list = await req(ADMIN, 'GET', '/admin/roles/admin-mappings')
    expect(list.json().mappings).toHaveLength(1)
    expect(list.json().mappings[0]).toMatchObject({ groupName: GROUP })
  })

  it('deleting a mapping REVOKES the admins it materialised, immediately', async () => {
    const created = await req(ADMIN, 'POST', '/admin/roles/admin-mappings', { groupName: GROUP })
    const { id } = created.json()
    await seed(TARGET, 'member', [GROUP])
    await evaluateAdminMapping(db, fgaClient, { id: TENANT, plan: 'business' }, TARGET, [GROUP]) // their "login"
    expect(await isTenantAdmin(fgaClient, TARGET, TENANT), 'materialised first').toBe(true)

    const del = await req(ADMIN, 'DELETE', `/admin/roles/admin-mappings/${id}`)
    expect(del.statusCode).toBe(200)
    expect(del.json().demoted).toBe(1)
    expect(await isTenantAdmin(fgaClient, TARGET, TENANT), 'revoked by the delete, not by a later sweep').toBe(false)
  })

  it('the list surfaces WHO the mappings currently made an admin (the point of provenance)', async () => {
    await req(ADMIN, 'POST', '/admin/roles/admin-mappings', { groupName: GROUP })
    await seed(TARGET, 'member', [GROUP])
    await evaluateAdminMapping(db, fgaClient, { id: TENANT, plan: 'business' }, TARGET, [GROUP])

    const list = await req(ADMIN, 'GET', '/admin/roles/admin-mappings')
    expect(list.json().materialisedAdmins.map((m: { sub: string }) => m.sub)).toContain(TARGET)
    // The hand-appointed admin is NOT in that list — it answers "who did the IdP make an admin", and
    // conflating the two would send an operator revoking the wrong person.
    expect(list.json().materialisedAdmins.map((m: { sub: string }) => m.sub)).not.toContain(ADMIN)
  })

  it('another tenant\'s mapping id is not found (RLS scopes the delete too)', async () => {
    const other = `tenant_amr_${Date.now().toString(36)}`
    await adminPool`INSERT INTO tenants (id, slug, plan) VALUES (${other}, ${other}, 'business')`
    try {
      await adminPool`INSERT INTO group_admin_mappings (id, tenant_id, group_name, created_by) VALUES ('cross-tenant-id', ${other}, ${GROUP}, 'seed')`
      expect((await req(ADMIN, 'DELETE', '/admin/roles/admin-mappings/cross-tenant-id')).statusCode).toBe(404)
      expect(await adminPool`SELECT 1 FROM group_admin_mappings WHERE id = 'cross-tenant-id'`, 'untouched').toHaveLength(1)
    } finally {
      await adminPool`DELETE FROM group_admin_mappings WHERE tenant_id = ${other}`
      await adminPool`DELETE FROM tenants WHERE id = ${other}`
    }
  })

  it('a guest token cannot reach the surface at all (member-only)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/admin/roles/admin-mappings',
      headers: { host: HOST, authorization: 'Bearer not-a-member-token' },
    })
    expect(res.statusCode).toBe(401)
  })
})
