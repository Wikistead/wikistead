// #579: a tenant role for a GROUP. The admin console had no way to do this — the only group-name
// source was space-scoped and gated on that space's `manage`, which the console cannot satisfy (there
// is no space), so the screen could list a group assignment but never create one.
//
// Two things are pinned here rather than in the e2e spec, because both need to be looked at where they
// actually live: the endpoint's authority (a non-admin must not learn the tenant's group names — they
// can be sensitive) and the TUPLE the assignment writes. The e2e spec drives the UI; it cannot see FGA,
// and the e2e fixture has no IdP groups, so its group case returns early and says so.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { fgaClient, deleteTuples } from '@wikistead/authz'
import { groupFgaId } from '../auth/group-sync.js'
import { buildApp } from '../app.js'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const GROUP = `tgr-eng-${STAMP}`
const MEMBER = `tgr-member-${STAMP}`
const PRINCIPAL = `group:${groupFgaId(TENANT, GROUP)}#member`

let app: FastifyInstance
let roleId = ''

const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  roleId = `tgr-role-${STAMP}`
  await adminPool`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${roleId}, ${TENANT}, ${`tgr-${STAMP}`}, ARRAY['createSpaces']::text[], 'tenant')`
  // a member carrying the group — the only place group NAMES exist (FGA sees the hash)
  await adminPool`INSERT INTO members (tenant_id, sub, display_name, groups) VALUES (${TENANT}, ${MEMBER}, ${'TGR Member'}, ${[GROUP]})`
}, 120_000)

afterAll(async () => {
  await adminPool`DELETE FROM role_assignments WHERE tenant_id = ${TENANT} AND principal = ${PRINCIPAL}`.catch(() => {})
  await adminPool`DELETE FROM roles WHERE id = ${roleId}`.catch(() => {})
  await adminPool`DELETE FROM members WHERE tenant_id = ${TENANT} AND sub = ${MEMBER}`.catch(() => {})
  await deleteTuples(fgaClient, [{ user: PRINCIPAL, relation: 'space_creator', object: `tenant:${TENANT}` }]).catch(() => {})
  await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

describe('#579: tenant roles can be given to a group, from the admin console', () => {
  it('GET /admin/groups answers the tenant\'s group names to an admin', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/groups', headers: dev })
    expect(res.statusCode).toBe(200)
    // #623: paged response — the names live under `groups`.
    expect((res.json() as { groups: string[] }).groups).toContain(GROUP)
  })

  it('a non-admin member gets nothing — group names are not member-visible', async () => {
    const res = await app.inject({
      method: 'GET', url: '/admin/groups',
      headers: { host: 'dev.localhost', authorization: `Bearer dev-token:${MEMBER}` },
    })
    expect([401, 403], `a plain member must not enumerate groups (got ${res.statusCode})`).toContain(res.statusCode)
  })

  it('assigning by NAME writes the tuple the group\'s members actually hold', async () => {
    // the client sends the name; the server derives the id (group-sync.ts is the single authority).
    // A client that built `group:<name>#member` itself would write a tuple no membership points at —
    // the assignment would report success and reach nobody (#536).
    const res = await app.inject({
      method: 'POST', url: `/admin/roles/${roleId}/assignments`, headers: dev,
      payload: { resourceType: 'tenant', resourceId: TENANT, groupName: GROUP },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().principal, 'the derived id, not the name').toBe(PRINCIPAL)
    // read the tuple directly: `check` speaks capabilities, and the leaf is what must exist for the
    // group's members to inherit it through `group:<id>#member`
    // fga-read-ok: ONE principal on ONE object — a (user, relation, object) tuple is unique.
    const { tuples } = await fgaClient.read({ user: PRINCIPAL, object: `tenant:${TENANT}` })
    expect((tuples ?? []).map((t) => t.key?.relation), 'the capability reached FGA as its leaf').toContain('space_creator')

    // and the assignment list names it back, so the console can draw a row that is not a hash
    const list = await app.inject({ method: 'GET', url: `/admin/roles/assignments?resourceType=tenant&resourceId=${TENANT}`, headers: dev })
    const row = (list.json() as { principal: string; groupName?: string }[]).find((r) => r.principal === PRINCIPAL)
    expect(row?.groupName).toBe(GROUP)
  }, 120_000)
})
