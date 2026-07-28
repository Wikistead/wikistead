// #536 / ADR-188 §6 item 1: routing built-in grants through the role mechanism is not a tidying exercise.
// It fixes a real loss of access.
//
// A built-in grant used to write FGA tuples with no row behind it, while a custom-role assignment wrote a
// row and counted references on it. The two were therefore invisible to each other. Give Bob a `view`
// grant AND a role that bundles `view`, take ONE of them away, and the shared `viewer` leaf goes with it:
//
//   - revoke the grant  -> the unified table deleted `viewer` outright; the role assignment was still
//                          there, still listed, still saying Bob may view. He could not.
//   - unassign the role -> the refcount consulted OTHER ASSIGNMENTS only, and the grant was not one, so
//                          the leaf it "owned" was deleted even though a live grant also conferred it.
//
// Both directions are pinned. This is the invariant the whole reference count exists for, and it simply
// did not apply to half the ways access is given.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check } from '@wikistead/authz'
import { createSpace, deleteSpace, grantSpaceAccess, revokeSpaceAccess } from '../routes/spaces.js'
import { createPage, deletePage, publishPage } from '../routes/pages.js'
import { assignRoleInTx, unassignRoleInTx } from '../routes/roles.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'
const tenant = { id: TENANT, plan: 'business' }

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let pageId = ''
let roleId = ''
const subs: string[] = []

const sub = (n: string) => { const s = `refc-${n}-${STAMP}`; subs.push(s); return `user:${s}` }

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `refc-${STAMP}` })).id
  pageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `refc-${STAMP}` })).id
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  roleId = `refc-role-${STAMP}`
  await adminPool`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${roleId}, ${TENANT}, ${`refc-${STAMP}`}, ARRAY['view']::text[], 'resource')`
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
const revoke = (principal: string, capability: string) =>
  revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: principal, capability, plan: 'business' })
const assign = (principal: string) =>
  assignRoleInTx(db, fgaClient, app.searchDriver, {
    tenant, roleId, capabilities: ['view'], resourceType: 'space', resourceId: spaceId, principal, actorSub: OWNER,
  })
const canView = (principal: string) => check(fgaClient, principal, 'view', { type: 'page', id: pageId })

describe('#536: a built-in grant and a role assignment stop deleting each other', () => {
  it('revoking the GRANT leaves the role assignment working', async () => {
    const p = sub('grant-first')
    await grant(p, 'view')
    await assign(p)
    expect(await canView(p), 'both in force').toBe(true)

    await revoke(p, 'view')

    // The assignment is still there and still says he may view. Before this, the revoke deleted the
    // shared leaf and the row became a promise the system did not keep.
    const rows = await adminPool`SELECT id FROM role_assignments WHERE role_id = ${roleId} AND principal = ${p}`
    expect(rows.length, 'the assignment survives').toBe(1)
    expect(await canView(p), 'and still confers view').toBe(true)
  }, 120_000)

  it('unassigning the ROLE leaves the grant working', async () => {
    const p = sub('role-first')
    await assign(p)
    await grant(p, 'view')
    expect(await canView(p), 'both in force').toBe(true)

    const [row] = await adminPool<{ id: string }[]>`SELECT id FROM role_assignments WHERE role_id = ${roleId} AND principal = ${p}`
    await unassignRoleInTx(db, fgaClient, app.searchDriver, { tenant, assignmentId: row.id, actorSub: OWNER })

    expect(await canView(p), 'the grant still confers view').toBe(true)
  }, 120_000)

  it('and when the LAST holder goes, the leaf really does go', async () => {
    // The counterpart. A refcount that never reaches zero is not a fix, it is a leak — access that
    // outlives every reason for it, which on this surface means someone reading what they were removed
    // from. Both removals, in either order, must end at no access.
    const p = sub('last-one-out')
    await grant(p, 'view')
    await assign(p)
    const [row] = await adminPool<{ id: string }[]>`SELECT id FROM role_assignments WHERE role_id = ${roleId} AND principal = ${p}`
    await unassignRoleInTx(db, fgaClient, app.searchDriver, { tenant, assignmentId: row.id, actorSub: OWNER })
    await revoke(p, 'view')
    expect(await canView(p), 'nothing left').toBe(false)
  }, 120_000)

  it('a grant writes a row, and revoking it takes the row away', async () => {
    // The mechanism itself: without the row there is nothing for a reference count to count.
    const p = sub('has-a-row')
    await grant(p, 'edit')
    const after = await adminPool<{ builtin_capability: string; role_id: string | null }[]>`
      SELECT builtin_capability, role_id FROM role_assignments WHERE resource_id = ${spaceId} AND principal = ${p}`
    expect(after).toEqual([{ builtin_capability: 'edit', role_id: null }])

    await revoke(p, 'edit')
    const gone = await adminPool`SELECT id FROM role_assignments WHERE resource_id = ${spaceId} AND principal = ${p}`
    expect(gone.length, 'the row goes with the grant').toBe(0)
    expect(await check(fgaClient, p, 'edit', { type: 'page', id: pageId }), 'and so does the access').toBe(false)
  }, 120_000)

  it('granting twice is not an error and does not double the row', async () => {
    // The old path just wrote the tuple again. The role path 409s on a duplicate assignment, and adopting
    // it wholesale would have turned a harmless click into a failure the UI has no state to explain.
    const p = sub('twice')
    await grant(p, 'view')
    await grant(p, 'view')
    const rows = await adminPool`SELECT id FROM role_assignments WHERE resource_id = ${spaceId} AND principal = ${p}`
    expect(rows.length).toBe(1)
    expect(await canView(p)).toBe(true)
  }, 120_000)

  it('the manager superset is still a single leaf, not its enumerated bundle', async () => {
    // The design-review BLOCK, re-pinned at the new call site: `manage` is not in ROLE_CAPABILITIES, and
    // expansionTuples refuses it as a second layer of defence. Routing built-in grants through that same
    // function means `manage` now arrives there legitimately — so this checks the superset still resolves
    // rather than 400ing, and still reaches space manage and moderate, which no enumeration lists.
    const p = sub('boss')
    await grant(p, 'manage')
    expect(await check(fgaClient, p, 'manage', { type: 'space', id: spaceId }), 'space manage').toBe(true)
    expect(await check(fgaClient, p, 'moderate', { type: 'space', id: spaceId }), 'moderate, which the bundle never lists').toBe(true)
    expect(await check(fgaClient, p, 'manage', { type: 'page', id: pageId }), 'page manage_from_space').toBe(true)

    await revoke(p, 'manage')
    expect(await check(fgaClient, p, 'manage', { type: 'space', id: spaceId }), 'and it comes back off').toBe(false)
  }, 120_000)
})
