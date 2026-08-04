// Integration test — real Postgres + real OpenFGA, no mocks. #603 / ADR-207: a GROUP may hold the
// tenant tier (`admin` | `member`), granted as a built-in role_assignments row and expanded to the
// tenant leaf. Security-critical (authz boundary + lockout):
//   - the server, never the client, derives the group's FGA id from the typed name (#536);
//   - `admin` stays OUT of the custom-role vocabulary (§R4-2 — a manageRoles holder must not be able
//     to bundle it), and the expansion refuses it without the built-in flag (second layer);
//   - the last-admin FLOOR is unchanged (row admins only) and its 409 now SAYS WHY when a group holds
//     admin (user condition on the ruling) — a different sentence from the ordinary refusal;
//   - revoking a group's admin is NEVER refused and NEVER entitlement-gated (a downgraded tenant must
//     still be able to take admin off a group — §R4-3).
//
// Runs on its own tenant (tenant_t603): the floor assertions need "exactly one row admin", which the
// shared dev tenant cannot promise (#482: never bend shared-tenant state to a test's needs).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { buildApp } from '../app.js'
import { groupFgaId, groupGrantee, syncMemberGroups } from '../auth/group-sync.js'
import { expansionTuples } from '../routes/roles.js'
import { lastAdminRefusal } from '../auth/last-admin.js'
import type { FastifyInstance } from 'fastify'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_t603'
const ADMIN = 'dev-user' // the one ROW admin of tenant_t603 (the floor)
const MEMBER = 't603-user' // synced into GROUP — becomes admin THROUGH it
const GROUP = 'Ops603'
const H = { host: 't603.localhost', authorization: 'Bearer dev-token' }
const asTenant = (id: string): Tenant => ({ id, slug: 't603', plan: 'free', isolation: 'logical' }) as Tenant

let app: FastifyInstance
let db: TenantDb

const devUserTuples = [
  { user: `user:${ADMIN}`, relation: 'member', object: `tenant:${T}` },
  { user: `user:${ADMIN}`, relation: 'admin', object: `tenant:${T}` },
]
const groupAdminTuple = { user: groupGrantee(T, GROUP), relation: 'admin', object: `tenant:${T}` }
const groupMemberTuple = { user: `user:${MEMBER}`, relation: 'member', object: `group:${groupFgaId(T, GROUP)}` }

beforeAll(async () => {
  await admin`INSERT INTO tenants (id, slug, plan) VALUES (${T}, 't603', 'free') ON CONFLICT (slug) DO NOTHING`
  // leftovers from a prior aborted run (the role delete below is refused while assignments live)
  await admin`DELETE FROM role_assignments WHERE tenant_id = ${T}`
  await admin`DELETE FROM roles WHERE tenant_id = ${T}`
  await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${T}, ${ADMIN}, 'a@t603.test', 'admin')
              ON CONFLICT (tenant_id, sub) DO UPDATE SET role = 'admin', deactivated_at = NULL`
  await admin`INSERT INTO members (tenant_id, sub, email, role, groups) VALUES (${T}, ${MEMBER}, 'm@t603.test', 'member', ${admin.array([GROUP])})
              ON CONFLICT (tenant_id, sub) DO UPDATE SET role = 'member', groups = EXCLUDED.groups, deactivated_at = NULL`
  for (const t of [...devUserTuples, groupMemberTuple]) await writeTuples(fgaClient, [t]).catch(() => {})
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(T))
})

afterAll(async () => {
  for (const t of [...devUserTuples, groupMemberTuple, groupAdminTuple]) await deleteTuples(fgaClient, [t]).catch(() => {})
  await admin`DELETE FROM role_assignments WHERE tenant_id = ${T}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${T}`.catch(() => {})
  await admin`DELETE FROM audit_log WHERE tenant_id = ${T}`.catch(() => {})
  await admin`DELETE FROM audit_outbox WHERE tenant_id = ${T}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${T}`.catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
  await pool.end()
})

describe('#603 §R4-2: admin never enters the custom-role vocabulary, and the expansion refuses it twice', () => {
  it('a custom tenant role cannot bundle admin (first layer: the vocabulary)', async () => {
    const r = await app.inject({ method: 'POST', url: '/admin/roles', headers: H, payload: { name: 't603-usurper', capabilities: ['admin'], scope: 'tenant' } })
    expect(r.statusCode).toBe(400)
  })
  it('expansionTuples refuses the tier without the built-in flag (second layer) and writes the leaf with it', () => {
    expect(() => expansionTuples('tenant', T, groupGrantee(T, GROUP), 'admin' as never, false)).toThrow(/not assignable/)
    expect(expansionTuples('tenant', T, groupGrantee(T, GROUP), 'admin' as never, true)).toEqual([groupAdminTuple])
  })
})

describe('#603 §R4-3: the tenant tier grant path', () => {
  it('grants admin to a group BY NAME — the server derives the id, and the tuple actually lands', async () => {
    const r = await app.inject({ method: 'POST', url: '/admin/roles/tenant-tier-assignments', headers: H, payload: { capability: 'admin', groupName: GROUP } })
    expect(r.statusCode).toBe(201)
    expect(r.json().builtin).toBe('admin')
    // FGA read, direct — the row is not the proof, the tuple is (red-check)
    const { tuples } = await fgaClient.read({ user: groupGrantee(T, GROUP), object: `tenant:${T}` })
    expect((tuples ?? []).map((t) => t.key?.relation)).toContain('admin')
  })
  it("the group's members ARE admins — including a verb #604 carved out (`or admin`)", async () => {
    expect((await fgaClient.check({ user: `user:${MEMBER}`, relation: 'admin', object: `tenant:${T}` })).allowed).toBe(true)
    expect((await fgaClient.check({ user: `user:${MEMBER}`, relation: 'manage_roles', object: `tenant:${T}` })).allowed).toBe(true)
  })
  it('the assignments list returns the built-in row (LEFT JOIN — the INNER join dropped it)', async () => {
    const r = await app.inject({ method: 'GET', url: `/admin/roles/assignments?resourceType=tenant&resourceId=${T}`, headers: H })
    expect(r.statusCode).toBe(200)
    const rows = r.json() as { roleId: string | null; roleName: string; builtin?: string; principal: string; groupName?: string }[]
    const b = rows.find((x) => x.builtin === 'admin')
    expect(b, 'the tier row comes back').toBeTruthy()
    expect(b!.roleId).toBeNull()
    expect(b!.roleName).toBe('admin')
    expect(b!.groupName).toBe(GROUP)
    expect(b!.principal).toBe(groupGrantee(T, GROUP))
  })
  it('GET /members joins a person to the groups that confer on them (rev3)', async () => {
    const r = await app.inject({ method: 'GET', url: '/members', headers: H })
    const m = (r.json().members as { sub: string; groups?: string[] | null }[]).find((x) => x.sub === MEMBER)
    expect(m?.groups).toEqual([GROUP])
  })
  it('refuses a user principal (a person’s tier is their member row) and an unknown capability', async () => {
    const user = await app.inject({ method: 'POST', url: '/admin/roles/tenant-tier-assignments', headers: H, payload: { capability: 'admin', principal: `user:${MEMBER}` } })
    expect(user.statusCode).toBe(400)
    const cap = await app.inject({ method: 'POST', url: '/admin/roles/tenant-tier-assignments', headers: H, payload: { capability: 'edit', groupName: GROUP } })
    expect(cap.statusCode).toBe(400)
  })
  it('one role per principal: granting member replaces the admin grant (#579 convergence)', async () => {
    const r = await app.inject({ method: 'POST', url: '/admin/roles/tenant-tier-assignments', headers: H, payload: { capability: 'member', groupName: GROUP } })
    expect(r.statusCode).toBe(201)
    const rows = (await app.inject({ method: 'GET', url: `/admin/roles/assignments?resourceType=tenant&resourceId=${T}`, headers: H })).json() as { builtin?: string }[]
    expect(rows.filter((x) => x.builtin).map((x) => x.builtin)).toEqual(['member'])
    const { tuples } = await fgaClient.read({ user: groupGrantee(T, GROUP), object: `tenant:${T}` })
    const rels = (tuples ?? []).map((t) => t.key?.relation)
    expect(rels).toContain('member')
    expect(rels, 'the folded admin leaf is gone with its row').not.toContain('admin')
    // put admin back — the floor tests below need a group that holds it
    await app.inject({ method: 'POST', url: '/admin/roles/tenant-tier-assignments', headers: H, payload: { capability: 'admin', groupName: GROUP } })
  })
})

describe('#603 floor ruling: the 409 says WHY, and the two refusals are different sentences', () => {
  it('with a group holding admin, demoting the last ROW admin is refused WITH the reason', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/members/${ADMIN}`, headers: H, payload: { role: 'member' } })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('last_direct_admin')
    expect(r.json().error).toMatch(/directly granted admin must remain/)
  })
  it('removal is refused with the same reason', async () => {
    const r = await app.inject({ method: 'DELETE', url: `/members/${ADMIN}`, headers: H })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('last_direct_admin')
  })
  it('the ordinary last-admin refusal keeps its own words — the branch is real, not one string', async () => {
    // measured through the same helper the routes call, against the same rows: with the group grant
    // present the sentence names the IdP risk; without it, the pre-#603 wording. They must differ.
    const withGroup = await lastAdminRefusal(db.sql)
    expect(withGroup.code).toBe('last_direct_admin')
    const [asg] = await db.sql<{ id: string }[]>`
      SELECT id FROM role_assignments WHERE resource_type = 'tenant' AND builtin_capability = 'admin'`
    const del = await app.inject({ method: 'DELETE', url: `/admin/roles/assignments/${asg.id}`, headers: H })
    expect(del.statusCode).toBe(200)
    const without = await lastAdminRefusal(db.sql)
    expect(without.code).toBe('last_admin')
    expect(without.error).not.toBe(withGroup.error)
    const r = await app.inject({ method: 'PATCH', url: `/members/${ADMIN}`, headers: H, payload: { role: 'member' } })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('last_admin')
  })
})

describe('#603 §R4-3/§R4-5: revoking a group admin is never refused and never entitlement-gated', () => {
  it('revoke succeeds with exactly one row admin, on a plan WITHOUT customRoles — and the tuple dies', async () => {
    const grant = await app.inject({ method: 'POST', url: '/admin/roles/tenant-tier-assignments', headers: H, payload: { capability: 'admin', groupName: GROUP } })
    expect(grant.statusCode).toBe(201)
    const { registerEntitlementsResolver, resetEntitlementsResolver, UNLIMITED } = await import('@wikistead/entitlements')
    try {
      registerEntitlementsResolver(() => ({ ...UNLIMITED, customRoles: false }))
      // granting a CUSTOM role assignment stays behind the plan gate (the gate moved, it did not die)
      const paid = await app.inject({ method: 'POST', url: '/admin/roles/no-such-role/assignments', headers: H, payload: { resourceType: 'tenant', resourceId: T, groupName: GROUP } })
      expect(paid.statusCode).toBe(403)
      // …and the tier grant path is core product — no plan gate on a built-in
      const tier = await app.inject({ method: 'POST', url: '/admin/roles/tenant-tier-assignments', headers: H, payload: { capability: 'admin', groupName: GROUP } })
      expect([200, 201]).toContain(tier.statusCode)
      // the revoke goes through with the LAST row admin standing and no entitlement — refusing either
      // way would strand the power (the fail-open shape §R4-3 names)
      const [asg] = await db.sql<{ id: string }[]>`
        SELECT id FROM role_assignments WHERE resource_type = 'tenant' AND builtin_capability = 'admin'`
      const del = await app.inject({ method: 'DELETE', url: `/admin/roles/assignments/${asg.id}`, headers: H })
      expect(del.statusCode).toBe(200)
      expect(del.json().removed).toBe(true)
    } finally {
      resetEntitlementsResolver()
    }
    const { tuples } = await fgaClient.read({ user: groupGrantee(T, GROUP), object: `tenant:${T}` })
    expect((tuples ?? []).map((t) => t.key?.relation)).not.toContain('admin')
    expect((await fgaClient.check({ user: `user:${MEMBER}`, relation: 'admin', object: `tenant:${T}` })).allowed).toBe(false)
  })
})

describe('#603: a custom role pick replaces the tier (the row Select round-trip)', () => {
  it('tier admin → custom role converges to the custom role alone', async () => {
    await app.inject({ method: 'POST', url: '/admin/roles/tenant-tier-assignments', headers: H, payload: { capability: 'admin', groupName: GROUP } })
    const mk = await app.inject({ method: 'POST', url: '/admin/roles', headers: H, payload: { name: 't603-roundtrip', capabilities: ['createSpaces'], scope: 'tenant' } })
    expect(mk.statusCode).toBe(201)
    const roleId = mk.json().id as string
    const asg = await app.inject({ method: 'POST', url: `/admin/roles/${roleId}/assignments`, headers: H, payload: { resourceType: 'tenant', resourceId: T, principal: groupGrantee(T, GROUP) } })
    expect(asg.statusCode, asg.body).toBe(201)
    const rows = (await app.inject({ method: 'GET', url: `/admin/roles/assignments?resourceType=tenant&resourceId=${T}`, headers: H })).json() as { id: string; builtin?: string; roleName: string; principal: string; groupName?: string }[]
    const mine = rows.filter((r) => r.principal === groupGrantee(T, GROUP))
    expect(mine.map((r) => r.roleName), 'one role per principal — the tier folded').toEqual(['t603-roundtrip'])
    // #603 (measured in the e2e first): the replacement INHERITS the typed name — the re-assign
    // travels by principal, and without the carry the group demotes to "unknown group" one pick later
    expect(rows.find((r) => r.principal === groupGrantee(T, GROUP))!.groupName).toBe(GROUP)
    // unassign before deleting the role — a role with live assignments refuses deletion (by design),
    // and the leftover role made the NEXT run's create answer 409
    const [ra] = rows.filter((r) => r.principal === groupGrantee(T, GROUP))
    await app.inject({ method: 'DELETE', url: `/admin/roles/assignments/${ra.id}`, headers: H })
    const rmRole = await app.inject({ method: 'DELETE', url: `/admin/roles/${roleId}`, headers: H })
    expect(rmRole.statusCode).toBe(204)
  })
})
