// #634: removing a member took their tuples and left their assignment ROWS.
//
// The sweep deleted rows for the `tenant` scope only — added by #603's review, which fixed the scope in
// front of it and stopped — while the tuple side read `space:`, `page:` and `tenant:`. So a removed
// member kept a row in every space and page roster that granted them nothing: the ledger says they have
// access, the store says they do not, and the admin reading the roster is the one who is wrong. It is the
// same split #596 exists to forbid, and it is where the "unknown member" rows #578 had to render came
// from — the display was handled, the source went on producing them.
//
// The assertions below never name a scope. They ask for the rows this principal has, whatever type they
// are on, because the defect WAS a list of scopes that fell behind the code beside it: a fourth resource
// type would repeat it exactly, and a test that spelled out today's three would not notice.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { sweepMemberDirectGrants } from '../routes/members.js'
import { buildApp } from '../app.js'
import { seatMembers, unseatMembers } from './helpers/seat-members.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const OTHER = 'tenant_acme' // ships in the fixture; used only to prove the sweep stops at the boundary
const STAMP = Date.now().toString(36)
const SUB = `rm634-${STAMP}`
const USER = `user:${SUB}`
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant

let app: FastifyInstance
let db: TenantDb
const spaceId = `rm634-space-${STAMP}`
const pageId = `rm634-page-${STAMP}`
const roleId = `rm634-role-${STAMP}`

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  await seatMembers(admin, TENANT, [SUB])
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${spaceId}, ${TENANT}, 'rm634') ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, title) VALUES (${pageId}, ${TENANT}, ${spaceId}, 'rm634') ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${roleId}, ${TENANT}, ${roleId}, ARRAY['view']::text[], 'resource') ON CONFLICT (id) DO NOTHING`
  await writeTuples(fgaClient, [{ user: `tenant:${TENANT}`, relation: 'tenant', object: `space:${spaceId}` }]).catch(() => {})
}, 180_000)

afterAll(async () => {
  await admin`DELETE FROM role_assignments WHERE principal = ${USER}`.catch(() => {})
  await admin`DELETE FROM roles WHERE id = ${roleId}`.catch(() => {})
  await admin`DELETE FROM pages WHERE id = ${pageId}`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${spaceId}`.catch(() => {})
  await admin`DELETE FROM search_outbox WHERE page_id = ${pageId}`.catch(() => {})
  await unseatMembers(admin, TENANT, [SUB]).catch(() => {})
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 180_000)

/** Every row this principal holds, by scope — asked for, never listed. */
const rowsFor = async (principal: string, tenantId = TENANT): Promise<string[]> =>
  (await admin<{ resource_type: string }[]>`
    SELECT resource_type FROM role_assignments WHERE principal = ${principal} AND tenant_id = ${tenantId}
    ORDER BY resource_type`).map((r) => r.resource_type)

const addRow = (resourceType: string, resourceId: string, principal = USER, tenantId = TENANT, origin = 'manual') =>
  admin`INSERT INTO role_assignments (id, tenant_id, role_id, resource_type, resource_id, principal, origin)
        VALUES (${`${resourceType}-${resourceId}-${principal}`.slice(0, 60)}, ${tenantId}, ${roleId}, ${resourceType}, ${resourceId}, ${principal}, ${origin})
        ON CONFLICT DO NOTHING`

describe('#634: a removed member leaves no assignment row behind', () => {
  it('sweeps every scope, including a row whose tuple is already gone', async () => {
    // rows on all three scopes in use today…
    await addRow('tenant', TENANT)
    await addRow('space', spaceId)
    // …and one whose tuple is ALREADY absent: the orphan this ticket is named for. A sweep that derived
    // its delete set from the tuples (the obvious way to write it) would step straight over this row.
    await addRow('page', pageId)
    // a machine-owned row: ADR-183 §1 keeps those where the machine is, but the machine will never
    // revisit a principal that no longer exists, so it goes with the rest.
    await addRow('space', `${spaceId}-mapped`, USER, TENANT, 'mapping')
    // …and a row for the SAME sub in another tenant, which must survive: the sweep runs on one tenant's
    // connection and has no business reaching across.
    await admin`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${`${roleId}-o`}, ${OTHER}, ${`${roleId}-o`}, ARRAY['view']::text[], 'resource') ON CONFLICT (id) DO NOTHING`
    await admin`INSERT INTO role_assignments (id, tenant_id, role_id, resource_type, resource_id, principal, origin)
                VALUES (${`o-${STAMP}`}, ${OTHER}, ${`${roleId}-o`}, 'tenant', ${OTHER}, ${USER}, 'manual') ON CONFLICT DO NOTHING`

    const before = await rowsFor(USER)
    // the pin is only worth anything if the rows really are on several scopes
    expect(new Set(before).size, `the fixture must span scopes :: ${JSON.stringify(before)}`).toBeGreaterThanOrEqual(3)

    // one real grant so the tuple half of the sweep has something to do as well
    await writeTuples(fgaClient, [{ user: USER, relation: 'viewer', object: `space:${spaceId}` }]).catch(() => {})

    await sweepMemberDirectGrants(db, fgaClient, app.searchDriver, { tenantId: TENANT, sub: SUB })

    expect(await rowsFor(USER), 'rows survived the member they were made for').toEqual([])
    expect(await rowsFor(USER, OTHER), "the other tenant's row was taken too").toEqual(['tenant'])
    // and the tuple side is clear, which is the half that already worked — both must hold, or the ledger
    // and the world are apart again in the other direction
    const stillGranted = (await fgaClient.check({ user: USER, relation: 'viewer', object: `space:${spaceId}` })).allowed
    expect(stillGranted, 'a tuple survived').not.toBe(true)

    await admin`DELETE FROM role_assignments WHERE principal = ${USER}`.catch(() => {})
    await admin`DELETE FROM roles WHERE id = ${`${roleId}-o`}`.catch(() => {})
    await deleteTuples(fgaClient, [{ user: USER, relation: 'viewer', object: `space:${spaceId}` }]).catch(() => {})
  }, 180_000)
})
