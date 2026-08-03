// #604 / ADR-208 (ruling B): `admin` stops being the only way to run a tenant's sign-in methods.
//
// Until now every tenant power — connections, roles, billing, the public surface, audit, SCIM — was
// carried by one tier, so "let somebody manage the IdP connections" meant handing them the tenant. This
// is the first verb carved out: a tenant role can carry `manageConnections`, and the connections routes
// ask for the verb rather than the tier.
//
// Measured in a REAL store, because the claim is about what the model resolves — not about which helper
// a route calls. Three facts, and the middle one is the point of the change:
//   - an admin still passes (the `or admin` arm; nobody loses anything)
//   - a member holding a role that carries the verb passes WITHOUT being an admin
//   - a plain member does not
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, isConnectionManager } from '@wikistead/authz'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const HOLDER = `conn604-holder-${STAMP}`
const PLAIN = `conn604-plain-${STAMP}`
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

let app: FastifyInstance
let db: TenantDb
let roleId = ''

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  const res = await app.inject({
    method: 'POST', url: '/admin/roles', headers: H,
    payload: { name: `conn604-${STAMP}`, capabilities: ['manageConnections'], scope: 'tenant' },
  })
  expect(res.statusCode, res.body).toBe(201)
  roleId = (res.json() as { id: string }).id
  const assign = await app.inject({
    method: 'POST', url: `/admin/roles/${roleId}/assignments`, headers: H,
    payload: { resourceType: 'tenant', resourceId: TENANT, principal: `user:${HOLDER}` },
  })
  expect(assign.statusCode, assign.body).toBe(201)
}, 180_000)

afterAll(async () => {
  await admin`DELETE FROM role_assignments WHERE principal = ${`user:${HOLDER}`}`.catch(() => {})
  await admin`DELETE FROM roles WHERE id = ${roleId}`.catch(() => {})
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 120_000)

describe('#604: managing sign-in methods is a verb, not the tier', () => {
  it('a member who holds the role can manage connections, without being an admin', async () => {
    expect(await isConnectionManager(fgaClient, HOLDER, TENANT), 'the role confers the verb').toBe(true)
    const { isTenantAdmin } = await import('@wikistead/authz')
    expect(await isTenantAdmin(fgaClient, HOLDER, TENANT), 'and it did NOT make them an admin').toBe(false)
  }, 120_000)

  it('a member who holds nothing cannot', async () => {
    expect(await isConnectionManager(fgaClient, PLAIN, TENANT)).toBe(false)
  }, 120_000)

  it('an admin still can — the verb unions `or admin`, so nobody lost anything', async () => {
    expect(await isConnectionManager(fgaClient, 'dev-user', TENANT)).toBe(true)
  }, 120_000)
})
