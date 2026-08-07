// #536 (6): the assignments list names GROUPS. A group principal is a tenant-salted hash
// (groupFgaId is one-way), and the merged member list rendered it verbatim — "a13d1861… (group)".
// The server resolves the hash back to the human name (group-sync.ts stays the single id authority);
// an ORPHAN id (group renamed/emptied at the IdP) simply carries no groupName — the client shows its
// explicit "unknown group" label and the row stays revocable. Pinned: the response's name fields never
// carry a raw 24-hex hash.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { groupFgaId } from '../auth/group-sync.js'
import { createSpace, deleteSpace, listAllSpaceAccess } from '../routes/spaces.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'
const GROUP = `gna-engineering-${STAMP}`
const MEMBER_SUB = `gna-member-${STAMP}`

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let roleId = ''

const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `gna-${STAMP}` })).id
  roleId = `gna-role-${STAMP}`
  await adminPool`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${roleId}, ${TENANT}, ${`gna-${STAMP}`}, ARRAY['view']::text[], 'resource')`
  // a member whose IdP groups carry the human name — the reverse lookup's source
  await adminPool`INSERT INTO members (tenant_id, sub, display_name, groups) VALUES (${TENANT}, ${MEMBER_SUB}, ${'GNA Member'}, ${[GROUP]})`
}, 120_000)

afterAll(async () => {
  await adminPool`DELETE FROM role_assignments WHERE resource_id = ${spaceId}`.catch(() => {})
  await adminPool`DELETE FROM roles WHERE id = ${roleId}`.catch(() => {})
  await adminPool`DELETE FROM members WHERE tenant_id = ${TENANT} AND sub = ${MEMBER_SUB}`.catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await adminPool`DELETE FROM search_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

const HEX24 = /^[0-9a-f]{24}$/

describe('#536 (6): group assignments carry the human name, never the hash', () => {
  it('a group assignment (by name) lists back WITH groupName; no name field is a raw hash', async () => {
    const res = await app.inject({
      method: 'POST', url: `/admin/roles/${roleId}/assignments`, headers: dev,
      payload: { resourceType: 'space', resourceId: spaceId, groupName: GROUP },
    })
    expect(res.statusCode).toBe(201)
    const list = await app.inject({ method: 'GET', url: `/admin/roles/assignments?resourceType=space&resourceId=${spaceId}`, headers: dev })
    expect(list.statusCode).toBe(200)
    const rows = list.json() as { principal: string; roleName: string; groupName?: string; displayName?: string | null }[]
    const row = rows.find((r) => r.principal.startsWith('group:'))
    expect(row, 'the group assignment lists').toBeTruthy()
    expect(row!.principal, 'the principal stays the derived id (the wire format)').toContain(groupFgaId(TENANT, GROUP))
    expect(row!.groupName, 'the human name rides along for display').toBe(GROUP)
    for (const r of rows) {
      for (const v of [r.roleName, r.groupName, r.displayName]) {
        if (typeof v === 'string') expect(v, `a name field must never be the raw hash (${JSON.stringify(r)})`).not.toMatch(HEX24)
      }
    }
  }, 120_000)

  it('an ORPHAN group id (no member carries the group any more) lists with NO groupName', async () => {
    // simulate the IdP-side rename/emptying: a stored assignment whose id no known group resolves to
    const ghost = `group:${groupFgaId(TENANT, `gna-ghost-${STAMP}`)}#member`
    await adminPool`INSERT INTO role_assignments (id, tenant_id, role_id, resource_type, resource_id, principal, owned_capabilities, origin)
      VALUES (${randomUUID()}, ${TENANT}, ${roleId}, 'space', ${spaceId}, ${ghost}, ARRAY['view']::text[], 'manual')`
    const list = await app.inject({ method: 'GET', url: `/admin/roles/assignments?resourceType=space&resourceId=${spaceId}`, headers: dev })
    const rows = list.json() as { principal: string; groupName?: string }[]
    const row = rows.find((r) => r.principal === ghost)
    expect(row, 'the orphan row still lists (revocable)').toBeTruthy()
    expect(row!.groupName, 'no fabricated name — the client shows its explicit orphan label').toBeUndefined()
  }, 120_000)

  // #536 "we cannot resolve this id" and "nobody is in this group right now" are DIFFERENT
  // facts, and the list was reporting the second as the first. A mapping OWNS its assignment and
  // stores the name it was created with, so a mapping-derived row can be named even when the group has
  // been emptied at the IdP — measured on the motivating data, where /admin/roles/mappings answered
  // groupName "Engineering" for the very assignment the list drew as "unknown group".
  it('a MAPPING-derived row is named even when no member carries the group any more', async () => {
    const orphanGroup = `gna-mapped-orphan-${STAMP}`
    const principal = `group:${groupFgaId(TENANT, orphanGroup)}#member`
    const assignmentId = randomUUID()
    await adminPool`INSERT INTO role_assignments (id, tenant_id, role_id, resource_type, resource_id, principal, owned_capabilities, origin)
      VALUES (${assignmentId}, ${TENANT}, ${roleId}, 'space', ${spaceId}, ${principal}, ARRAY['view']::text[], 'mapping')`
    await adminPool`INSERT INTO group_role_mappings (id, tenant_id, group_name, role_id, resource_type, resource_id, assignment_id, created_by)
      VALUES (${randomUUID()}, ${TENANT}, ${orphanGroup}, ${roleId}, 'space', ${spaceId}, ${assignmentId}, ${OWNER})`
    try {
      const list = await app.inject({ method: 'GET', url: `/admin/roles/assignments?resourceType=space&resourceId=${spaceId}`, headers: dev })
      const row = (list.json() as { principal: string; groupName?: string; managed?: boolean }[]).find((r) => r.principal === principal)
      expect(row!.groupName, 'the product knows this name — it must not say "unknown"').toBe(orphanGroup)
      expect(row!.managed, 'and it is still drawn as machine-owned').toBe(true)
    } finally {
      await adminPool`DELETE FROM group_role_mappings WHERE assignment_id = ${assignmentId}`.catch(() => {})
      await adminPool`DELETE FROM role_assignments WHERE id = ${assignmentId}`.catch(() => {})
    }
  }, 120_000)

  // the same fact on the OTHER surface: the space Members list resolves through the same helper
  it('the space member list names a mapping-owned group grant the same way', async () => {
    const orphanGroup = `gna-mapped-orphan2-${STAMP}`
    const principal = `group:${groupFgaId(TENANT, orphanGroup)}#member`
    const assignmentId = randomUUID()
    await adminPool`INSERT INTO role_assignments (id, tenant_id, builtin_capability, resource_type, resource_id, principal, owned_capabilities, origin)
      VALUES (${assignmentId}, ${TENANT}, 'view', 'space', ${spaceId}, ${principal}, ARRAY['view']::text[], 'mapping')`
    await adminPool`INSERT INTO group_role_mappings (id, tenant_id, group_name, builtin_capability, resource_type, resource_id, assignment_id, created_by)
      VALUES (${randomUUID()}, ${TENANT}, ${orphanGroup}, 'view', 'space', ${spaceId}, ${assignmentId}, ${OWNER})`
    await writeTuples(fgaClient, [
      { user: principal, relation: 'viewer', object: `space:${spaceId}` },
      { user: principal, relation: 'viewer_member', object: `space:${spaceId}` },
    ])
    try {
      const rows = await listAllSpaceAccess(fgaClient, db, { spaceId, tenantId: TENANT, userId: OWNER })
      const row = rows.find((r) => r.grantee === principal)
      expect(row!.groupName, 'both surfaces resolve through knownGroupNames').toBe(orphanGroup)
    } finally {
      await deleteTuples(fgaClient, [
        { user: principal, relation: 'viewer', object: `space:${spaceId}` },
        { user: principal, relation: 'viewer_member', object: `space:${spaceId}` },
      ]).catch(() => {})
      await adminPool`DELETE FROM group_role_mappings WHERE assignment_id = ${assignmentId}`.catch(() => {})
      await adminPool`DELETE FROM role_assignments WHERE id = ${assignmentId}`.catch(() => {})
    }
  }, 120_000)
})
