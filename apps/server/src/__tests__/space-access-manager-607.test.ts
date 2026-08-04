// Integration — real Postgres + real OpenFGA. #607 / ADR-209: the ROUTE-level proof, separate from the
// model axis, because the model cannot see a gate that was never moved: a space-verb truth row stays
// green with every site still on `manage`. A principal holding ONLY `manageAccess`:
//   (a) passes the moved roster sites;
//   (b) is refused the sites that stay on `manage` (rename, space delete);
//   (c) is refused granting an admin-class capability — at the BUILT-IN door for manage AND moderate
//       AND manageAccess itself (blocking only `manage` is the leak the ADR names), and at the ROLES
//       door through a custom role bundling one;
//   (d) is refused ANY call with `replace: true` — the ceiling reads the OPERATION, not the requested
//       capability (a `view` grant with replace demotes the owner).
// And a plain member is refused everything.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, deleteTuples } from '@wikistead/authz'
import { buildApp } from '../app.js'
import {
  createSpace, deleteSpace, grantSpaceAccess, revokeSpaceAccess, listSpaceAccess, listTenantGroups, listMemberCandidates,
} from '../routes/spaces.js'
import { spaceGrantTuplesFor } from '../space-grant-expansion.js'
import type { FastifyInstance } from 'fastify'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const OWNER = 'dev-user'
const STAMP = Date.now().toString(36)
const AM = `am607-holder-${STAMP}` // holds ONLY manageAccess
const PLAIN = `am607-plain-${STAMP}` // a member with nothing
const TARGET = `am607-target-${STAMP}` // the grantee the holder operates on
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant

let app: FastifyInstance
let db: TenantDb
let spaceId: string
const cleanup: { user: string; relation: string; object: string }[] = []

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(T))
  spaceId = (await createSpace(db, fgaClient, { tenantId: T, userId: OWNER, plan: 'free', name: `am607-${STAMP}` })).id
  await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: OWNER, grantee: `user:${AM}`, capability: 'manageAccess', plan: 'free' })
  cleanup.push(...spaceGrantTuplesFor(`user:${AM}`, 'manageAccess', spaceId))
}, 120_000)

afterAll(async () => {
  await deleteTuples(fgaClient, cleanup).catch(() => {})
  await admin`DELETE FROM role_assignments WHERE resource_type = 'space' AND resource_id = ${spaceId}`.catch(() => {})
  await admin`DELETE FROM roles WHERE name LIKE ${'am607-%'}`.catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: T, spaceId, userId: OWNER }).catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
  await pool.end()
}, 60_000)

const expect403 = async (p: Promise<unknown>, label: string) => {
  await expect(p, label).rejects.toMatchObject({ statusCode: 403 })
}

describe('#607 (a): the moved roster sites answer to the verb', () => {
  it('grants view/edit, reads the roster, completes from the pickers, revokes what it granted', async () => {
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: AM, grantee: `user:${TARGET}`, capability: 'view', plan: 'free' })
    expect(await check(fgaClient, `user:${TARGET}`, 'view', { type: 'space', id: spaceId }), 'the grant landed').toBe(true)
    const roster = await listSpaceAccess(fgaClient, db, { spaceId, tenantId: T, userId: AM })
    expect(roster.some((r) => r.grantee === `user:${TARGET}` && r.capability === 'view'), 'the roster is readable').toBe(true)
    // the OWNER's manager row is visible but marked non-revocable for THIS caller (the UI signal)
    const ownerRow = roster.find((r) => r.grantee === `user:${OWNER}` && r.capability === 'manage')
    expect(ownerRow?.revocable, 'the manager row says this caller cannot take it').toBe(false)
    expect(roster.find((r) => r.grantee === `user:${TARGET}`)?.revocable, 'the view row says it can').toBe(true)
    await expect(listTenantGroups(db, fgaClient, { spaceId, userId: AM }), 'group completion opens').resolves.toBeDefined()
    await expect(listMemberCandidates(db, fgaClient, { spaceId, userId: AM, q: 'am607' }), 'member search opens').resolves.toBeDefined()
    await revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: AM, grantee: `user:${TARGET}`, capability: 'view', plan: 'free' })
    expect(await check(fgaClient, `user:${TARGET}`, 'view', { type: 'space', id: spaceId }), 'and revoked it').toBe(false)
  }, 120_000)
})

describe('#607 (b): the fifteen sites that stay on manage still refuse', () => {
  it('rename and space delete answer 403 to the verb', async () => {
    const { updateSpace } = await import('../routes/spaces.js')
    await expect403(updateSpace(db, fgaClient, { spaceId, userId: AM, name: 'nope', driver: app.searchDriver }), 'rename stays manage')
    await expect403(deleteSpace(db, fgaClient, app.searchDriver, { tenantId: T, spaceId, userId: AM }), 'space delete stays manage')
  }, 60_000)
})

describe('#607 (c): the ceiling — admin-class capabilities need manage, at both doors', () => {
  it.each(['manage', 'moderate', 'manageAccess'] as const)('built-in door: granting %s is refused', async (cap) => {
    await expect403(
      grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: AM, grantee: `user:${TARGET}`, capability: cap, plan: 'free' }),
      `an access-manager cannot hand out ${cap}`,
    )
    expect(await check(fgaClient, `user:${TARGET}`, cap === 'manage' ? 'manage' : cap === 'moderate' ? 'moderate' : 'manageAccess', { type: 'space', id: spaceId }), 'nothing was written').toBe(false)
  }, 60_000)

  it('roles door: assigning a role that bundles an admin-class capability is refused', async () => {
    const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
    const mk = await app.inject({ method: 'POST', url: '/admin/roles', headers: H, payload: { name: `am607-share-${STAMP}`, capabilities: ['share'], scope: 'resource' } })
    expect(mk.statusCode).toBe(201)
    const roleId = mk.json().id as string
    const { requireAssignmentAuthority } = await import('./../routes/roles.js')
    await expect403(
      requireAssignmentAuthority(app.fga, { sub: AM, tenantId: T, resourceType: 'space', resourceId: spaceId, capabilities: ['share'] }),
      'a share-bundling role needs manage',
    )
    // …while a roster role (view only) passes the same gate for the same caller
    await expect(
      requireAssignmentAuthority(app.fga, { sub: AM, tenantId: T, resourceType: 'space', resourceId: spaceId, capabilities: ['view'] }),
      'a view-only role is the verb’s job',
    ).resolves.toBeUndefined()
    await app.inject({ method: 'DELETE', url: `/admin/roles/${roleId}`, headers: H })
  }, 60_000)
})

describe('#607 (d): replace is a demotion in disguise — refused at both doors', () => {
  it('a view grant with replace: true is refused (the one-boolean hole)', async () => {
    await expect403(
      grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: AM, grantee: `user:${TARGET}`, capability: 'view', plan: 'free', replace: true }),
      'replace moves whatever the principal held, including the owner mark',
    )
    const { requireAssignmentAuthority } = await import('./../routes/roles.js')
    await expect403(
      requireAssignmentAuthority(app.fga, { sub: AM, tenantId: T, resourceType: 'space', resourceId: spaceId, capabilities: ['view'], replace: true }),
      'same rule at the roles door',
    )
  }, 60_000)
})

describe('#607: a plain member is refused everything', () => {
  it('no site opens to a principal with no verb', async () => {
    await expect403(grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: PLAIN, grantee: `user:${TARGET}`, capability: 'view', plan: 'free' }), 'grant')
    await expect403(listSpaceAccess(fgaClient, db, { spaceId, tenantId: T, userId: PLAIN }), 'roster')
    await expect403(listTenantGroups(db, fgaClient, { spaceId, userId: PLAIN }), 'groups')
    await expect403(listMemberCandidates(db, fgaClient, { spaceId, userId: PLAIN, q: 'x' }), 'members')
  }, 60_000)
})
