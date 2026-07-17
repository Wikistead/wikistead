// #445 / ADR-171: tenant-scope roles + the space_creator gate. The ADR's mandatory anti-tests:
//  (1) wildcard present → a plain member creates; absent → member 403 (static reason), admin still
//      creates (`or admin`), personal auto-create exempt  — covered in policy-knobs-399.test.ts
//      (the superseded knob's rewritten pins). Here: the ROLE path on top of the absent wildcard.
//  (2) a custom TENANT role bundling createSpaces assigned to a member lets them create with the
//      wildcard absent; unassign revokes; a second covering role keeps the leaf (reference
//      count carries to tenant scope).
//  (3) scope vocabulary split: a resource role cannot bundle createSpaces; a tenant role cannot
//      bundle edit; a tenant role cannot be assigned at space scope (and vice versa).
//  (4) guest boundary: share_link / user:* principals are 400 at tenant scope too.
//  (5) entitlement: defining/assigning custom TENANT roles requires customRoles; the DEFAULT-role
//      preset toggle works WITHOUT the entitlement (CE), flips the wildcard, and reports admin
//      locked-on.
//  (6) CROSS-TENANT WRITE BIND: a tenant-role assignment naming ANOTHER tenant's id is a uniform
//      404 and NO tuple lands on that tenant (FGA writes pierce RLS — the route bind is the guard).
// Real Postgres + OpenFGA + the app via inject. Runs on a DEDICATED throwaway tenant (slug crt445,
// dev-user as its admin so the dev bearer works through host resolution): the wildcard-absent
// windows these tests need would 403 PARALLEL test files' createSpace calls if they touched the
// shared dev tenant's wildcard (observed flake: notifications-362 mid-suite).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { registerEntitlementsResolver, resetEntitlementsResolver, UNLIMITED } from '@wikistead/entitlements'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { LogicalSearchDriver } from '../search/index.js'
import { buildApp } from '../app.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { provisionTenant } from '../auth/provisioning.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const SLUG = 'crt445'
const H = { host: `${SLUG}.localhost`, authorization: 'Bearer dev-token' }
const driver = new LogicalSearchDriver()

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
const MEMBER = 'crt445-member'
const wildcard = () => ({ user: 'user:*', relation: 'space_creator', object: `tenant:${tenant.id}` })

// `tenant` is not a ResourceRef type (the tenant-admin.ts precedent) — raw relation checks.
const creatorCheck = async (user: string, tenantId: string) => {
  const { allowed } = await fgaClient.check({ user, relation: 'space_creator', object: `tenant:${tenantId}` })
  return !!allowed
}
const canCreate = (sub: string) => creatorCheck(`user:${sub}`, tenant.id)

async function makeRole(name: string, capabilities: string[], scope?: string) {
  return app.inject({ method: 'POST', url: '/admin/roles', headers: H, payload: { name, capabilities, ...(scope ? { scope } : {}) } })
}
async function assign(roleId: string, resourceType: string, resourceId: string, principal: string) {
  return app.inject({ method: 'POST', url: `/admin/roles/${roleId}/assignments`, headers: H, payload: { resourceType, resourceId, principal } })
}
async function unassign(assignmentId: string) {
  return app.inject({ method: 'DELETE', url: `/admin/roles/assignments/${assignmentId}`, headers: H })
}

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  let t = await registry.findBySlug(SLUG)
  if (!t) {
    // dev-user as the admin → the dev bearer + host resolution make it a tenant admin here.
    await provisionTenant(fgaClient, { slug: SLUG, plan: 'free', admin: { sub: 'dev-user' } })
    t = await registry.findBySlug(SLUG)
  }
  tenant = t!
  db = await acquireTenantDb(tenant)
  app = await buildApp()
  await app.ready()
  // The throwaway tenant's plan is entitlement-poor — the suite baseline is UNLIMITED (anti-test 5
  // narrows customRoles itself).
  registerEntitlementsResolver(() => UNLIMITED)
  // Deterministic baseline whatever this tenant's history: wildcard present (the shipped default).
  await writeTuples(fgaClient, [wildcard()]).catch(() => {})
}, 60_000)

afterAll(async () => {
  resetEntitlementsResolver()
  await writeTuples(fgaClient, [wildcard()]).catch(() => {}) // restore the seeded default
  await admin`DELETE FROM role_assignments WHERE tenant_id = ${tenant.id}`
  await admin`DELETE FROM roles WHERE tenant_id = ${tenant.id} AND name LIKE 'crt445%'`
  await app?.close()
  await db.release()
  await pool.end()
  await admin.end()
}, 60_000)

describe('tenant-scope custom roles (#445 / ADR-171)', () => {
  it('anti-test 2: a createSpaces tenant role grants creation with the wildcard absent; unassign revokes; a second covering role keeps the leaf', async () => {
    await deleteTuples(fgaClient, [wildcard()]).catch(() => {})
    try {
      expect(await canCreate(MEMBER)).toBe(false)

      const r1 = await makeRole('crt445-creator', ['createSpaces'], 'tenant')
      expect(r1.statusCode).toBe(201)
      expect((r1.json() as { scope: string }).scope).toBe('tenant')
      const role1 = (r1.json() as { id: string }).id
      const a1 = await assign(role1, 'tenant', tenant.id, `user:${MEMBER}`)
      expect(a1.statusCode).toBe(201)
      expect(await canCreate(MEMBER), 'assignment expanded to tenant#space_creator').toBe(true)
      // the real gate: createSpace succeeds for the member now
      const s = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: MEMBER, plan: tenant.plan, name: 'crt445-made' })
      await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: s.id, userId: MEMBER })

      // second covering role → unassigning the first keeps the leaf (reference count + ownership transfer)
      const r2 = await makeRole('crt445-creator2', ['createSpaces'], 'tenant')
      const role2 = (r2.json() as { id: string }).id
      const a2 = await assign(role2, 'tenant', tenant.id, `user:${MEMBER}`)
      expect(a2.statusCode).toBe(201)
      expect((await unassign((a1.json() as { id: string }).id)).statusCode).toBe(204)
      expect(await canCreate(MEMBER), 'covering assignment keeps the leaf').toBe(true)
      expect((await unassign((a2.json() as { id: string }).id)).statusCode).toBe(204)
      expect(await canCreate(MEMBER), 'last unassign deletes the leaf').toBe(false)
    } finally {
      await writeTuples(fgaClient, [wildcard()]).catch(() => {})
    }
  })

  it('anti-test 3: the vocabularies are mutually exclusive, and a role assigns only AT its scope', async () => {
    const bad1 = await makeRole('crt445-badres', ['view', 'createSpaces'])
    expect(bad1.statusCode, 'a resource role cannot bundle createSpaces').toBe(400)
    const bad2 = await makeRole('crt445-badten', ['edit'], 'tenant')
    expect(bad2.statusCode, 'a tenant role cannot bundle edit').toBe(400)

    const tRole = (await makeRole('crt445-scopet', ['createSpaces'], 'tenant')).json() as { id: string }
    const sRole = (await makeRole('crt445-scoper', ['view'])).json() as { id: string }
    const sp = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'crt445-sc' })
    try {
      expect((await assign(tRole.id, 'space', sp.id, `user:${MEMBER}`)).statusCode, 'tenant role at space scope').toBe(400)
      expect((await assign(sRole.id, 'tenant', tenant.id, `user:${MEMBER}`)).statusCode, 'resource role at tenant scope').toBe(400)
    } finally {
      await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: sp.id, userId: 'dev-user' })
    }
  })

  it('anti-test 4: guest-boundary principals are refused at tenant scope (share_link / user:*)', async () => {
    const role = (await makeRole('crt445-guest', ['createSpaces'], 'tenant')).json() as { id: string }
    expect((await assign(role.id, 'tenant', tenant.id, 'share_link:evil')).statusCode).toBe(400)
    expect((await assign(role.id, 'tenant', tenant.id, 'user:*')).statusCode).toBe(400)
  })

  it('anti-test 5: custom tenant roles need customRoles; the DEFAULT preset toggle is CE (no entitlement) and flips the wildcard', async () => {
    registerEntitlementsResolver(() => ({ ...UNLIMITED, customRoles: false }))
    try {
      expect((await makeRole('crt445-noent', ['createSpaces'], 'tenant')).statusCode, 'define needs the entitlement').toBe(403)

      // The DEFAULT-role preset works on every plan (CE) and reports admin locked-on.
      const g1 = await app.inject({ method: 'GET', url: '/admin/roles/tenant-defaults', headers: H })
      expect(g1.statusCode).toBe(200)
      expect((g1.json() as { admin: { locked: boolean } }).admin.locked).toBe(true)
      const off = await app.inject({ method: 'PUT', url: '/admin/roles/tenant-defaults', headers: H, payload: { memberCreateSpaces: false } })
      expect(off.statusCode).toBe(200)
      expect(await creatorCheck('user:*', tenant.id), 'wildcard deleted').toBe(false)
      expect(await canCreate('dev-user'), 'admin still passes via or-admin').toBe(true)
      const on = await app.inject({ method: 'PUT', url: '/admin/roles/tenant-defaults', headers: H, payload: { memberCreateSpaces: true } })
      expect(on.statusCode).toBe(200)
      const g2 = await app.inject({ method: 'GET', url: '/admin/roles/tenant-defaults', headers: H })
      expect((g2.json() as { member: { createSpaces: boolean } }).member.createSpaces).toBe(true)
      expect(await canCreate(MEMBER), 'wildcard restored → member creates').toBe(true)
    } finally {
      registerEntitlementsResolver(() => UNLIMITED) // back to the suite baseline
    }
  })

  it('anti-test 6 (WRITE BIND): naming ANOTHER tenant id is a uniform 404 and writes NOTHING onto that tenant', async () => {
    const role = (await makeRole('crt445-bind', ['createSpaces'], 'tenant')).json() as { id: string }
    const evil = await assign(role.id, 'tenant', 'tenant_dev', `user:${MEMBER}`)
    expect(evil.statusCode, 'cross-tenant assignment refused (uniform 404)').toBe(404)
    // Assert no DIRECT tuple landed on tenant B (the write-bind proof). A check() can't pin this:
    // the target tenant's own `user:*` wildcard matches any user principal by design — the tuple
    // READ (exact-match filter) is the authority on what this route wrote.
    const { tuples } = await fgaClient.read({ user: `user:${MEMBER}`, object: 'tenant:tenant_dev' })
    expect((tuples ?? []).length, 'no leaked tuple on the other tenant').toBe(0)
    const [prov] = await admin<{ id: string }[]>`SELECT id FROM role_assignments WHERE resource_id = 'tenant_dev'`
    expect(prov, 'no provenance row either').toBeUndefined()
  })
})
