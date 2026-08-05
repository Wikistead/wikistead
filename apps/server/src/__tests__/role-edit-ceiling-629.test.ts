// Integration — real Postgres + real OpenFGA. #629: editing a role's capabilities re-expands every live
// assignment, and that door had no ceiling.
//
// The grant door asks, per capability, whether the caller may hand THIS OUT HERE
// (`requireAssignmentAuthority`: an admin-class capability needs `manage` on the target). The EDIT door
// asked only for tenant-wide `manage_roles` — so a principal who is neither a tenant admin nor a manager
// of the space could add `delete` / `share` / `settings` / `manageAccess` to a role that was already
// assigned, and the re-expansion wrote those tuples for every assignee. Measured on the device: four
// admin-class relations written to the attacker's own principal, and a roster that answered 403 a moment
// earlier started answering 200.
//
// The two attacks are pinned separately because they fail for different reasons if the fix is partial:
// (1) escalating SOMEBODY ELSE (the role is assigned to a third party), and (2) escalating YOURSELF.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, isRoleManager, isTenantAdmin, writeTuples, deleteTuples } from '@wikistead/authz'
import { buildApp } from '../app.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { assignRoleInTx } from '../routes/roles.js'
import type { FastifyInstance } from 'fastify'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const OWNER = 'dev-user' // tenant admin + space manager
const STAMP = Date.now().toString(36)
const ATTACKER = `esc629-rolemgr-${STAMP}` // holds ONLY manage_roles (tenant scope)
const VICTIM = `esc629-victim-${STAMP}` // a third party the role is also assigned to
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant

let app: FastifyInstance
let db: TenantDb
let spaceId: string
let roleId: string
const cleanup: { user: string; relation: string; object: string }[] = []

// The attacker speaks through a REAL member session: `dev-token` is always the tenant admin, and a
// ceiling measured while wearing the admin's identity measures nothing.
let attackerCookie = ''
const ROLE_NAME = `esc629-role-${STAMP}` // the PUT carries the whole definition; the name never changes here
const asAttacker = (capabilities: string[]) => app.inject({
  method: 'PUT', url: `/admin/roles/${roleId}`,
  headers: { host: 'dev.localhost', cookie: attackerCookie, 'content-type': 'application/json' },
  payload: { name: ROLE_NAME, capabilities },
})
const asOwner = (capabilities: string[]) => app.inject({
  method: 'PUT', url: `/admin/roles/${roleId}`,
  headers: { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' },
  payload: { name: ROLE_NAME, capabilities },
})

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(T))
  spaceId = (await createSpace(db, fgaClient, { tenantId: T, userId: OWNER, plan: 'business', name: `esc629-${STAMP}` })).id

  // member rows: a session for a sub the tenant does not know is unauthorized, and #624 requires a
  // grantee to be a member
  for (const sub of [ATTACKER, VICTIM]) {
    await admin`INSERT INTO members (tenant_id, sub, email, role)
                VALUES (${T}, ${sub}, ${`${sub}@fixture.test`}, 'member')
                ON CONFLICT (tenant_id, sub) DO NOTHING`
  }
  attackerCookie = `${SESSION_COOKIE}=${await createSession(app.valkey, { tenantId: T, sub: ATTACKER })}`

  // the attacker's power: tenant-wide role management, and nothing on the space
  await writeTuples(fgaClient, [
    { user: `user:${ATTACKER}`, relation: 'member', object: `tenant:${T}` },
    { user: `user:${ATTACKER}`, relation: 'manage_roles', object: `tenant:${T}` },
    { user: `user:${VICTIM}`, relation: 'member', object: `tenant:${T}` },
  ])
  cleanup.push(
    { user: `user:${ATTACKER}`, relation: 'member', object: `tenant:${T}` },
    { user: `user:${ATTACKER}`, relation: 'manage_roles', object: `tenant:${T}` },
    { user: `user:${VICTIM}`, relation: 'member', object: `tenant:${T}` },
  )

  // the ordinary state the attack rides on: a manager handed out a harmless role, to the attacker AND
  // to somebody else. Nothing here is unusual — this is what "viewer, via a custom role" looks like.
  roleId = randomUUID()
  await db.sql`INSERT INTO roles (id, tenant_id, name, capabilities, scope)
               VALUES (${roleId}, ${T}, ${ROLE_NAME}, ARRAY['view']::text[], 'resource')`
  for (const principal of [`user:${ATTACKER}`, `user:${VICTIM}`]) {
    await assignRoleInTx(db, fgaClient, app.searchDriver, {
      tenant: { id: T, plan: 'business' }, roleId, capabilities: ['view'],
      resourceType: 'space', resourceId: spaceId, principal, actorSub: OWNER,
    })
  }
}, 180_000)

afterAll(async () => {
  await deleteTuples(fgaClient, cleanup).catch(() => {})
  await admin`DELETE FROM role_assignments WHERE resource_type = 'space' AND resource_id = ${spaceId}`.catch(() => {})
  await admin`DELETE FROM roles WHERE name LIKE ${'esc629-%'}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${T} AND sub LIKE ${'esc629-%'}`.catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: T, spaceId, userId: OWNER }).catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
  await pool.end()
}, 60_000)

// CAPABILITY names (check maps them to relations) — naming a relation here is how a pin quietly stops
// asking anything, since an unknown capability throws rather than answering false
const holds = (sub: string, capability: string) => check(fgaClient, `user:${sub}`, capability as never, { type: 'space', id: spaceId })

describe('#629: editing a role cannot hand out what granting it could not', () => {
  it('the setup is honest: the attacker manages roles, and manages nothing on this space', async () => {
    expect(await isRoleManager(fgaClient, ATTACKER, T), 'holds the verb').toBe(true)
    expect(await isTenantAdmin(fgaClient, ATTACKER, T), 'is NOT a tenant admin').toBe(false)
    expect(await holds(ATTACKER, 'manage'), 'is NOT a manager of the space').toBe(false)
    expect(await holds(ATTACKER, 'view'), 'holds only what the harmless role gave').toBe(true)
  }, 60_000)

  it('attack 1 — escalating somebody else: adding `delete` to the assigned role is refused', async () => {
    const res = await asAttacker(['view', 'delete'])
    expect(res.statusCode, `the edit door must refuse: ${res.body}`).toBe(403)
    expect(await holds(VICTIM, 'delete'), 'and nothing was written for the third party').toBe(false)
  }, 60_000)

  it('attack 2 — escalating yourself: adding four admin-class capabilities is refused', async () => {
    const res = await asAttacker(['view', 'delete', 'manageAccess', 'share', 'settings'])
    expect(res.statusCode, `the edit door must refuse: ${res.body}`).toBe(403)
    for (const cap of ['delete', 'manageAccess', 'share', 'settings']) {
      expect(await holds(ATTACKER, cap), `${cap} was not written for the attacker`).toBe(false)
    }
  }, 60_000)

  it('no partial application: the role still holds exactly what it held', async () => {
    const [row] = await db.sql<{ capabilities: string[] }[]>`SELECT capabilities FROM roles WHERE id = ${roleId}`
    expect(row!.capabilities, 'the refused edit changed nothing').toEqual(['view'])
  }, 60_000)

  it('the edit door answers exactly what the GRANT door answers, both ways', async () => {
    // The refusal above is not "role managers cannot edit" — it is "you cannot hand this out here".
    // Proven by moving only the caller's authority on the space: with the roster verb (ADR-209's
    // two-question gate) an ordinary capability edits, and an admin-class one still does not. Without
    // this case the fix could be a wall rather than a ceiling and every assertion above would still pass.
    const rosterRole = randomUUID()
    await db.sql`INSERT INTO roles (id, tenant_id, name, capabilities, scope)
                 VALUES (${rosterRole}, ${T}, ${`esc629-roster-${STAMP}`}, ARRAY['manageAccess']::text[], 'resource')`
    await assignRoleInTx(db, fgaClient, app.searchDriver, {
      tenant: { id: T, plan: 'business' }, roleId: rosterRole, capabilities: ['manageAccess'],
      resourceType: 'space', resourceId: spaceId, principal: `user:${ATTACKER}`, actorSub: OWNER,
    })
    expect(await holds(ATTACKER, 'manageAccess'), 'the caller now runs the roster').toBe(true)

    const ordinary = await asAttacker(['view', 'comment'])
    expect(ordinary.statusCode, `an ordinary capability edits with the roster verb: ${ordinary.body}`).toBe(200)
    expect(await holds(VICTIM, 'comment'), 'and it really re-expanded').toBe(true)

    const adminClass = await asAttacker(['view', 'comment', 'share'])
    expect(adminClass.statusCode, 'an admin-class capability still needs manage').toBe(403)
    expect(await holds(ATTACKER, 'share'), 'nothing was written').toBe(false)

    // back to where this started
    expect((await asAttacker(['view'])).statusCode).toBe(200)
  }, 120_000)

  it('the manager keeps editing exactly as before (non-regression)', async () => {
    const res = await asOwner(['view', 'delete'])
    expect(res.statusCode, `the owner is a tenant admin and a manager: ${res.body}`).toBe(200)
    expect(await holds(VICTIM, 'delete'), 'the legitimate edit expanded').toBe(true)
    const undo = await asOwner(['view'])
    expect(undo.statusCode).toBe(200)
  }, 90_000)
})
