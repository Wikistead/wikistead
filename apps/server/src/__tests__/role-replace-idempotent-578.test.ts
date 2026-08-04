// Integration — real Postgres + real OpenFGA. #578 (review rejection 2026-08-05): changing a principal's
// role answered 400 and left them holding BOTH — `1 principal = 1 role` broken in the data, not just on
// screen. And it was not idempotent: every retry answered 400 forever.
//
// The reported FGA text names the cause: "cannot delete a tuple which does not exist". The revoke half
// of the replacement builds its delete set from the assignment's OWNED capabilities and their full
// expansions, without checking which of those tuples are actually there. A grant holding only half of
// an expansion pair — a legacy row, a seeded fixture, or the debris of an earlier partial write — makes
// the delete fail, which rolls back the row deletion while the new role's tuples, written by a SEPARATE
// FGA call moments earlier, stay. `sweepOtherSpaceRoles` guards against exactly this for its rowless
// pass ("deleting a tuple that is not there is an FGA error that would fail the whole add after the row
// landed") — the row pass did not.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, deleteTuples } from '@wikistead/authz'
import { buildApp } from '../app.js'
import { createSpace, deleteSpace, grantSpaceAccess, listSpaceAccess } from '../routes/spaces.js'
import { assignRoleInTx } from '../routes/roles.js'
import type { FastifyInstance } from 'fastify'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const OWNER = 'dev-user'
const STAMP = Date.now().toString(36)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant

let app: FastifyInstance
let db: TenantDb
let spaceId: string
let roleId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(T))
  spaceId = (await createSpace(db, fgaClient, { tenantId: T, userId: OWNER, plan: 'business', name: `rr578-${STAMP}` })).id
  roleId = `rr578-role-${STAMP}`
  await admin`SELECT set_config('app.tenant_id', ${T}, false)`
  await admin`INSERT INTO roles (id, tenant_id, name, capabilities, scope)
              VALUES (${roleId}, ${T}, ${`rr578-${STAMP}`}, ARRAY['view','edit'], 'resource')`
}, 120_000)

afterAll(async () => {
  await admin`DELETE FROM role_assignments WHERE resource_type = 'space' AND resource_id = ${spaceId}`.catch(() => {})
  await admin`DELETE FROM roles WHERE id = ${roleId}`.catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: T, spaceId, userId: OWNER }).catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
  await pool.end()
}, 60_000)

/** What the principal really holds: the roster rows AND the assignment rows, read separately. */
async function realState(principal: string) {
  const roster = await listSpaceAccess(fgaClient, db, { spaceId, tenantId: T, userId: OWNER })
  const rows = await db.sql<{ id: string }[]>`
    SELECT id FROM role_assignments WHERE resource_type = 'space' AND resource_id = ${spaceId} AND principal = ${principal}`
  return { rosterCaps: roster.filter((g) => g.grantee === principal).map((g) => g.capability).sort(), rows: rows.length }
}

describe('#578: replacing a role is idempotent and never half-applies', () => {
  it('a grant holding half an expansion pair can still be replaced', async () => {
    const principal = `user:rr578-half-${STAMP}`
    await assignRoleInTx(db, fgaClient, app.searchDriver, {
      tenant: { id: T, plan: 'business' }, roleId, capabilities: ['view', 'edit'] as never[],
      resourceType: 'space', resourceId: spaceId, principal, actorSub: OWNER,
    })
    // the state a legacy row, a seeded fixture, or an earlier partial write leaves behind: a `view`
    // grant writes viewer + viewer_member, and only one of them is here
    await deleteTuples(fgaClient, [{ user: principal, relation: 'viewer_member', object: `space:${spaceId}` }])

    // the replacement the review performed: custom role → a built-in
    await expect(
      grantSpaceAccess(db, fgaClient, app.searchDriver, {
        spaceId, tenantId: T, userId: OWNER, grantee: principal, capability: 'edit', plan: 'business', replace: true,
      }),
      'replacing must not fail on a tuple that was already gone',
    ).resolves.toBeUndefined()

    const after = await realState(principal)
    expect(after.rows, 'exactly one assignment row survives').toBe(1)
    expect(after.rosterCaps, 'and the roster shows exactly the new role').toEqual(['edit'])
    expect(await check(fgaClient, principal, 'edit', { type: 'space', id: spaceId }), 'the new role works').toBe(true)
  }, 120_000)

  it('the same replacement runs twice with the same answer', async () => {
    const principal = `user:rr578-twice-${STAMP}`
    await grantSpaceAccess(db, fgaClient, app.searchDriver, {
      spaceId, tenantId: T, userId: OWNER, grantee: principal, capability: 'view', plan: 'business',
    })
    for (const round of [1, 2]) {
      await expect(
        grantSpaceAccess(db, fgaClient, app.searchDriver, {
          spaceId, tenantId: T, userId: OWNER, grantee: principal, capability: 'edit', plan: 'business', replace: true,
        }),
        `round ${round}: a repeated replacement must not answer an error`,
      ).resolves.toBeUndefined()
    }
    const after = await realState(principal)
    expect(after.rows).toBe(1)
    expect(after.rosterCaps).toEqual(['edit'])
  }, 120_000)
})
