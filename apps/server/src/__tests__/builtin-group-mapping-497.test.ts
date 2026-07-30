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
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, check } from '@wikistead/authz'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { groupGrantee } from '../auth/group-sync.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const H = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }
const HG = { host: 'dev.localhost', authorization: 'Bearer dev-token' } // bodyless verbs: no content-type (Fastify 400s an empty JSON body)
const tag = Date.now().toString(36)
const GROUP = `eng-497-${tag}`
const MEMBER = `user:g497-member-${tag}`

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
let spaceId: string

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))! as Tenant
  db = await acquireTenantDb(tenant)
  app = await buildApp()
  await app.ready()
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `gm497-${tag}` })).id
  // the #111 sync would write this on login; the test writes the SAME tuple the sync writes
  await writeTuples(fgaClient, [{ user: MEMBER, relation: 'member', object: groupGrantee(tenant.id, GROUP).replace('#member', '') }])
}, 120_000)

afterAll(async () => {
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await app?.close()
  await db.release()
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
