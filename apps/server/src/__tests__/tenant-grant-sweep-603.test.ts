// #603 (found by the ADR review, fixed on its own because it is true today): removing a member left
// every TENANT-scope grant they held behind.
//
// The removal sweep read `space:` and `page:` objects and stopped. So `space_creator`, `api_key_issue`
// and — since #604 — the verbs carved out of admin survived the person they were given to, in the
// tuple store AND as assignment rows. Rejoining (an invite, a domain self-enrol) restored them
// silently: the same sub, the same grants, nobody's decision.
//
// Measured in a real store, both halves, because a row without a tuple is a ledger that lies and a
// tuple without a row is a power nobody can see.
import { seatMembers, unseatMembers } from './helpers/seat-members.js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { sweepMemberDirectGrants } from '../routes/members.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const SUB = `sweep603-${STAMP}`
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

let app: FastifyInstance
let db: TenantDb
let roleId = ''

const holds = async (relation: string): Promise<boolean> =>
  (await fgaClient.check({ user: `user:${SUB}`, relation, object: `tenant:${TENANT}` })).allowed === true
const rows = async (): Promise<number> =>
  Number((await admin<{ n: string }[]>`SELECT count(*) AS n FROM role_assignments
    WHERE resource_type = 'tenant' AND resource_id = ${TENANT} AND principal = ${`user:${SUB}`}`)[0]!.n)

beforeAll(async () => {
  // #624: a tenant role names somebody who is HERE — seated so this file measures its own subject
  await seatMembers(admin, TENANT, [SUB])
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  const res = await app.inject({ method: 'POST', url: '/admin/roles', headers: H,
    payload: { name: `sweep603-${STAMP}`, capabilities: ['createSpaces'], scope: 'tenant' } })
  expect(res.statusCode, res.body).toBe(201)
  roleId = (res.json() as { id: string }).id
  const assign = await app.inject({ method: 'POST', url: `/admin/roles/${roleId}/assignments`, headers: H,
    payload: { resourceType: 'tenant', resourceId: TENANT, principal: `user:${SUB}` } })
  expect(assign.statusCode, assign.body).toBe(201)
}, 180_000)

afterAll(async () => {
  await unseatMembers(admin, TENANT, [SUB])
  await admin`DELETE FROM role_assignments WHERE principal = ${`user:${SUB}`}`.catch(() => {})
  await admin`DELETE FROM roles WHERE id = ${roleId}`.catch(() => {})
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 120_000)

describe('#603: a tenant-scope grant does not outlive the member it was made for', () => {
  it('the grant is real before the removal (a sweep over nothing proves nothing)', async () => {
    expect(await holds('space_creator'), 'the role conferred it').toBe(true)
    expect(await rows(), 'and the row that owns it exists').toBe(1)
  }, 120_000)

  it('the removal sweep takes both the tuple and the row', async () => {
    await sweepMemberDirectGrants(db, fgaClient, app.searchDriver, { tenantId: TENANT, sub: SUB })
    expect(await holds('space_creator'), 'the power is gone — rejoining cannot wake it up').toBe(false)
    expect(await rows(), 'and so is the row, so no ledger claims otherwise').toBe(0)
  }, 120_000)
})
