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
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, deleteTuples } from '@wikistead/authz'
import { buildApp } from '../app.js'
import {
  createSpace, deleteSpace, grantSpaceAccess, revokeSpaceAccess, listAllSpaceAccess, listTenantGroups, listMemberCandidates,
  spaceCallMovesAdminClass,
} from '../routes/spaces.js'
import { assignRoleInTx } from '../routes/roles.js'
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
  // The verb reaches its holder through a CUSTOM ROLE now (user ruling 2026-08-05): the built-in door
  // stopped naming it, on an edition boundary. The route behaviour under test is unchanged — the ceiling
  // reads the caller's relations, not how they came to hold them — and setting it up this way keeps that
  // honest: if the two paths ever wrote different tuples, every case below would notice.
  const roleId = randomUUID()
  await db.sql`INSERT INTO roles (id, tenant_id, name, capabilities, scope)
               VALUES (${roleId}, ${T}, ${`am607-verb-${STAMP}`}, ARRAY['manageAccess']::text[], 'resource')`
  await assignRoleInTx(db, fgaClient, app.searchDriver, {
    tenant: { id: T, plan: 'business' }, roleId, capabilities: ['manageAccess'],
    resourceType: 'space', resourceId: spaceId, principal: `user:${AM}`, actorSub: OWNER,
  })
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
    const roster = await listAllSpaceAccess(fgaClient, db, { spaceId, tenantId: T, userId: AM })
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
  // `manageAccess` left this list on 2026-08-05, so the built-in door refuses it to EVERYONE (400 from
  // the vocabulary) rather than to the weak (403 from the ceiling). Both are pinned, and the codes are
  // kept apart on purpose: collapsing them to "it throws" would let the ceiling quietly disappear behind
  // a vocabulary error, which is the shape of failure this whole describe block exists to catch.
  it.each(['manage', 'moderate'] as const)('built-in door: granting %s is refused by the ceiling', async (cap) => {
    await expect403(
      grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: AM, grantee: `user:${TARGET}`, capability: cap, plan: 'free' }),
      `the roster verb cannot hand out ${cap}`,
    )
    expect(await check(fgaClient, `user:${TARGET}`, cap, { type: 'space', id: spaceId }), 'nothing was written').toBe(false)
  }, 60_000)

  it('built-in door: the verb itself is not in that vocabulary at all — refused to an OWNER too', async () => {
    for (const caller of [AM, OWNER]) {
      await expect(
        grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: caller, grantee: `user:${TARGET}`, capability: 'manageAccess', plan: 'free' }),
        'a paid composition is not handed out by the free door, however strong the caller',
      ).rejects.toMatchObject({ statusCode: 400 })
    }
    expect(await check(fgaClient, `user:${TARGET}`, 'manageAccess', { type: 'space', id: spaceId }), 'nothing was written').toBe(false)
  }, 60_000)

  it('roles door: the verb is still refused to the holder of it — the ceiling covers its own delegation', async () => {
    const { requireAssignmentAuthority } = await import('./../routes/roles.js')
    await expect403(
      requireAssignmentAuthority(app.fga, { sub: AM, tenantId: T, resourceType: 'space', resourceId: spaceId, capabilities: ['manageAccess'] }),
      'appointing another holder of the roster verb needs manage — the delegation chain stays recorded',
    )
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

// (d) — #607 user ruling, which narrowed this. `replace` used to refuse unconditionally, which was
// safe but meant the roster verb could add and remove and never CHANGE: turning a viewer into an editor
// took a revoke and a re-grant. It now refuses when the sweep would carry an admin-class mark away —
// still an OPERATION test (that is what separates it from ADR-209 rev1, which stopped looking at the
// sweep entirely), asked of what the target actually holds.
//
// All three directions, because either one alone can pass a broken implementation: a server that always
// refuses satisfies the first, one that always permits satisfies the second, and one that reads
// `role_assignments` instead of the store satisfies BOTH while handing the owner's demotion away.
describe('#607 (d): replace is refused when it would sweep an admin-class mark', () => {
  it('a target holding something admin-class cannot be replaced', async () => {
    // TARGET is a moderator here — `moderate` is in ADMIN_CLASS_ROLE_CAPS, so the picture the ruling
    // describes is "manager AND moderator rows stay badges" (review②), not manager alone.
    const tuples = spaceGrantTuplesFor(`user:${TARGET}`, 'moderate', spaceId)
    await fgaClient.write({ writes: tuples })
    try {
      await expect403(
        grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: AM, grantee: `user:${TARGET}`, capability: 'view', plan: 'free', replace: true }),
        'replacing a moderator sweeps their moderate mark',
      )
      const { requireAssignmentAuthority } = await import('./../routes/roles.js')
      await expect403(
        requireAssignmentAuthority(app.fga, { sub: AM, tenantId: T, resourceType: 'space', resourceId: spaceId, capabilities: ['view'], replace: true, principal: `user:${TARGET}` }),
        'same rule at the roles door',
      )
    } finally {
      await deleteTuples(fgaClient, tuples).catch(() => {})
    }
  }, 120_000)

  it('a target holding nothing admin-class CAN be replaced — the point of the ruling', async () => {
    const tuples = spaceGrantTuplesFor(`user:${TARGET}`, 'view', spaceId)
    await fgaClient.write({ writes: tuples })
    try {
      await expect(
        grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: AM, grantee: `user:${TARGET}`, capability: 'edit', plan: 'free', replace: true }),
        'a viewer becomes an editor in one move',
      ).resolves.not.toThrow()
      expect(await check(fgaClient, `user:${TARGET}`, 'edit', { type: 'space', id: spaceId }), 'and the change landed').toBe(true)
    } finally {
      await deleteTuples(fgaClient, [...tuples, ...spaceGrantTuplesFor(`user:${TARGET}`, 'edit', spaceId)]).catch(() => {})
    }
  }, 120_000)

  it('an UNANSWERED question refuses — the default is not an empty set', () => {
    // The predicate takes what the target holds as an argument, so there is a caller who does not supply
    // it. That caller must get a refusal, not a pass: `?? []` would read as "holds nothing admin-class"
    // and open the ceiling wherever the read was skipped or failed. Measured as a unit because no route
    // reaches it today — which is exactly why it needs saying here rather than being left to whichever
    // call site is added next.
    expect(spaceCallMovesAdminClass([], true), 'replace with no answer about the target').toBe(true)
    expect(spaceCallMovesAdminClass([], true, []), 'and an answer of "nothing" is a different thing').toBe(false)
    expect(spaceCallMovesAdminClass(['manage'], false, []), 'naming an admin-class capability still refuses').toBe(true)
  })

  it('the ROWLESS owner cannot be replaced — the answer comes from the store, not from rows', async () => {
    // The case review① insisted on. `createSpace` writes the creator's `manager` leaf directly and
    // records NO `role_assignments` row, so a rows-based "does this principal hold admin-class" returns
    // "no" for the one principal who must never be demoted by this verb. Measured first with the rows
    // implementation: it answered 204 and the owner lost the space.
    const rows = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM role_assignments
      WHERE resource_type = 'space' AND resource_id = ${spaceId} AND principal = ${`user:${OWNER}`}`
    expect(rows[0]!.n, 'the premise: the owner really has no row (else this case proves nothing)').toBe(0)
    expect(await check(fgaClient, `user:${OWNER}`, 'manage', { type: 'space', id: spaceId }), 'but does hold the leaf').toBe(true)
    await expect403(
      grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: AM, grantee: `user:${OWNER}`, capability: 'view', plan: 'free', replace: true }),
      'the owner is not a "principal holding nothing admin-class"',
    )
  }, 120_000)
})

describe('#607: a plain member is refused everything', () => {
  it('no site opens to a principal with no verb', async () => {
    await expect403(grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: PLAIN, grantee: `user:${TARGET}`, capability: 'view', plan: 'free' }), 'grant')
    await expect403(listAllSpaceAccess(fgaClient, db, { spaceId, tenantId: T, userId: PLAIN }), 'roster')
    await expect403(listTenantGroups(db, fgaClient, { spaceId, userId: PLAIN }), 'groups')
    await expect403(listMemberCandidates(db, fgaClient, { spaceId, userId: PLAIN, q: 'x' }), 'members')
  }, 60_000)
})
