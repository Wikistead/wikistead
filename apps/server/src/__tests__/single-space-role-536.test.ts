// #536item 2: ONE principal = ONE role on a space. A manual add REPLACES the principal's other
// manual roles (server-side convergence — the UI confirm is convenience, this is the fortress):
//   - grant → grant: the second capability replaces the first (row AND tuples).
//   - grant → role assignment (the HTTP route): the built-in row is swept; only the assignment remains.
//   - a machine-owned (mapping-origin) row refuses the manual add up front (409, nothing written) —
//     ADR-183 §1: the mapping owns the principal's role; replacing it manually would strand the mapping.
//   - legacy ROWLESS tuples (pre-086) converge in the same pass (the recorded migration policy:
//     duplicates are cleaned on the next add for that principal; untouched principals keep their rows).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, writeTuples, deleteTuples } from '@wikistead/authz'
import { createSpace, deleteSpace, grantSpaceAccess, revokeSpaceAccess } from '../routes/spaces.js'
import { createPage, deletePage, publishPage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let pageId = ''
let roleId = ''
const subs: string[] = []
const sub = (n: string) => { const s = `s1r-${n}-${STAMP}`; subs.push(s); return `user:${s}` }

const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `s1r-${STAMP}` })).id
  pageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `s1r-${STAMP}` })).id
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  roleId = `s1r-role-${STAMP}`
  await adminPool`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${roleId}, ${TENANT}, ${`s1r-${STAMP}`}, ARRAY['edit']::text[], 'resource')`
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
const rowsOf = (principal: string) => adminPool<{ role_id: string | null; builtin_capability: string | null; origin: string }[]>`
  SELECT role_id, builtin_capability, origin FROM role_assignments WHERE resource_type = 'space' AND resource_id = ${spaceId} AND principal = ${principal} ORDER BY builtin_capability`
const canView = (principal: string) => check(fgaClient, principal, 'view', { type: 'page', id: pageId })
const canEdit = (principal: string) => check(fgaClient, principal, 'edit', { type: 'page', id: pageId })

describe('#536one principal, one space role (replace semantics)', () => {
  it('grant → grant replaces: the second capability is the only one left (row AND access)', async () => {
    const p = sub('g-g')
    await grant(p, 'view')
    await grant(p, 'edit')
    const rows = await rowsOf(p)
    expect(rows).toEqual([{ role_id: null, builtin_capability: 'edit', origin: 'manual' }])
    expect(await canEdit(p), 'the new role is in force').toBe(true)
    // view is still true THROUGH edit (edit ⇒ view); the point is the old row is gone, pinned above.
  }, 120_000)

  it('grant → role ASSIGN (HTTP route) replaces: only the assignment remains; a direct API double-add converges to one', async () => {
    const p = sub('g-a')
    await grant(p, 'view')
    const res = await app.inject({
      method: 'POST', url: `/admin/roles/${roleId}/assignments`, headers: dev,
      payload: { resourceType: 'space', resourceId: spaceId, principal: p },
    })
    expect(res.statusCode).toBe(201)
    const rows = await rowsOf(p)
    expect(rows).toEqual([{ role_id: roleId, builtin_capability: null, origin: 'manual' }])
    expect(await canEdit(p), "the role's bundle is in force").toBe(true)
  }, 120_000)

  it('a mapping-owned row refuses the manual add up front (409, nothing swept)', async () => {
    const p = sub('machine')
    await adminPool`INSERT INTO role_assignments (id, tenant_id, role_id, builtin_capability, resource_type, resource_id, principal, owned_capabilities, origin)
      VALUES (${randomUUID()}, ${TENANT}, NULL, 'view', 'space', ${spaceId}, ${p}, ARRAY['view']::text[], 'mapping')`
    await writeTuples(fgaClient, [
      { user: p, relation: 'viewer', object: `space:${spaceId}` },
      { user: p, relation: 'viewer_member', object: `space:${spaceId}` },
    ])
    await expect(grant(p, 'edit')).rejects.toMatchObject({ statusCode: 409 })
    const rows = await rowsOf(p)
    expect(rows).toEqual([{ role_id: null, builtin_capability: 'view', origin: 'mapping' }]) // untouched
    expect(await canView(p), 'the mapping-conferred access is intact').toBe(true)
    await deleteTuples(fgaClient, [
      { user: p, relation: 'viewer', object: `space:${spaceId}` },
      { user: p, relation: 'viewer_member', object: `space:${spaceId}` },
    ]).catch(() => {})
  }, 120_000)

  it('legacy ROWLESS tuples converge in the same pass (the recorded pre-086 migration policy)', async () => {
    const p = sub('rowless')
    // a pre-086 grant: tuples, no row
    await writeTuples(fgaClient, [
      { user: p, relation: 'viewer', object: `space:${spaceId}` },
      { user: p, relation: 'viewer_member', object: `space:${spaceId}` },
    ])
    expect(await canView(p), 'the legacy grant works before the add').toBe(true)
    await grant(p, 'edit')
    const rows = await rowsOf(p)
    expect(rows).toEqual([{ role_id: null, builtin_capability: 'edit', origin: 'manual' }])
    // the stray viewer leaves are gone; view now flows only through edit
    const { tuples } = await fgaClient.read({ user: p, object: `space:${spaceId}` })
    const relations = (tuples ?? []).map((t) => t.key?.relation).sort()
    expect(relations).not.toContain('viewer')
    expect(await canEdit(p)).toBe(true)
  }, 120_000)
})

// #536SUPERSEDES the two pins that used to live here ("manage is exempt, so the manager and the
// weaker role coexist" / "a rowless manage survives an add"). Coexistence was the last stack a user
// could still see, and the ruling replaced silence with a question: adding a weaker role to a manager
// is REFUSED unless a person confirmed the demotion, and once confirmed it converges like any other
// replacement. Both of the old assertions are now WRONG answers — a silent no-op grant (a success that
// changed nothing) and a two-row principal — so they are rewritten rather than kept beside their
// contradiction. What must never happen is unchanged and pinned below: manage never disappears on its
// own.
describe('#536a manager is demoted only by someone who said so', () => {
  const holdsManager = async (p: string) => {
    const { tuples } = await fgaClient.read({ user: p, object: `space:${spaceId}` })
    return (tuples ?? []).some((t) => t.key?.relation === 'manager')
  }

  it('a weaker grant onto a ROW-TRACKED manager is refused (409) and changes NOTHING', async () => {
    const p = sub('mgr-row')
    await grant(p, 'manage')
    await expect(grant(p, 'view')).rejects.toMatchObject({ statusCode: 409, code: 'manager_replacement_requires_confirmation' })
    expect(await rowsOf(p), 'no demotion, and no half-applied new role').toEqual([{ role_id: null, builtin_capability: 'manage', origin: 'manual' }])
    expect(await holdsManager(p)).toBe(true)
  }, 120_000)

  it('a weaker grant onto a ROWLESS manager (the createSpace creator leaf) is refused too', async () => {
    // the production shape: the space creator holds a manager leaf and no row at all. A guard that only
    // read rows would wave this through and silently demote the owner of the space.
    const p = sub('mgr-rowless')
    await writeTuples(fgaClient, [{ user: p, relation: 'manager', object: `space:${spaceId}` }])
    await expect(grant(p, 'view')).rejects.toMatchObject({ statusCode: 409, code: 'manager_replacement_requires_confirmation' })
    expect(await rowsOf(p)).toEqual([])
    expect(await holdsManager(p), 'the creator still manages their own space').toBe(true)
    await deleteTuples(fgaClient, [{ user: p, relation: 'manager', object: `space:${spaceId}` }]).catch(() => {})
  }, 120_000)

  it('CONFIRMED, it converges: one row, the manager leaf gone, the new role in force', async () => {
    const p = sub('mgr-replace')
    await grant(p, 'manage')
    await grantSpaceAccess(db, fgaClient, app.searchDriver, {
      spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'view', plan: 'business', replace: true,
    })
    expect(await rowsOf(p), 'one principal, one row').toEqual([{ role_id: null, builtin_capability: 'view', origin: 'manual' }])
    expect(await holdsManager(p), 'the demotion reached FGA, not just the table').toBe(false)
    expect(await canView(p), 'and the role they were given actually works').toBe(true)
  }, 120_000)

  // #536 re-review 2, measured by the reviewer: the confirmed demotion of a ROWLESS manager — the
  // space's own creator, the ruling's production case — wrote nothing to the audit stream, while the
  // same demotion through a row audited normally. An authz change nobody can find in the log is one
  // nobody can review.
  it('a confirmed rowless demotion is AUDITED, like every demotion that goes through a row', async () => {
    const p = sub('mgr-audit')
    await writeTuples(fgaClient, [{ user: p, relation: 'manager', object: `space:${spaceId}` }])
    const revoked = async () => Number((await adminPool<{ n: string }[]>`
      SELECT (SELECT count(*) FROM audit_log    WHERE tenant_id = ${TENANT} AND action = 'space.access_revoked' AND target = ${`space:${spaceId}`})
           + (SELECT count(*) FROM audit_outbox WHERE tenant_id = ${TENANT} AND action = 'space.access_revoked' AND target = ${`space:${spaceId}`}) AS n`)[0]!.n)
    const before = await revoked()
    await grantSpaceAccess(db, fgaClient, app.searchDriver, {
      spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'view', plan: 'business', replace: true,
    })
    expect(await revoked() - before, 'the strongest change this path makes must leave a trace').toBeGreaterThan(0)
  }, 120_000)

  // and the sweep must delete the WHOLE grant, not the part that happens to be in the display table
  it('a swept rowless view takes viewer_member with it (or they can still see the space)', async () => {
    const p = sub('mgr-viewmember')
    // the legacy shape: both leaves of a view grant, no row
    await writeTuples(fgaClient, [
      { user: p, relation: 'viewer', object: `space:${spaceId}` },
      { user: p, relation: 'viewer_member', object: `space:${spaceId}` },
    ])
    await grant(p, 'edit') // the sweep converges them to edit
    await revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'edit', plan: 'business' })
    const { tuples } = await fgaClient.read({ user: p, object: `space:${spaceId}` })
    const rels = (tuples ?? []).map((t) => t.key?.relation)
    expect(rels, 'the member leaf is part of the same grant').not.toContain('viewer_member')
    expect(await check(fgaClient, p, 'view', { type: 'space', id: spaceId }), 'nothing left means nothing left').toBe(false)
  }, 120_000)

  it('CONFIRMED reaches the rowless creator leaf as well (the production case)', async () => {
    const p = sub('mgr-rowless-replace')
    await writeTuples(fgaClient, [{ user: p, relation: 'manager', object: `space:${spaceId}` }])
    await grantSpaceAccess(db, fgaClient, app.searchDriver, {
      spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'view', plan: 'business', replace: true,
    })
    expect(await rowsOf(p)).toEqual([{ role_id: null, builtin_capability: 'view', origin: 'manual' }])
    expect(await holdsManager(p), 'a confirmed demotion that left the leaf behind would be a lie').toBe(false)
  }, 120_000)

  it('granting `manage` ITSELF is not a demotion and needs no confirmation', async () => {
    const p = sub('mgr-promote')
    await grant(p, 'view')
    await grant(p, 'manage') // no replace flag, no refusal
    expect(await holdsManager(p)).toBe(true)
  }, 120_000)

  it('the custom-role door asks the same question (HTTP 409, then converges when confirmed)', async () => {
    const p = sub('mgr-http')
    await grant(p, 'manage')
    const refused = await app.inject({
      method: 'POST', url: `/admin/roles/${roleId}/assignments`, headers: dev,
      payload: { resourceType: 'space', resourceId: spaceId, principal: p },
    })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ code: 'manager_replacement_requires_confirmation' })
    expect(await rowsOf(p)).toEqual([{ role_id: null, builtin_capability: 'manage', origin: 'manual' }])

    const confirmed = await app.inject({
      method: 'POST', url: `/admin/roles/${roleId}/assignments`, headers: dev,
      payload: { resourceType: 'space', resourceId: spaceId, principal: p, replace: true },
    })
    expect(confirmed.statusCode).toBe(201)
    expect(await rowsOf(p)).toEqual([{ role_id: roleId, builtin_capability: null, origin: 'manual' }])
    expect(await holdsManager(p)).toBe(false)
  }, 120_000)
})
