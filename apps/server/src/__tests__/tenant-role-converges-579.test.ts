// #579 (user ruling, recorded twice): a principal holds ONE tenant role, and the server is what makes
// that true.
//
// — the tenant screen had grown chips and an "add
// role" control on top of a mechanism that never promised stacking. #536 had already ruled it: one
// principal, one role, converged BY THE SERVER and not by a UI guard. Space scope implemented it
// (sweepOtherSpaceRoles); tenant scope did not, so two direct API calls left one member holding two
// tenant roles — and the screen then had to invent a way to display them.
//
// What is pinned here is the part a UI cannot fake: the API itself. Two assignments through the route,
// no client involved, and the second one wins. The capabilities of the first are gone from FGA, not just
// from a list — a converged role that still grants what it replaced would be the worst of both.
import { seatMembers, unseatMembers } from './helpers/seat-members.js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const SUBJECT = `conv579-${STAMP}`
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

let app: FastifyInstance
let db: TenantDb
let roleA = ''
let roleB = ''

const makeRole = async (name: string, capabilities: string[]): Promise<string> => {
  const res = await app.inject({ method: 'POST', url: '/admin/roles', headers: H, payload: { name, capabilities, scope: 'tenant' } })
  expect(res.statusCode, res.body).toBe(201)
  return (res.json() as { id: string }).id
}
const assign = (roleId: string) => app.inject({
  method: 'POST', url: `/admin/roles/${roleId}/assignments`, headers: H,
  payload: { resourceType: 'tenant', resourceId: TENANT, principal: `user:${SUBJECT}` },
})
// The tenant capabilities expand to their own relations on the tenant object (#445); ask FGA directly
// rather than through the capability helper, which only knows the resource vocabulary.
const holds = async (relation: string): Promise<boolean> =>
  (await fgaClient.check({ user: `user:${SUBJECT}`, relation, object: `tenant:${TENANT}` })).allowed === true
const rows = () => admin<{ id: string; role_id: string }[]>`
  SELECT id, role_id FROM role_assignments
  WHERE resource_type = 'tenant' AND resource_id = ${TENANT} AND principal = ${`user:${SUBJECT}`}`

beforeAll(async () => {
  // #624: a grant names somebody who is HERE — the route refuses a principal with no members row
  await seatMembers(admin, TENANT, [SUBJECT])
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  roleA = await makeRole(`conv579-a-${STAMP}`, ['createSpaces'])
  roleB = await makeRole(`conv579-b-${STAMP}`, ['issueApiKeys'])
}, 120_000)

afterAll(async () => {
  await unseatMembers(admin, TENANT, [SUBJECT])
  await admin`DELETE FROM role_assignments WHERE principal = ${`user:${SUBJECT}`}`.catch(() => {})
  await admin`DELETE FROM roles WHERE id IN (${roleA}, ${roleB})`.catch(() => {})
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 120_000)

describe('#579: a tenant role replaces, it does not accumulate', () => {
  it('a second assignment through the API leaves exactly one row', async () => {
    expect((await assign(roleA)).statusCode).toBe(201)
    expect((await rows()).length, 'the first one landed').toBe(1)

    expect((await assign(roleB)).statusCode, 'the second is accepted — this is a replacement, not a refusal').toBe(201)
    const after = await rows()
    expect(after.length, 'one principal, one tenant role').toBe(1)
    expect(after[0]!.role_id, 'and it is the one just chosen').toBe(roleB)
  }, 120_000)

  it('the capabilities of the replaced role are actually gone, not just its row', async () => {
    // A converged role that still granted what it replaced would be the worst of both: a tidy list and
    // an untouched authorization state. `createSpaces` came from role A, `issueApiKeys` from role B.
    expect(await holds('space_creator'), 'the replaced role stopped granting').toBe(false)
    expect(await holds('api_key_issue'), 'and the new one grants').toBe(true)
  }, 120_000)

  it('re-assigning the SAME role is refused as a duplicate, and changes nothing', async () => {
    // Measured, not assumed: the duplicate guard answers 409 BEFORE the convergence sweep runs, so
    // "assign what they already have" is a no-op rather than a delete-and-rewrite. Worth pinning
    // because the sweep deletes by id — a version that swept first would take the role away and then
    // refuse to give it back.
    expect((await assign(roleB)).statusCode).toBe(409)
    const after = await rows()
    expect(after.length, 'still one row, still the same role').toBe(1)
    expect(after[0]!.role_id).toBe(roleB)
    expect(await holds('api_key_issue'), 'and they still hold what it grants').toBe(true)
  }, 120_000)
})
