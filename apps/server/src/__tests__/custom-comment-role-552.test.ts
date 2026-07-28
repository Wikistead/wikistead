// #552: the built-in `commenter` role is gone — but the ruling is explicit that the `comment`
// CAPABILITY and its space leaf stay, because removing them resurrects #514's symptom: a CUSTOM role
// carrying `comment` refused at space scope with a 400. This pin is the ticket's own must-have —
// "without it, breaking the mechanism along with the role would still be green".
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { fgaClient, checkRelation } from '@wikistead/authz'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { assignRoleInTx } from '../routes/roles.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const OWNER = 'dev-user'
let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
let spaceId: string
let roleId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))! as Tenant
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, name: `c552-${Date.now().toString(36)}`, userId: OWNER, plan: 'business' })).id
  const [r] = await adminPool<{ id: string }[]>`
    INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (gen_random_uuid()::text, ${TENANT}, ${`c552-commenters-${Date.now().toString(36)}`}, ${'{comment}'}, 'resource') RETURNING id`
  roleId = r!.id
}, 120_000)

afterAll(async () => {
  await adminPool`DELETE FROM role_assignments WHERE resource_id = ${spaceId}`.catch(() => {})
  await adminPool`DELETE FROM roles WHERE id = ${roleId}`.catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

describe('#552: a custom role carrying `comment` still assigns at space scope', () => {
  it('assignment succeeds (no 400) and the principal actually gains comment', async () => {
    const principal = `user:c552-p-${Date.now().toString(36)}`
    await expect(
      assignRoleInTx(db, fgaClient, app.searchDriver, {
        tenant, roleId, capabilities: ['comment'], resourceType: 'space', resourceId: spaceId,
        principal, actorSub: OWNER,
      }),
    ).resolves.toBeDefined()
    expect(await checkRelation(fgaClient, principal, 'commenter', { type: 'space', id: spaceId }), 'the leaf landed').toBe(true)
  }, 120_000)
})
