// #578 / ADR-201 rev3 slice 3: space-scope group mappings are retired.
//
// A space mapping and a space group grant were always the SAME FGA write — one assignment whose
// principal is `group:<id>#member`. The mapping added a declaration row that OWNED that assignment,
// and the 409s and the drift sweep existed to keep that ownership honest. One mechanism survives, and
// it is the grant: since slice 1 the grant picker also takes a group nobody carries yet, which was the
// only thing the mapping form could do that the picker could not.
//
// What this pins is the pair that makes a retirement safe rather than destructive: the door is shut
// (new space mappings are refused) and nothing was thrown away (migration 098 converts the assignment
// to a plain manual grant, so the same principal keeps the same capabilities).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let roleId = ''

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `smr-${STAMP}` })).id
  const created = await app.inject({
    method: 'POST', url: '/admin/roles', headers: H,
    payload: { name: `smr-role-${STAMP}`, capabilities: ['view'], scope: 'resource' },
  })
  roleId = created.json().id as string
}, 120_000)

afterAll(async () => {
  await admin`DELETE FROM role_assignments WHERE resource_id = ${spaceId}`.catch(() => {})
  await admin`DELETE FROM roles WHERE id = ${roleId}`.catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 120_000)

describe('#578: the space mapping surface is closed', () => {
  it('creating a space-scope mapping is refused, and says where to go instead', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/roles/mappings', headers: H,
      payload: { groupName: `smr-group-${STAMP}`, roleId, resourceType: 'space', resourceId: spaceId },
    })
    expect(res.statusCode, 'gone, not merely invalid — the surface existed and was withdrawn').toBe(410)
    expect(res.json()).toMatchObject({ code: 'mapping_retired' })
    expect(JSON.stringify(res.json()), 'the refusal names the replacement').toMatch(/Members tab/i)
  }, 60_000)

  it('a BUILT-IN mapping has nowhere left to live', async () => {
    // built-ins were mappable at space scope only, so retiring that scope retires them
    const res = await app.inject({
      method: 'POST', url: '/admin/roles/mappings', headers: H,
      payload: { groupName: `smr-b-${STAMP}`, builtinCapability: 'edit', resourceType: 'space', resourceId: spaceId },
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  }, 60_000)

  // RE-AIMED by slice 7. This used to read "TENANT mappings still work — this slice retires one scope,
  // not the mechanism", and it was true for exactly as long as slice 7 took to land. The tenant scope
  // was the LAST one (#514 had already moved space mappings off the admin tab), so the mechanism is now
  // gone entirely and the same call answers the same 410 the space scope does.
  it('and so is the TENANT scope — the last one the mechanism had', async () => {
    const tenantRole = await app.inject({
      method: 'POST', url: '/admin/roles', headers: H,
      payload: { name: `smr-trole-${STAMP}`, capabilities: ['createSpaces'], scope: 'tenant' },
    })
    const tid = tenantRole.json().id as string
    try {
      const res = await app.inject({
        method: 'POST', url: '/admin/roles/mappings', headers: H,
        payload: { groupName: `smr-tg-${STAMP}`, roleId: tid, resourceType: 'tenant', resourceId: TENANT },
      })
      expect(res.statusCode, 'gone, not invalid').toBe(410)
      expect(res.json()).toMatchObject({ code: 'mapping_retired' })
      expect(JSON.stringify(res.json()), 'and it names where a group takes a tenant role now').toMatch(/tenant settings/i)
      const [{ n }] = await admin<[{ n: string }]>`SELECT count(*)::text AS n FROM role_assignments WHERE tenant_id = ${TENANT} AND role_id = ${tid}`
      expect(n, 'a refused create writes nothing').toBe('0')
    } finally {
      await admin`DELETE FROM role_assignments WHERE role_id = ${tid}`.catch(() => {})
      await admin`DELETE FROM roles WHERE id = ${tid}`.catch(() => {})
    }
  }, 60_000)
})

describe('#578: what the built-in mapping did, the grant does', () => {
  // `builtin-group-mapping-497.test.ts` drove the retired route and is removed with it. Its subjects,
  // named rather than dropped quietly (ADR-201's rule for a pin whose subject is gone):
  //   - "a group gains a built-in capability on a space, and delete revokes it" → PROVED BELOW, and for
  //     `view` in group-grant.test.ts (#163), through the surviving grant path.
  //   - "the client-sent principal is not what membership lives under" → role-assign-group-536.test.ts.
  //   - "a mapping-owned grant 409s at the Members surface" / "the converge script pulls in strays" →
  //     RETIRED WITH THE MECHANISM. Ownership existed to keep a declaration row and its assignment in
  //     step; with one mechanism there is no second writer to disagree with, and migration 098 turned
  //     those assignments into ordinary manual grants on purpose.
  //   - "a built-in editor mapping confers the whole noun" → the edit⇒comment inclusion was itself
  //     retired (#553/#552); comment is its own capability, so that subject no longer exists either.
  it('a group gains EDIT on a space through the grant path, and revoke takes it back', async () => {
    const { groupGrantee } = await import('../auth/group-sync.js')
    const { checkRelation } = await import('@wikistead/authz')
    const { grantSpaceAccess, revokeSpaceAccess } = await import('../routes/spaces.js')
    const grantee = groupGrantee(TENANT, `smr-editors-${STAMP}`)
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee, capability: 'edit' })
    expect(await checkRelation(fgaClient, grantee, 'editor', { type: 'space', id: spaceId })).toBe(true)
    await revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee, capability: 'edit' })
    expect(await checkRelation(fgaClient, grantee, 'editor', { type: 'space', id: spaceId })).toBe(false)
  }, 60_000)
})

describe('#578: the migration converts rather than deletes', () => {
  const sql = readFileSync(resolve(import.meta.dirname, '../../../../infra/db/migrations/098_retire_space_group_mappings.sql'), 'utf8')

  it('the assignment survives as a manual grant before the declaration row goes', () => {
    const update = sql.slice(0, sql.indexOf('DELETE FROM group_role_mappings'))
    expect(update, 'the conversion runs first').toMatch(/UPDATE role_assignments SET origin = 'manual'/)
    expect(update, 'and only for the assignments the space mappings own').toMatch(/resource_type = 'space'/)
  })

  it('it does not delete a single assignment', () => {
    // the whole point: nobody loses access. Only the declaration row is removed.
    expect(sql).not.toMatch(/DELETE FROM role_assignments/)
  })

  it('tenant mappings are left alone (they are slices 4 and 5, each with its own conversion)', () => {
    const del = sql.slice(sql.indexOf('DELETE FROM group_role_mappings'))
    expect(del).toMatch(/resource_type = 'space'/)
  })
})
