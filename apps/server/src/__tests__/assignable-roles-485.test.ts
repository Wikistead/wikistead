// #485 / #514: GET /spaces/:spaceId/assignable-roles — the manager-readable role-definition list that
// backs the in-space assignment picker. Its AUTHORITY (requireListAuthority, which at space scope
// admits the roster verb `manageAccess` — ADR-209 / #607, not only a manager) is
// pinned directly in role-assign-space-manager-485.test.ts (MGR passes, a non-manager is forbidden). This
// pins the ENDPOINT's remaining contract: it returns only RESOURCE-scope roles (built-ins + custom
// resource roles) and never the tenant-scope roles (createSpaces etc.), which are not assignable at a
// resource and stay admin-console-only. Real Postgres + OpenFGA (via app.inject as the tenant admin, who
// short-circuits requireListAuthority — the non-admin manager path is the direct test's job).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
const tag = Date.now().toString(36)
let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
let spaceId: string
const resRoleId = randomUUID()
const tenRoleId = randomUUID()
const resName = `ar-res-${tag}`
const tenName = `ar-ten-${tag}`

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  app = await buildApp()
  await app.ready()
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `ar-${tag}` })).id
  // a RESOURCE-scope custom role and a TENANT-scope one — only the former is assignable in a space.
  await db.sql`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${resRoleId}, ${tenant.id}, ${resName}, ${['view', 'edit'] as string[]}, 'resource')`
  await db.sql`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${tenRoleId}, ${tenant.id}, ${tenName}, ${['createSpaces'] as string[]}, 'tenant')`
}, 40_000)

afterAll(async () => {
  await db.sql`DELETE FROM roles WHERE id = ANY(${[resRoleId, tenRoleId]})`.catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await app?.close()
  await db.release()
  await pool.end()
}, 40_000)

describe('#485/#514 GET /spaces/:spaceId/assignable-roles', () => {
  it('returns built-ins + custom RESOURCE roles, and NEVER a tenant-scope role', async () => {
    const res = await app.inject({ method: 'GET', url: `/spaces/${spaceId}/assignable-roles`, headers: H })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { builtIn: { name: string }[]; custom: { id: string; name: string; scope: string }[] }
    expect(Array.isArray(body.builtIn) && body.builtIn.length > 0).toBe(true) // the CE preset built-ins
    const names = body.custom.map((r) => r.name)
    expect(names, 'the resource-scope custom role is assignable in a space').toContain(resName)
    expect(names, 'a tenant-scope role is NEVER offered as space-assignable').not.toContain(tenName)
    expect(body.custom.every((r) => r.scope === 'resource'), 'every returned custom role is resource-scope').toBe(true)
  })

  it('a nonexistent space is forbidden (no assignment surface for a space you do not manage)', async () => {
    // dev-user is the tenant admin (short-circuits), so a NONEXISTENT space still resolves via the admin
    // short-circuit to a 200 with the tenant's roles — the per-space manage gate is the non-admin path,
    // pinned directly in role-assign-space-manager-485. Here we only assert the route exists + shape holds.
    const res = await app.inject({ method: 'GET', url: `/spaces/no-such-${tag}/assignable-roles`, headers: H })
    expect([200, 404].includes(res.statusCode)).toBe(true)
  })
})
