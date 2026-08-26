// #935: the refusal `PUT /admin/login-methods` gives while SSO is required and biting reads "exempt
// ANOTHER ADMINISTRATOR who has one". The exemption list already carried `hasCredential` (who has a
// key) but not `role` (who is an administrator) — the one instruction the refusal gives was not
// answerable from the screen that names exemptions. This measures the list's new `isAdmin` field.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const STAMP = Date.now().toString(36)
const ADMIN_SUB = `sso935-admin-${STAMP}`
const MEMBER_SUB = `sso935-member-${STAMP}`
const GHOST_SUB = `sso935-ghost-${STAMP}`
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }

let app: FastifyInstance

const list = () => app.inject({ method: 'GET', url: '/admin/sso-exemptions?limit=500', headers: H })

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${T}, ${ADMIN_SUB}, ${`${ADMIN_SUB}@fixture.test`}, 'admin') ON CONFLICT DO NOTHING`
  await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${T}, ${MEMBER_SUB}, ${`${MEMBER_SUB}@fixture.test`}, 'member') ON CONFLICT DO NOTHING`
  await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${T}, ${GHOST_SUB}, ${`${GHOST_SUB}@fixture.test`}, 'admin') ON CONFLICT DO NOTHING`
  await admin`INSERT INTO sso_exemptions (tenant_id, member_sub, created_by) VALUES (${T}, ${ADMIN_SUB}, 'dev-user') ON CONFLICT DO NOTHING`
  await admin`INSERT INTO sso_exemptions (tenant_id, member_sub, created_by) VALUES (${T}, ${MEMBER_SUB}, 'dev-user') ON CONFLICT DO NOTHING`
  await admin`INSERT INTO sso_exemptions (tenant_id, member_sub, created_by) VALUES (${T}, ${GHOST_SUB}, 'dev-user') ON CONFLICT DO NOTHING`
  // #623: an exemption is never pruned when its member is removed — the row outlives them. Deleting
  // the member here (exemption kept) reproduces that orphan on purpose.
  await admin`DELETE FROM members WHERE tenant_id = ${T} AND sub = ${GHOST_SUB}`
}, 120_000)

afterAll(async () => {
  await admin`DELETE FROM sso_exemptions WHERE tenant_id = ${T} AND member_sub IN (${ADMIN_SUB}, ${MEMBER_SUB}, ${GHOST_SUB})`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${T} AND sub IN (${ADMIN_SUB}, ${MEMBER_SUB}, ${GHOST_SUB})`.catch(() => {})
  await app.close(); await pool.end(); await admin.end()
}, 120_000)

describe('#935: the SSO-exemption list answers "is this an administrator"', () => {
  it('an admin exemption reads isAdmin=true, a member exemption reads isAdmin=false', async () => {
    const res = await list()
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as { exemptions: { memberSub: string; isAdmin: boolean }[] }
    const admin1 = body.exemptions.find((e) => e.memberSub === ADMIN_SUB)
    const member1 = body.exemptions.find((e) => e.memberSub === MEMBER_SUB)
    expect(admin1?.isAdmin, 'the administrator exemption is named as one').toBe(true)
    expect(member1?.isAdmin, 'the ordinary-member exemption is not').toBe(false)
  }, 120_000)

  it('an exemption whose member was removed still appears, isAdmin=false rather than dropped', async () => {
    // #623: no FK ties sso_exemptions to members, so a removed member's exemption row survives. An
    // INNER join on members would silently drop it from the list instead — this is the regression the
    // LEFT join in the route guards against.
    const res = await list()
    const body = res.json() as { exemptions: { memberSub: string; isAdmin: boolean }[] }
    const ghost = body.exemptions.find((e) => e.memberSub === GHOST_SUB)
    expect(ghost, 'the orphaned exemption is still in the list').toBeDefined()
    expect(ghost?.isAdmin, 'a member that no longer exists is not an actionable administrator').toBe(false)
  }, 120_000)
})
