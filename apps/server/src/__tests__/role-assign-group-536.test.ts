// #536 assigning a custom role to a GROUP wrote a tuple no membership pointed at.
//
// A group's FGA id is a tenant-salted hash the server derives (`groupGrantee`); the browser built
// `group:<name>#member` from the raw name instead. The write succeeded, the UI said so, and nobody gained
// anything — an operation reporting success it had not earned, which is the second time that shape shipped
// in this ticket. Nothing caught it because the merged picker had no behavioural test at all: types and
// lexical checks both accept a well-formed principal that happens to point nowhere.
//
// So this drives the ROUTE and then asks FGA whether a real member of that group actually gained the
// capability. That is the only question that distinguishes the two cases.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, writeTuples, deleteTuples } from '@wikistead/authz'
import { groupGrantee, syncMemberGroups } from '../auth/group-sync.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, publishPage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import { createSession } from '../auth/session.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const GROUP = `rag-group-${STAMP}`
const ADMIN = 'dev-user'                 // tenant admin: may assign anywhere
const MEMBER = `rag-member-${STAMP}`     // belongs to GROUP, and must gain what the group is given

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let pageId = ''
let roleId = ''
let cookie = ''

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: ADMIN, plan: 'business', name: `rag-${STAMP}` })).id
  const p = await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: ADMIN, title: 'group-target' })
  pageId = p.id
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: `user:${ADMIN}`, createdBy: `user:${ADMIN}` })

  // A real member of a real group: the #111 sync writes the membership under the DERIVED id.
  await db.sql`
    INSERT INTO members (tenant_id, sub, role, groups) VALUES (${TENANT}, ${MEMBER}, 'member', ${db.sql.array([GROUP])})
    ON CONFLICT (tenant_id, sub) DO UPDATE SET groups = EXCLUDED.groups`
  await writeTuples(fgaClient, [{ user: `user:${MEMBER}`, relation: 'member', object: `tenant:${TENANT}` }]).catch(() => {})
  await syncMemberGroups(fgaClient, TENANT, MEMBER, [], [GROUP])

  cookie = `wks_sess=${await createSession(app.valkey, { tenantId: TENANT, sub: ADMIN, role: 'admin' })}`
  // Create the role through its own route rather than by hand: the schema is the route's business, and a
  // fixture that guesses it is a fixture that drifts.
  const made = await app.inject({
    method: 'POST', url: '/admin/roles', headers: { host: 'dev.localhost', cookie },
    payload: { name: `rag-role-${STAMP}`, capabilities: ['view'], scope: 'resource' },
  })
  if (made.statusCode !== 201) throw new Error(`role create: ${made.statusCode} ${made.body.slice(0, 200)}`)
  roleId = made.json().id
}, 120_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [{ user: groupGrantee(TENANT, GROUP), relation: 'viewer', object: `space:${spaceId}` }]).catch(() => {})
  await deleteTuples(fgaClient, [{ user: groupGrantee(TENANT, GROUP), relation: 'viewer_member', object: `space:${spaceId}` }]).catch(() => {})
  await syncMemberGroups(fgaClient, TENANT, MEMBER, [GROUP], []).catch(() => {})
  await deleteTuples(fgaClient, [{ user: `user:${MEMBER}`, relation: 'member', object: `tenant:${TENANT}` }]).catch(() => {})
  await adminPool`DELETE FROM role_assignments WHERE role_id = ${roleId}`.catch(() => {})
  await adminPool`DELETE FROM roles WHERE id = ${roleId}`.catch(() => {})
  await adminPool`DELETE FROM members WHERE sub = ${MEMBER}`.catch(() => {})
  await deletePage(db, fgaClient, app.searchDriver, { pageId, userId: ADMIN }).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: ADMIN }).catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

describe('#536 assigning a custom role to a GROUP reaches that group\'s members', () => {
  it('a member of the named group gains the role, because the server derived the id', async () => {
    expect(await check(fgaClient, `user:${MEMBER}`, 'view', { type: 'page', id: pageId }), 'nothing before').toBe(false)

    const res = await app.inject({
      method: 'POST', url: `/admin/roles/${roleId}/assignments`,
      headers: { host: 'dev.localhost', cookie },
      payload: { resourceType: 'space', resourceId: spaceId, groupName: GROUP },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(201)

    // THE question. A hand-built `group:<name>#member` principal is well-formed and passes every check the
    // route makes — it just points at nothing, so this is false and the assignment was theatre.
    expect(await check(fgaClient, `user:${MEMBER}`, 'view', { type: 'page', id: pageId }),
      'the group member actually gained the capability').toBe(true)
  }, 120_000)

  it('the raw-name principal the client used to send is NOT what the membership lives under', async () => {
    // Stated as its own fact so the reason the fix exists cannot be mistaken for a style preference: the
    // two ids differ, and only one of them has members.
    expect(groupGrantee(TENANT, GROUP)).not.toBe(`group:${GROUP}#member`)
    const { tuples } = await fgaClient.read({ user: `group:${GROUP}#member`, object: `space:${spaceId}` })
    expect(tuples ?? [], 'nothing is addressed by the raw name').toHaveLength(0)
  }, 120_000)
})
