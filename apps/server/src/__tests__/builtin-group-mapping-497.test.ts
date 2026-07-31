// #497 (088, unlocked by #536): a group→role mapping may confer a BUILT-IN role. The mapping row
// carries builtin_capability (role_id stays NULL — the 086 shape), the assignment goes through the
// same assignRoleInTx the Members grant uses, and deleting the mapping revokes through the
// ref-counted unassign. Authz-critical pins:
//   - the group's ACTUAL members gain/lose the capability (FGA resolves group#member live);
//   - `comment` is refused (no commenter noun on any grant surface);
//   - tenant scope is refused for built-ins (member/admin are identity tiers, not mappable roles);
//   - the list names the mapping with the built-in NOUN, and delete → 204 → access gone.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import IORedis from 'ioredis'
import { fgaClient, writeTuples, check } from '@wikistead/authz'
import { createSpace, deleteSpace, grantSpaceAccess, revokeSpaceAccess, listSpaceAccess } from '../routes/spaces.js'
import { groupGrantee } from '../auth/group-sync.js'
import { ensureMembers } from './helpers/membership.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminSql = postgres(process.env.DATABASE_ADMIN_URL!) // #497 re-review: origin/ownership inspection
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }
const HG = { host: 'dev.localhost', authorization: 'Bearer dev-token' } // bodyless verbs: no content-type (Fastify 400s an empty JSON body)
const tag = Date.now().toString(36)
const GROUP = `eng-497-${tag}`
const MEMBER = `user:g497-member-${tag}`

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
let spaceId: string
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const MGR = `g497-mgr-${tag}`
const PLAIN = `g497-plain-${tag}`
let mgrSid = ''
let plainSid = ''
const HMGR = () => ({ host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${mgrSid}`, 'content-type': 'application/json' })
const HPLAIN = () => ({ host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${plainSid}`, 'content-type': 'application/json' })

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))! as Tenant
  db = await acquireTenantDb(tenant)
  app = await buildApp()
  await app.ready()
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `gm497-${tag}` })).id
  // the #111 sync would write this on login; the test writes the SAME tuple the sync writes
  await writeTuples(fgaClient, [{ user: MEMBER, relation: 'member', object: groupGrantee(tenant.id, GROUP).replace('#member', '') }])
  // a SPACE MANAGER and a plain member with real sessions — the per-scope authority pins (review D3)
  await ensureMembers(tenant.id, [MGR, PLAIN])
  await writeTuples(fgaClient, [{ user: `user:${MGR}`, relation: 'manager', object: `space:${spaceId}` }])
  mgrSid = await createSession(valkey, { tenantId: tenant.id, sub: MGR, role: 'member' })
  plainSid = await createSession(valkey, { tenantId: tenant.id, sub: PLAIN, role: 'member' })
}, 120_000)

afterAll(async () => {
  await adminSql.end().catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await app?.close()
  await db.release()
  await valkey.quit()
  await pool.end()
}, 120_000)

const post = (body: object) => app.inject({ method: 'POST', url: '/admin/roles/mappings', headers: H, payload: body })

describe('#497: built-in group mappings', () => {
  it('maps a group to the built-in editor; the group member actually gains edit, and delete revokes it', async () => {
    const res = await post({ groupName: GROUP, builtinCapability: 'edit', resourceType: 'space', resourceId: spaceId })
    expect(res.statusCode, res.body).toBe(201)
    const created = res.json() as { id: string; roleName: string; builtinCapability: string; roleId: string | null }
    expect(created.roleName, 'the built-in NOUN, not a raw capability').toBe('editor')
    expect(created.builtinCapability).toBe('edit')
    expect(created.roleId).toBeNull()

    expect(await check(fgaClient, MEMBER, 'edit', { type: 'space', id: spaceId }), 'the group member gained edit through the mapping').toBe(true)

    const list = await app.inject({ method: 'GET', url: `/admin/roles/mappings?resourceType=space&resourceId=${spaceId}`, headers: HG })
    expect(list.statusCode).toBe(200)
    const row = (list.json() as { id: string; roleName: string; builtinCapability: string | null }[]).find((m) => m.id === created.id)
    expect(row, 'the mapping lists').toBeTruthy()
    expect(row!.roleName).toBe('editor')
    expect(row!.builtinCapability).toBe('edit')

    const del = await app.inject({ method: 'DELETE', url: `/admin/roles/mappings/${created.id}`, headers: HG })
    expect(del.statusCode).toBe(204)
    expect(await check(fgaClient, MEMBER, 'edit', { type: 'space', id: spaceId }), 'delete revoked the conferred access').toBe(false)
  }, 120_000)

  it('refuses `comment` as a built-in mapping (comment-only stays a custom-role composition)', async () => {
    const res = await post({ groupName: GROUP, builtinCapability: 'comment', resourceType: 'space', resourceId: spaceId })
    expect(res.statusCode).toBe(400)
  }, 120_000)

  it('refuses a built-in mapping at tenant scope, and roleId XOR builtinCapability is enforced', async () => {
    const atTenant = await post({ groupName: GROUP, builtinCapability: 'edit', resourceType: 'tenant', resourceId: tenant.id })
    expect(atTenant.statusCode).toBe(400)
    const both = await post({ groupName: GROUP, roleId: 'someid', builtinCapability: 'edit', resourceType: 'space', resourceId: spaceId })
    expect(both.statusCode).toBe(400)
    const neither = await post({ groupName: GROUP, resourceType: 'space', resourceId: spaceId })
    expect(neither.statusCode).toBe(400)
  }, 120_000)

  it('manage maps through the superset path and revokes clean (the #536 allowSuperset shape)', async () => {
    const res = await post({ groupName: GROUP, builtinCapability: 'manage', resourceType: 'space', resourceId: spaceId })
    expect(res.statusCode, res.body).toBe(201)
    expect(await check(fgaClient, MEMBER, 'manage', { type: 'space', id: spaceId })).toBe(true)
    const del = await app.inject({ method: 'DELETE', url: `/admin/roles/mappings/${(res.json() as { id: string }).id}`, headers: HG })
    expect(del.statusCode).toBe(204)
    expect(await check(fgaClient, MEMBER, 'manage', { type: 'space', id: spaceId })).toBe(false)
  }, 120_000)

  it('a cross-tenant space id is a uniform 404 (existence-hiding holds on the new branch)', async () => {
    const res = await post({ groupName: GROUP, builtinCapability: 'edit', resourceType: 'space', resourceId: '00000000-0000-4000-8000-00000000497b' })
    expect(res.statusCode).toBe(404)
  }, 120_000)
})

describe('#497 review D1/D3: ownership at the Members surface, and per-scope authority', () => {
  it('a mapping-owned builtin grant cannot be revoked or re-granted from the Members surface (409); deleting the mapping still revokes', async () => {
    const created = await post({ groupName: GROUP, builtinCapability: 'edit', resourceType: 'space', resourceId: spaceId })
    expect(created.statusCode, created.body).toBe(201)
    const mappingId = (created.json() as { id: string }).id
    const grantee = groupGrantee(tenant.id, GROUP)

    // Members revoke must refuse — silently unassigning strands the mapping as a lying console row
    await expect(revokeSpaceAccess(db, fgaClient, app.searchDriver, {
      spaceId, tenantId: tenant.id, userId: 'dev-user', grantee, capability: 'edit', plan: tenant.plan,
    })).rejects.toMatchObject({ statusCode: 409 })
    expect(await check(fgaClient, MEMBER, 'edit', { type: 'space', id: spaceId }), 'access survives the refused revoke').toBe(true)

    // Members grant must refuse too — the idempotent dup path would silently ADOPT the mapping's row
    await expect(grantSpaceAccess(db, fgaClient, app.searchDriver, {
      spaceId, tenantId: tenant.id, userId: 'dev-user', grantee, capability: 'edit', plan: tenant.plan,
    })).rejects.toMatchObject({ statusCode: 409 })

    // the list names the machine-managed row
    const listed = await listSpaceAccess(fgaClient, db, { spaceId, tenantId: tenant.id, userId: 'dev-user' })
    const row = listed.find((g) => g.grantee === grantee && g.capability === 'edit')
    expect(row?.managed, 'the console says who manages it').toBe(true)

    // the OWNER still removes it — mapping delete revokes for real
    const del = await app.inject({ method: 'DELETE', url: `/admin/roles/mappings/${mappingId}`, headers: HG })
    expect(del.statusCode).toBe(204)
    expect(await check(fgaClient, MEMBER, 'edit', { type: 'space', id: spaceId }), 'the mapping delete is the real revoke').toBe(false)
  }, 120_000)

  it('a direct (manual) grant is NOT marked managed and stays revocable', async () => {
    const grantee = groupGrantee(tenant.id, `Direct-${tag}`)
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: tenant.id, userId: 'dev-user', grantee, capability: 'view', plan: tenant.plan })
    const listed = await listSpaceAccess(fgaClient, db, { spaceId, tenantId: tenant.id, userId: 'dev-user' })
    const row = listed.find((g) => g.grantee === grantee && g.capability === 'view')
    expect(row, 'the direct grant lists').toBeTruthy()
    expect(row?.managed).toBeUndefined()
    await revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: tenant.id, userId: 'dev-user', grantee, capability: 'view', plan: tenant.plan })
  }, 120_000)

  it('a space manager creates a builtin mapping in their own space (201); a plain member is refused (403)', async () => {
    const mgrRes = await app.inject({ method: 'POST', url: '/admin/roles/mappings', headers: HMGR(), payload: { groupName: `MgrB-${tag}`, builtinCapability: 'view', resourceType: 'space', resourceId: spaceId } })
    expect(mgrRes.statusCode, mgrRes.body).toBe(201)
    const plainRes = await app.inject({ method: 'POST', url: '/admin/roles/mappings', headers: HPLAIN(), payload: { groupName: `PlainB-${tag}`, builtinCapability: 'view', resourceType: 'space', resourceId: spaceId } })
    expect(plainRes.statusCode, 'no space manage, no mapping').toBe(403)
    const del = await app.inject({ method: 'DELETE', url: `/admin/roles/mappings/${(mgrRes.json() as { id: string }).id}`, headers: { host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${mgrSid}` } })
    expect(del.statusCode).toBe(204)
  }, 120_000)
})

// #497 re-review N2: the CUSTOM branch of the same surface had the same ownership hole D1 closed on
// the builtin branch — DELETE /admin/roles/assignments/:id happily consumed a mapping-owned
// assignment (204, access gone, mapping row left pointing at nothing, re-creation blocked by the
// mapping's uniqueness). ADR-183 §1: only deleting the MAPPING revokes.
describe('#497 re-review N2: mapping-owned CUSTOM assignments are not the assignment route\'s to delete', () => {
  it('assignments list says managed; direct assignment delete is 409; mapping delete still revokes', async () => {
    const roleRes = await app.inject({ method: 'POST', url: '/admin/roles', headers: H, payload: { name: `gm497-cust-${tag}`, capabilities: ['view', 'edit'] } })
    expect(roleRes.statusCode).toBe(201)
    const roleId = (roleRes.json() as { id: string }).id
    try {
      const created = await post({ resourceType: 'space', resourceId: spaceId, groupName: GROUP, roleId })
      expect(created.statusCode).toBe(201)
      const mappingId = (created.json() as { id: string }).id

      const list = await app.inject({ method: 'GET', url: `/admin/roles/assignments?resourceType=space&resourceId=${spaceId}`, headers: HG })
      const managedRow = (list.json() as { id: string; roleId: string; managed?: boolean }[]).find((a) => a.roleId === roleId)
      expect(managedRow?.managed, 'the list SAYS the machine owns this row').toBe(true)

      const del = await app.inject({ method: 'DELETE', url: `/admin/roles/assignments/${managedRow!.id}`, headers: HG })
      expect(del.statusCode, 'the assignment route refuses a mapping-owned row').toBe(409)
      expect(await check(fgaClient, MEMBER, 'edit', { type: 'space', id: spaceId }), 'access intact after the refusal').toBe(true)

      const delMapping = await app.inject({ method: 'DELETE', url: `/admin/roles/mappings/${mappingId}`, headers: HG })
      expect(delMapping.statusCode).toBe(204)
      expect(await check(fgaClient, MEMBER, 'edit', { type: 'space', id: spaceId }), 'the mapping is the one real revocation').toBe(false)
    } finally {
      await app.inject({ method: 'DELETE', url: `/admin/roles/${roleId}`, headers: HG }).catch(() => {})
    }
  }, 120_000)
})

// #497 re-review N1/N3 (ADR-199 §2 rev5 enforcement): the mapping surface offers the same NOUNS the
// Members picker does, so `editor` has to mean the same thing on both — edit AND comment. Before
// this, "Engineering → editor" produced editors who could not comment ('s own acceptance case),
// and the #553 backfill's manual comment sibling survived the mapping's deletion.
describe('#497 re-review N1: a builtin editor mapping confers the whole noun', () => {
  it('creates both arms mapping-owned, the group member can comment, and deleting the mapping takes both away', async () => {
    const created = await post({ resourceType: 'space', resourceId: spaceId, groupName: GROUP, builtinCapability: 'edit' })
    expect(created.statusCode).toBe(201)
    const mappingId = (created.json() as { id: string }).id
    try {
      const rows = await adminSql<{ builtin_capability: string; origin: string }[]>`
        SELECT builtin_capability, origin FROM role_assignments
        WHERE resource_type = 'space' AND resource_id = ${spaceId} AND principal = ${groupGrantee(tenant.id, GROUP)}
        ORDER BY builtin_capability`
      expect(rows.map((r) => r.builtin_capability), 'the noun is a bundle').toEqual(['comment', 'edit'])
      expect(rows.every((r) => r.origin === 'mapping'), 'BOTH arms are machine-managed').toBe(true)
      expect(await check(fgaClient, MEMBER, 'edit', { type: 'space', id: spaceId })).toBe(true)
      expect(await check(fgaClient, MEMBER, 'comment', { type: 'space', id: spaceId }), 'an editor can comment (ADR-199 §2)').toBe(true)

      const del = await app.inject({ method: 'DELETE', url: `/admin/roles/mappings/${mappingId}`, headers: HG })
      expect(del.statusCode).toBe(204)
      expect(await check(fgaClient, MEMBER, 'edit', { type: 'space', id: spaceId })).toBe(false)
      expect(await check(fgaClient, MEMBER, 'comment', { type: 'space', id: spaceId }), 'the comment arm dies with its mapping').toBe(false)
      expect((await adminSql<{ id: string }[]>`
        SELECT id FROM role_assignments WHERE resource_type = 'space' AND resource_id = ${spaceId} AND principal = ${groupGrantee(tenant.id, GROUP)}`).length,
        'no residue row').toBe(0)
    } finally {
      await app.inject({ method: 'DELETE', url: `/admin/roles/mappings/${mappingId}`, headers: HG }).catch(() => {})
    }
  }, 120_000)
})

// #497 re-review N3: the pre-existing rows the #553 backfill left MANUAL beside a mapping-owned edit.
describe('#497 re-review N3: the converge script pulls stray siblings into mapping ownership', () => {
  it('flips only the mapping-adjacent manual sibling, and the mapping delete then takes it too', async () => {
    const { planMappingComposite, executeMappingComposite } = await import('../scripts/converge-mapping-composite-497.js')
    const created = await post({ resourceType: 'space', resourceId: spaceId, groupName: GROUP, builtinCapability: 'edit' })
    expect(created.statusCode).toBe(201)
    const mappingId = (created.json() as { id: string }).id
    const principal = groupGrantee(tenant.id, GROUP)
    try {
      // simulate the backfill's residue: the comment arm exists but as a MANUAL row
      await adminSql`UPDATE role_assignments SET origin = 'manual'
        WHERE resource_type = 'space' AND resource_id = ${spaceId} AND principal = ${principal} AND builtin_capability = 'comment'`
      const plan = await planMappingComposite(adminSql, () => {})
      const mine = plan.rows.filter((r) => r.principal === principal && r.resourceId === spaceId)
      expect(mine.map((r) => r.capability), 'exactly the stray comment arm is planned').toEqual(['comment'])

      await executeMappingComposite(adminSql, { rows: mine }, () => {})
      const [after] = await adminSql<{ origin: string }[]>`
        SELECT origin FROM role_assignments WHERE resource_type = 'space' AND resource_id = ${spaceId} AND principal = ${principal} AND builtin_capability = 'comment'`
      expect(after!.origin, 'converged').toBe('mapping')
      expect((await planMappingComposite(adminSql, () => {})).rows.filter((r) => r.principal === principal).length, 'idempotent').toBe(0)

      const del = await app.inject({ method: 'DELETE', url: `/admin/roles/mappings/${mappingId}`, headers: HG })
      expect(del.statusCode).toBe(204)
      expect(await check(fgaClient, MEMBER, 'comment', { type: 'space', id: spaceId }), 'the converged arm dies with the mapping').toBe(false)
    } finally {
      await app.inject({ method: 'DELETE', url: `/admin/roles/mappings/${mappingId}`, headers: HG }).catch(() => {})
      await adminSql`DELETE FROM role_assignments WHERE resource_id = ${spaceId} AND principal = ${principal}`.catch(() => {})
    }
  }, 120_000)
})

// #497 re-review round 2: the arms the FIRST round left unpinned.
describe('#497 re-review round 2: both arms are protected, and the converge is not greedy', () => {
  it('the COMMENT arm carries the same machine-managed protection as the edit arm', async () => {
    const created = await post({ resourceType: 'space', resourceId: spaceId, groupName: GROUP, builtinCapability: 'edit' })
    expect(created.statusCode).toBe(201)
    const mappingId = (created.json() as { id: string }).id
    const principal = groupGrantee(tenant.id, GROUP)
    try {
      const listed = await listSpaceAccess(fgaClient, db, { spaceId, tenantId: tenant.id, userId: 'dev-user' })
      const mine = listed.filter((g) => g.grantee === principal)
      expect(mine.map((g) => g.capability).sort(), 'both arms listed').toEqual(['comment', 'edit'])
      expect(mine.every((g) => g.managed === true), 'BOTH arms say machine-managed').toBe(true)

      await expect(revokeSpaceAccess(db, fgaClient, app.searchDriver,
        { spaceId, tenantId: tenant.id, userId: 'dev-user', grantee: principal, capability: 'comment', plan: 'business' }),
        'the comment arm refuses a manual revoke too').rejects.toMatchObject({ statusCode: 409 })
      expect(await check(fgaClient, MEMBER, 'comment', { type: 'space', id: spaceId }), 'access intact').toBe(true)
    } finally {
      await app.inject({ method: 'DELETE', url: `/admin/roles/mappings/${mappingId}`, headers: HG }).catch(() => {})
    }
  }, 120_000)

  it('the converge plan ignores a purely MANUAL pair (no mapping-owned primary beside it)', async () => {
    const { planMappingComposite } = await import('../scripts/converge-mapping-composite-497.js')
    const solo = `user:gm497-solo-${tag}`
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: tenant.id, userId: 'dev-user', grantee: solo, capability: 'edit', plan: 'business' })
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: tenant.id, userId: 'dev-user', grantee: solo, capability: 'comment', plan: 'business' })
    try {
      const plan = await planMappingComposite(adminSql, () => {})
      expect(plan.rows.some((r) => r.principal === solo), 'a human-made pair is not the mapping\'s to claim (therule)').toBe(false)
    } finally {
      await adminSql`DELETE FROM role_assignments WHERE resource_id = ${spaceId} AND principal = ${solo}`.catch(() => {})
    }
  }, 120_000)
})
