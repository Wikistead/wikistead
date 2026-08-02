// #578 / ADR-201 slice 7: the TENANT mapping surface — the last one the mechanism had — is closed.
//
// Slice 3 shut the space scope; #514 had already made the tenant Roles tab the only place a mapping
// could be created at all. So this is the end of the mechanism, not another scope of it. What it pins
// is the same pair that made slice 3 safe rather than destructive: the door is shut, and nothing was
// thrown away — migration 103 converts each assignment to an ordinary manual one and CARRIES THE GROUP
// NAME onto it, which is the half that bounce ① proved is not optional (a group's FGA id is a one-way
// hash, so a name nobody else holds is a name that stops being displayable the moment its row goes).
//
// `group-role-mapping-497.test.ts` drove the retired routes and goes with them. Its subjects, named
// rather than dropped quietly (ADR-201's rule for a pin whose subject is gone):
//   - "a mapping grants the role to a synced group member LIVE, and delete reverts it" → the same fact
//     on the surviving path: space-mapping-retired-578 ("a group gains EDIT through the grant path"),
//     group-grant.test.ts (#163) and space-role-comment-485.
//   - "a built-in / unknown role id 404s" → the mechanism that could name a built-in is gone; a group
//     takes a built-in by being granted it, which group-grant-entitlement-578 exercises.
//   - "a role assigns only AT its scope" → custom-roles-tenant-445 anti-test 3, on the assign path
//     that survives (this was never a property of mappings — they inherited it).
//   - "the orphan badge flags a group no member carries" → the same distinction, better drawn, in
//     group-name-unconfirmed-578: a name nobody carries yet is UNCONFIRMED, which is not the same fact
//     as an id that resolves to no name at all.
//   - "customRoles OFF refuses create" → group-grant-entitlement-578 pins the gate on the path that
//     survives, including the two traps that made the first version of it vacuous (the default resolver
//     entitles everything, and Cloud has no `business` tier).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

let app: FastifyInstance
let db: TenantDb

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
}, 120_000)

afterAll(async () => {
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 120_000)

describe('#578 slice 7: every door into the mapping mechanism answers 410', () => {
  // A 404 would read as "wrong URL" to a script that used to work, and would leave whoever wrote it
  // hunting for a typo. 410 says the surface existed and was withdrawn — and the body says where to go.
  it('create', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/roles/mappings', headers: H,
      payload: { groupName: `tmr-${STAMP}`, roleId: 'whatever', resourceType: 'tenant', resourceId: TENANT },
    })
    expect(res.statusCode).toBe(410)
    expect(res.json()).toMatchObject({ code: 'mapping_retired' })
    expect(JSON.stringify(res.json()), 'names the replacement rather than just refusing').toMatch(/tenant settings|Members tab/i)
  }, 60_000)

  it('list', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/roles/mappings', headers: H })
    expect(res.statusCode).toBe(410)
  }, 60_000)

  it('delete', async () => {
    // No content-type on a body-less DELETE: Fastify answers 400 FST_ERR_CTP_EMPTY_JSON_BODY before any
    // handler runs if you declare JSON and send nothing, which reads as "the route is gone" but is not.
    const res = await app.inject({ method: 'DELETE', url: `/admin/roles/mappings/${STAMP}`, headers: { host: H.host, authorization: H.authorization } })
    expect(res.statusCode).toBe(410)
  }, 60_000)

  it('and no mapping row can be created any more', async () => {
    const [{ n }] = await admin<[{ n: string }]>`SELECT count(*)::text AS n FROM group_role_mappings WHERE tenant_id = ${TENANT} AND group_name LIKE ${'tmr-%'}`
    expect(n).toBe('0')
  }, 60_000)
})

describe('#578 slice 7: migration 103 converts, and keeps the name', () => {
  const sql = readFileSync(resolve(import.meta.dirname, '../../../../infra/db/migrations/103_retire_tenant_group_mappings.sql'), 'utf8')
  const cut = sql.indexOf('DELETE FROM group_role_mappings')

  it('carries the group name onto the assignment BEFORE the declaration row goes', () => {
    // Order matters and is the whole of bounce ①: delete first and the name is unrecoverable, because
    // the id is a hash and `members.groups` only holds names the directory has actually produced.
    const before = sql.slice(0, cut)
    expect(before).toMatch(/UPDATE role_assignments a SET group_name = m\.group_name/)
    expect(before, 'only where the row does not already carry one').toMatch(/a\.group_name IS NULL/)
  })

  it('re-owns the assignment as a manual one', () => {
    expect(sql.slice(0, cut)).toMatch(/UPDATE role_assignments SET origin = 'manual'/)
  })

  it('does not delete a single assignment — nobody loses a capability', () => {
    expect(sql).not.toMatch(/DELETE FROM role_assignments/)
  })

  it('scopes its DELETE to the tenant rows (098 already took the space ones)', () => {
    expect(sql.slice(cut)).toMatch(/resource_type = 'tenant'/)
  })

  it('leaves the TABLE for a later migration, after its readers are gone', () => {
    // #499: dropping storage while something still selects from it is how fga:resync died.
    expect(sql).not.toMatch(/DROP TABLE/)
  })
})
