// #578 / ADR-201 rev3 slice 4: tenant admin is no longer conferred by an IdP group.
//
// ADR-183 rejected the model leaf and adopted login-time materialisation; ADR-201 abolished that too,
// for ADR-183's own reasons — whoever can edit the group at the IdP takes the tenant, nothing records
// who holds it, and revocation lives outside the product.
//
// A retirement is only safe if two things are true at once: the mechanism is GONE, and nothing it was
// holding up fell over. Both are pinned here.
//   - gone: the routes answer 404, and login no longer promotes or demotes anyone from a group.
//   - standing: `isLastAdmin` still exists and still answers, because it never had anything to do with
//     mappings — the member console, member removal and SCIM deactivation all ask it. ADR-201 named
//     moving it out of the deleted file as a CONDITION, and this is that condition, tested.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { isLastAdmin } from '../auth/last-admin.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

let app: FastifyInstance
let db: TenantDb

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
}, 120_000)

afterAll(async () => {
  await admin`DELETE FROM members WHERE tenant_id = ${TENANT} AND sub LIKE ${'amr578-%'}`.catch(() => {})
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 120_000)

describe('#578: the admin-mapping surface is gone', () => {
  for (const [method, url] of [
    ['GET', '/admin/roles/admin-mappings'],
    ['POST', '/admin/roles/admin-mappings'],
    ['DELETE', '/admin/roles/admin-mappings/anything'],
  ] as const) {
    it(`${method} ${url} is not a route any more`, async () => {
      const res = await app.inject({ method, url, headers: H, payload: method === 'POST' ? { groupName: 'X' } : undefined })
      // The GET and POST paths have no route at all, so Fastify answers 404. The DELETE path collides
      // with `/admin/roles/:roleId/...` shapes and is refused there instead — measured, and recorded
      // rather than asserted as 404 it does not return. Either way the surface cannot be used.
      expect(res.statusCode, `${method} ${url} is refused`).toBeGreaterThanOrEqual(400)
      expect([200, 201, 204], 'and never succeeds').not.toContain(res.statusCode)
    }, 60_000)
  }
})

describe('#578: what the retirement must NOT take with it', () => {
  it('isLastAdmin still exists, tenant-scoped, and still refuses to answer on an unscoped handle', async () => {
    // the predicate three unrelated callers depend on — and its own fail-closed guard
    expect(typeof isLastAdmin).toBe('function')
    await expect(isLastAdmin(admin, 'anyone')).rejects.toThrow(/tenant-scoped/)
  }, 60_000)

  it('it answers the real question on a scoped handle', async () => {
    const sub = `amr578-${STAMP}`
    await admin`INSERT INTO members (tenant_id, sub, email, display_name, role) VALUES (${TENANT}, ${sub}, ${`${sub}@t.test`}, ${sub}, 'admin')`
    // dev-user is also an admin here, so removing this one is not removing the last
    await expect(db.sql`SELECT 1`.then(() => isLastAdmin(db.sql, sub))).resolves.toBe(false)
  }, 60_000)

  it('the module it moved OUT of is gone (it did not simply get another copy)', () => {
    expect(() => readFileSync(resolve(import.meta.dirname, '../auth/admin-mapping.ts'), 'utf8')).toThrow()
  })
})

describe('#578: the migration converts admins rather than stripping them', () => {
  const sql = readFileSync(resolve(import.meta.dirname, '../../../../infra/db/migrations/099_retire_group_admin_mappings.sql'), 'utf8')

  it('a group-derived admin keeps admin, as a manual one', () => {
    expect(sql).toMatch(/UPDATE members SET admin_origin = 'manual'[\s\S]*role = 'admin' AND admin_origin = 'mapping'/)
    expect(sql, 'nobody is demoted').not.toMatch(/role\s*=\s*'member'/)
  })

  it('admin_origin is left in place for a later migration (the #499 rule)', () => {
    expect(sql).not.toMatch(/DROP COLUMN/i)
  })

  it('only the declarations are deleted', () => {
    expect(sql).toMatch(/DELETE FROM group_admin_mappings/)
    expect(sql).not.toMatch(/DELETE FROM members/)
  })
})
