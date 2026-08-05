// Integration — real Postgres + real OpenFGA. #607 (review rejection).
//
// The defect: the roster showed a control that could not work. `dev-user` appears on it twice — once as
// `manage` (marked non-revocable, drawn as a badge) and once as `view` (revocable, so the row kept its
// role control). Choosing a different role there offered to demote the space's OWNER, read out the
// demotion confirmation, and then failed with a generic "something went wrong" — a 403 from the ceiling,
// working exactly as designed.
//
// The root is that `revocable` answers about a ROW and a role change is a REPLACE over everything the
// principal holds. So the payload answers both questions, and this file measures the property that
// matters rather than today's manager row:
//
//     for every row the roster returns, the operations the UI would offer ⊆ the operations the server
//     allows for that caller
//
// Written as a SWEEP over the roster with the offers derived from the payload's own signals — no verb is
// named, so the next admin-class capability is covered the day it exists. That shape is the point: the
// enumerated version of this check is what stayed green while the manager row was broken.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, deleteTuples, writeTuples } from '@wikistead/authz'
import { buildApp } from '../app.js'
import { createSpace, deleteSpace, grantSpaceAccess, revokeSpaceAccess, listSpaceAccess } from '../routes/spaces.js'
import { assignRoleInTx } from '../routes/roles.js'
import { spaceGrantTuplesFor } from '../space-grant-expansion.js'
import type { FastifyInstance } from 'fastify'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const OWNER = 'dev-user'
const STAMP = Date.now().toString(36)
const AM = `ros607-am-${STAMP}` // runs the roster and nothing else — the caller under test
const PLAIN = `ros607-plain-${STAMP}` // an ordinary viewer — the case where the two answers could differ
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant

let app: FastifyInstance
let db: TenantDb
let spaceId: string
let roleId: string
const cleanup: { user: string; relation: string; object: string }[] = []

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(T))
  spaceId = (await createSpace(db, fgaClient, { tenantId: T, userId: OWNER, plan: 'free', name: `ros607-${STAMP}` })).id
  roleId = randomUUID()
  await db.sql`INSERT INTO roles (id, tenant_id, name, capabilities, scope)
               VALUES (${roleId}, ${T}, ${`ros607-verb-${STAMP}`}, ARRAY['manageAccess']::text[], 'resource')`
  await assignRoleInTx(db, fgaClient, app.searchDriver, {
    tenant: { id: T, plan: 'business' }, roleId, capabilities: ['manageAccess'],
    resourceType: 'space', resourceId: spaceId, principal: `user:${AM}`, actorSub: OWNER,
  })
  cleanup.push(...spaceGrantTuplesFor(`user:${AM}`, 'manageAccess', spaceId))
  // The owner also holds a plain `view` row — the exact two-row shape that produced the defect (
  // measured it on `dev-user` in demo_space). Written as tuples rather than through the grant route,
  // because that route stops to confirm a manager replacement: the shape exists in the wild, and the
  // point here is what the ROSTER says about it, not how it came to be.
  const ownerView = spaceGrantTuplesFor(`user:${OWNER}`, 'view', spaceId)
  await writeTuples(fgaClient, ownerView)
  cleanup.push(...ownerView)
  await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: OWNER, grantee: `user:${PLAIN}`, capability: 'view', plan: 'free' })
  cleanup.push(...spaceGrantTuplesFor(`user:${PLAIN}`, 'view', spaceId))
}, 180_000)

afterAll(async () => {
  await deleteTuples(fgaClient, cleanup).catch(() => {})
  await db.sql`DELETE FROM role_assignments WHERE role_id = ${roleId}`.catch(() => {})
  await db.sql`DELETE FROM roles WHERE id = ${roleId}`.catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: T, spaceId, userId: OWNER }).catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
  await pool.end()
}, 120_000)

/** Does the server actually allow this caller to change what `grantee` is? Asked by DOING it (with a
 *  capability chosen so success would be a real change), then undoing any success. Reading the gate's
 *  source instead would pin the client against the same belief rather than against behaviour. */
async function serverAllowsRoleChange(caller: string, grantee: string): Promise<boolean> {
  try {
    await grantSpaceAccess(db, fgaClient, app.searchDriver, {
      spaceId, tenantId: T, userId: caller, grantee, capability: 'edit', plan: 'free', replace: true,
    })
    return true
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode === 403) return false
    throw e
  }
}

describe('#607the roster offers no operation the server would refuse', () => {
  it('every row: what the UI would offer is a subset of what this caller may do', async () => {
    const roster = await listSpaceAccess(fgaClient, db, { spaceId, tenantId: T, userId: AM })
    expect(roster.length, 'the sweep has rows to sweep').toBeGreaterThan(2)

    // The premise: at least one row must be REVOCABLE and belong to a principal who is NOT changeable.
    // That combination is the defect, and without it the subset check below passes on a roster where
    // every answer happens to agree — which is how the enumerated pin stayed green.
    expect(
      roster.some((r) => r.revocable !== false && r.changeable === false),
      'premise: a row that is individually revocable, on a principal whose role is frozen',
    ).toBe(true)

    for (const row of roster) {
      // the two signals the client renders from, asked of the server for real
      const allowed = await serverAllowsRoleChange(AM, row.grantee)
      expect(
        row.changeable === true,
        `${row.grantee} (${row.capability}): the payload offers a role change the server ${allowed ? 'allows' : 'REFUSES'}`,
      ).toBe(allowed)
      if (allowed) {
        // put it back — the sweep must not leave the roster it measured in a different shape
        await grantSpaceAccess(db, fgaClient, app.searchDriver, {
          spaceId, tenantId: T, userId: OWNER, grantee: row.grantee, capability: row.capability, plan: 'free', replace: true,
        })
      }
    }
  }, 240_000)

  it('the caller who CAN do everything is offered everything (not a wall for everyone)', async () => {
    // A signal that says "no" to every row would satisfy the subset property perfectly and make the
    // screen useless. The manager's view is the other half of the statement.
    const roster = await listSpaceAccess(fgaClient, db, { spaceId, tenantId: T, userId: OWNER })
    expect(roster.length).toBeGreaterThan(2)
    expect(roster.every((r) => r.changeable === true), 'a manager may change any principal here').toBe(true)
  }, 120_000)

  it('for the roster verb, NO principal is role-changeable — and that is the ceiling, stated', async () => {
    // Worth pinning precisely because it is stronger than it looks. ADR-209 §2 makes `replace: true`
    // require `manage` UNCONDITIONALLY — the rule reads the operation, not the target — because a `view`
    // grant with replace sweeps whatever the principal held, including the owner mark. A role CHANGE is
    // exactly that operation, so the roster verb cannot move anybody between roles; it adds and revokes.
    //
    // The screen is now honest about it (every row draws as a badge for this caller) rather than offering
    // a control that 403s. Whether the ceiling SHOULD narrow to "replace is refused only when the target
    // holds admin-class" is a change to an authorization invariant, so it is raised on the ticket rather
    // than made here.
    const roster = await listSpaceAccess(fgaClient, db, { spaceId, tenantId: T, userId: AM })
    expect(roster.length).toBeGreaterThan(2)
    expect(roster.every((r) => r.changeable === false), 'no role change, ordinary member included').toBe(true)

    // …while the ADD and REVOKE the verb exists for still work, so this is a narrowed screen, not a dead
    // one. Measured, because "everything is frozen" would otherwise be indistinguishable from a broken
    // signal that says no to everything.
    const fresh = `user:ros607-fresh-${STAMP}`
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: AM, grantee: fresh, capability: 'view', plan: 'free' })
    cleanup.push(...spaceGrantTuplesFor(fresh, 'view', spaceId))
    expect(await check(fgaClient, fresh, 'view', { type: 'space', id: spaceId }), 'the verb still adds people').toBe(true)
    await revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: AM, grantee: fresh, capability: 'view', plan: 'free' })
    expect(await check(fgaClient, fresh, 'view', { type: 'space', id: spaceId }), 'and still removes them').toBe(false)

    // the two answers genuinely differ on the owner's row — the defect's shape, still present in the data
    const owner = roster.find((r) => r.grantee === `user:${OWNER}` && r.capability === 'view')
    expect(owner, 'the owner has a plain view row — the shape that produced the defect').toBeTruthy()
    expect(owner?.revocable, 'that row IS individually revocable').not.toBe(false)
    expect(owner?.changeable, '…and their ROLE is not, because they hold the space').toBe(false)
  }, 180_000)
})
