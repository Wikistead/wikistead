// #497 / ADR-183 §3: the tenant DEFAULT role. A member no mapping matches gets the tenant's
// default_role_id (a TENANT-scope custom role, origin='default'); it flips off the moment a mapping
// matches their groups and back on when it stops; `manual` wins; NULL is byte-identical to today.
// authz-relevant (it writes a role assignment at login) — anti-tested against real Postgres + OpenFGA,
// exercising the evaluator DIRECTLY (the login path calls exactly this) plus the settings route.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { registerEntitlementsResolver, resetEntitlementsResolver, UNLIMITED } from '@wikistead/entitlements'
import { fgaClient } from '@wikistead/authz'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { LogicalSearchDriver } from '../search/index.js'
import { buildApp } from '../app.js'
import { evaluateDefaultRole } from '../routes/roles.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' } // dev-user = tenant admin
const driver = new LogicalSearchDriver()
const tag = Date.now().toString(36)

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
let spaceId: string

// space_creator is a RAW tenant relation (not a capability), so check it via the SDK directly.
const creator = async (sub: string) =>
  (await fgaClient.check({ user: `user:${sub}`, relation: 'space_creator', object: `tenant:${tenant.id}` })).allowed ?? false
async function makeRole(name: string, capabilities: string[], scope: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/admin/roles', headers: H, payload: { name, capabilities, scope } })
  expect(r.statusCode, `create role ${name}`).toBe(201)
  return (r.json() as { id: string }).id
}
const setDefault = (defaultRoleId: string | null) =>
  app.inject({ method: 'PUT', url: '/admin/roles/default-role', headers: H, payload: { defaultRoleId } })
const evalFor = (sub: string, groups: string[]) => evaluateDefaultRole(db, fgaClient, driver, tenant, sub, groups)
const defaultRows = (sub: string) =>
  admin<{ role_id: string; origin: string }[]>`SELECT role_id, origin FROM role_assignments WHERE tenant_id = ${tenant.id} AND resource_type = 'tenant' AND principal = ${`user:${sub}`}`

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  app = await buildApp()
  await app.ready()
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `dr497-${tag}` })).id
}, 60_000)

afterAll(async () => {
  resetEntitlementsResolver()
  await admin`UPDATE tenant_settings SET default_role_id = NULL WHERE tenant_id = ${tenant.id}`
  await admin`DELETE FROM group_role_mappings WHERE tenant_id = ${tenant.id}`
  // Scoped to the roles THIS file created. The wholesale delete that used to be here also removed the
  // assignments of every other suite file sharing `tenant_dev` — the shape of defect that made the
  // audit assertions flake (#482). It was redundant besides: role_assignments.role_id is
  // ON DELETE CASCADE, so the prefixed `roles` delete on the next line already takes them.
  await admin`DELETE FROM role_assignments WHERE tenant_id = ${tenant.id} AND role_id IN (SELECT id FROM roles WHERE tenant_id = ${tenant.id} AND name LIKE 'dr497%')`
  await admin`DELETE FROM roles WHERE tenant_id = ${tenant.id} AND name LIKE 'dr497%'`
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await app?.close()
  await db.release()
  await pool.end()
  await admin.end()
}, 60_000)

describe('tenant default role (#497 / ADR-183 §3)', () => {
  it('anti-test 1: applies when NO mapping matches (the member gains the tenant capability); clearing it removes it', async () => {
    const roleId = await makeRole('dr497-default', ['createSpaces'], 'tenant')
    expect((await setDefault(roleId)).statusCode).toBe(200)
    const u = `dr497-alice-${tag}`
    expect(await creator(u), 'no default yet').toBe(false)

    await evalFor(u, ['unmatched-group'])
    const rows = await defaultRows(u)
    expect(rows.map((r) => [r.role_id, r.origin])).toEqual([[roleId, 'default']])
    expect(await creator(u), 'the default role confers space creation LIVE').toBe(true)

    // Idempotent: a second eval with the same state changes nothing (no dup, no 409 leak).
    await evalFor(u, ['unmatched-group'])
    expect((await defaultRows(u)).length).toBe(1)

    // Clearing the setting removes the default at the next eval.
    expect((await setDefault(null)).statusCode).toBe(200)
    await evalFor(u, ['unmatched-group'])
    expect((await defaultRows(u)).length, 'default removed once the setting is cleared').toBe(0)
    expect(await creator(u)).toBe(false)
  })

  it('anti-test 2 + 3: a matching mapping suppresses the default, and it flips off/on across evals', async () => {
    const roleId = await makeRole('dr497-flip', ['createSpaces'], 'tenant')
    const group = `Eng-${tag}`
    // #578 slice 3: this used to create a SPACE mapping, which is retired (410). The evaluator matches
    // by group NAME regardless of the mapping's scope, so a TENANT mapping proves the same rule and
    // survives until slices 4 and 5 retire the default role itself.
    const tenantRole2 = await makeRole('dr497-tenrole2', ['issueApiKeys'], 'tenant')
    const m = await app.inject({ method: 'POST', url: '/admin/roles/mappings', headers: H, payload: { groupName: group, roleId: tenantRole2, resourceType: 'tenant', resourceId: tenant.id } })
    expect(m.statusCode).toBe(201)
    expect((await setDefault(roleId)).statusCode).toBe(200)
    const u = `dr497-bob-${tag}`

    // Carries the mapped group → a mapping matches → NO default.
    await evalFor(u, [group])
    expect((await defaultRows(u)).length, 'a matched member gets no default').toBe(0)

    // Loses the mapped group → the default applies.
    await evalFor(u, ['something-else'])
    expect((await defaultRows(u)).map((r) => r.origin)).toEqual(['default'])
    expect(await creator(u)).toBe(true)

    // Regains the mapped group → the default is removed again (the flip).
    await evalFor(u, [group])
    expect((await defaultRows(u)).length, 'the default flips off when a mapping matches again').toBe(0)
    expect(await creator(u)).toBe(false)
  })

  it('anti-test 4: manual wins — a manual assignment of the same role is never duplicated, and the default never deletes it', async () => {
    const roleId = await makeRole('dr497-manual', ['createSpaces'], 'tenant')
    expect((await setDefault(roleId)).statusCode).toBe(200)
    const u = `dr497-carol-${tag}`
    // A hand-placed (manual) assignment of the SAME role at tenant scope.
    const asg = await app.inject({ method: 'POST', url: `/admin/roles/${roleId}/assignments`, headers: H, payload: { resourceType: 'tenant', resourceId: tenant.id, principal: `user:${u}` } })
    expect(asg.statusCode).toBe(201)

    // The evaluator must NOT create a second (default) row — manual wins.
    await evalFor(u, ['unmatched'])
    const rows = await defaultRows(u)
    expect(rows.length, 'exactly one row — the manual one; no default duplicate').toBe(1)
    expect(rows[0]!.origin, 'and it stays manual').toBe('manual')
    expect(await creator(u)).toBe(true)

    // Even when a mapping later matches, the evaluator must not delete the MANUAL row (it only owns 'default').
    const spaceRole = await makeRole('dr497-mrole', ['view'], 'resource')
    const g = `M-${tag}`
    await app.inject({ method: 'POST', url: '/admin/roles/mappings', headers: H, payload: { groupName: g, roleId: spaceRole, resourceType: 'space', resourceId: spaceId } })
    await evalFor(u, [g])
    const after = await defaultRows(u)
    expect(after.length, 'the manual assignment survives — the default evaluator never deletes a row it does not own').toBe(1)
    expect(after[0]!.origin).toBe('manual')
    expect(await creator(u)).toBe(true)
  })

  it('anti-test 5: default_role_id NULL is byte-identical to today (no assignment ever created)', async () => {
    expect((await setDefault(null)).statusCode).toBe(200)
    const u = `dr497-dave-${tag}`
    await evalFor(u, ['whatever'])
    expect((await defaultRows(u)).length).toBe(0)
    expect(await creator(u)).toBe(false)
  })

  it('anti-test 6: the settings route validates scope + entitlement', async () => {
    const resourceRole = await makeRole('dr497-res', ['view'], 'resource')
    // a resource-scope role cannot be the default (a bare role names no resource) → 400
    expect((await setDefault(resourceRole)).statusCode).toBe(400)
    // an unknown / cross-tenant id → 404
    expect((await app.inject({ method: 'PUT', url: '/admin/roles/default-role', headers: H, payload: { defaultRoleId: `nope-${tag}` } })).statusCode).toBe(404)
    // GET reflects the stored value
    const tenantRole = await makeRole('dr497-get', ['createSpaces'], 'tenant')
    await setDefault(tenantRole)
    expect(((await app.inject({ method: 'GET', url: '/admin/roles/default-role', headers: H })).json() as { defaultRoleId: string }).defaultRoleId).toBe(tenantRole)
    // customRoles OFF → the whole surface 403s
    registerEntitlementsResolver(() => ({ ...UNLIMITED, customRoles: false }))
    try {
      expect((await app.inject({ method: 'GET', url: '/admin/roles/default-role', headers: H })).statusCode).toBe(403)
      expect((await setDefault(tenantRole)).statusCode).toBe(403)
    } finally {
      resetEntitlementsResolver()
    }
    await setDefault(null)
  })
})
