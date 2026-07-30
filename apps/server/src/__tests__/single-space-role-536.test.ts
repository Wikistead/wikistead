// #536item 2: ONE principal = ONE role on a space. A manual add REPLACES the principal's other
// manual roles (server-side convergence — the UI confirm is convenience, this is the fortress):
//   - grant → grant: the second capability replaces the first (row AND tuples).
//   - grant → role assignment (the HTTP route): the built-in row is swept; only the assignment remains.
//   - a machine-owned (mapping-origin) row refuses the manual add up front (409, nothing written) —
//     ADR-183 §1: the mapping owns the principal's role; replacing it manually would strand the mapping.
//   - legacy ROWLESS tuples (pre-086) converge in the same pass (the recorded migration policy:
//     duplicates are cleaned on the next add for that principal; untouched principals keep their rows).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, writeTuples, deleteTuples } from '@wikistead/authz'
import { createSpace, deleteSpace, grantSpaceAccess } from '../routes/spaces.js'
import { createPage, deletePage, publishPage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let pageId = ''
let roleId = ''
const subs: string[] = []
const sub = (n: string) => { const s = `s1r-${n}-${STAMP}`; subs.push(s); return `user:${s}` }

const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `s1r-${STAMP}` })).id
  pageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `s1r-${STAMP}` })).id
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  roleId = `s1r-role-${STAMP}`
  await adminPool`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${roleId}, ${TENANT}, ${`s1r-${STAMP}`}, ARRAY['edit']::text[], 'resource')`
}, 120_000)

afterAll(async () => {
  await adminPool`DELETE FROM role_assignments WHERE resource_id = ${spaceId}`.catch(() => {})
  await adminPool`DELETE FROM roles WHERE id = ${roleId}`.catch(() => {})
  await deletePage(db, fgaClient, app.searchDriver, { pageId, userId: OWNER }).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await adminPool`DELETE FROM search_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

const grant = (principal: string, capability: string) =>
  grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: principal, capability, plan: 'business' })
const rowsOf = (principal: string) => adminPool<{ role_id: string | null; builtin_capability: string | null; origin: string }[]>`
  SELECT role_id, builtin_capability, origin FROM role_assignments WHERE resource_type = 'space' AND resource_id = ${spaceId} AND principal = ${principal} ORDER BY builtin_capability`
const canView = (principal: string) => check(fgaClient, principal, 'view', { type: 'page', id: pageId })
const canEdit = (principal: string) => check(fgaClient, principal, 'edit', { type: 'page', id: pageId })

describe('#536one principal, one space role (replace semantics)', () => {
  it('grant → grant replaces: the second capability is the only one left (row AND access)', async () => {
    const p = sub('g-g')
    await grant(p, 'view')
    await grant(p, 'edit')
    const rows = await rowsOf(p)
    expect(rows).toEqual([{ role_id: null, builtin_capability: 'edit', origin: 'manual' }])
    expect(await canEdit(p), 'the new role is in force').toBe(true)
    // view is still true THROUGH edit (edit ⇒ view); the point is the old row is gone, pinned above.
  }, 120_000)

  it('grant → role ASSIGN (HTTP route) replaces: only the assignment remains; a direct API double-add converges to one', async () => {
    const p = sub('g-a')
    await grant(p, 'view')
    const res = await app.inject({
      method: 'POST', url: `/admin/roles/${roleId}/assignments`, headers: dev,
      payload: { resourceType: 'space', resourceId: spaceId, principal: p },
    })
    expect(res.statusCode).toBe(201)
    const rows = await rowsOf(p)
    expect(rows).toEqual([{ role_id: roleId, builtin_capability: null, origin: 'manual' }])
    expect(await canEdit(p), "the role's bundle is in force").toBe(true)
  }, 120_000)

  it('a mapping-owned row refuses the manual add up front (409, nothing swept)', async () => {
    const p = sub('machine')
    await adminPool`INSERT INTO role_assignments (id, tenant_id, role_id, builtin_capability, resource_type, resource_id, principal, owned_capabilities, origin)
      VALUES (${randomUUID()}, ${TENANT}, NULL, 'view', 'space', ${spaceId}, ${p}, ARRAY['view']::text[], 'mapping')`
    await writeTuples(fgaClient, [
      { user: p, relation: 'viewer', object: `space:${spaceId}` },
      { user: p, relation: 'viewer_member', object: `space:${spaceId}` },
    ])
    await expect(grant(p, 'edit')).rejects.toMatchObject({ statusCode: 409 })
    const rows = await rowsOf(p)
    expect(rows).toEqual([{ role_id: null, builtin_capability: 'view', origin: 'mapping' }]) // untouched
    expect(await canView(p), 'the mapping-conferred access is intact').toBe(true)
    await deleteTuples(fgaClient, [
      { user: p, relation: 'viewer', object: `space:${spaceId}` },
      { user: p, relation: 'viewer_member', object: `space:${spaceId}` },
    ]).catch(() => {})
  }, 120_000)

  it('legacy ROWLESS tuples converge in the same pass (the recorded pre-086 migration policy)', async () => {
    const p = sub('rowless')
    // a pre-086 grant: tuples, no row
    await writeTuples(fgaClient, [
      { user: p, relation: 'viewer', object: `space:${spaceId}` },
      { user: p, relation: 'viewer_member', object: `space:${spaceId}` },
    ])
    expect(await canView(p), 'the legacy grant works before the add').toBe(true)
    await grant(p, 'edit')
    const rows = await rowsOf(p)
    expect(rows).toEqual([{ role_id: null, builtin_capability: 'edit', origin: 'manual' }])
    // the stray viewer leaves are gone; view now flows only through edit
    const { tuples } = await fgaClient.read({ user: p, object: `space:${spaceId}` })
    const relations = (tuples ?? []).map((t) => t.key?.relation).sort()
    expect(relations).not.toContain('viewer')
    expect(await canEdit(p)).toBe(true)
  }, 120_000)
})

describe('#536the structural owner grant is never swept', () => {
  it('a ROWLESS manage (the createSpace creator leaf) survives an add for that principal', async () => {
    const p = sub('owner-ish')
    // the creator-shaped state: a manager leaf with no role_assignments row
    await writeTuples(fgaClient, [{ user: p, relation: 'manager', object: `space:${spaceId}` }])
    await grant(p, 'view')
    const rows = await rowsOf(p)
    expect(rows).toEqual([{ role_id: null, builtin_capability: 'view', origin: 'manual' }])
    const { tuples } = await fgaClient.read({ user: p, object: `space:${spaceId}` })
    const relations = (tuples ?? []).map((t) => t.key?.relation)
    expect(relations, 'the structural manage leaf is untouched').toContain('manager')
    await deleteTuples(fgaClient, [{ user: p, relation: 'manager', object: `space:${spaceId}` }]).catch(() => {})
  }, 120_000)
})

describe('#536manage is exempt from auto-replacement (lockout prevention)', () => {
  it('a row-tracked manage grant survives a later add; the two coexist', async () => {
    const p = sub('mgr-keep')
    await grant(p, 'manage')
    await grant(p, 'view')
    const rows = await rowsOf(p)
    expect(rows).toEqual([
      { role_id: null, builtin_capability: 'manage', origin: 'manual' },
      { role_id: null, builtin_capability: 'view', origin: 'manual' },
    ])
  }, 120_000)
})
