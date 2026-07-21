// #462: who may issue an API key, and who may see which keys exist.
//
// Two things were true at once before this: the issuing UI lived only in the admin console, so keys
// felt like an admin thing — and the server enforced nothing, so any member could mint one by
// calling the API directly. The tenant now chooses, and the SERVER is what holds the line ("the UI
// is convenience, the server is the fortress"). Separately, GET /api-keys handed every member the
// name, prefix, scope and last-use time of every integration in the tenant; that view is now the
// admin's, and members get their own keys.
//
// Authorization boundary, so these are mandatory. Real Postgres + real OpenFGA, driven over HTTP.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, deleteTuples } from '@wikistead/authz'
import { ensureMembers, memberTuples } from './helpers/membership.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const MEMBER = 'akp462-member'
const OTHER = 'akp462-other'

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
const sids: Record<string, string> = {}

const H = (who: 'admin' | 'member' | 'other') =>
  who === 'admin'
    ? { host: 'dev.localhost', authorization: 'Bearer dev-token' }
    : { host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${sids[who]}` }

const setPolicy = (policy: string) =>
  app.inject({ method: 'PATCH', url: '/admin/api-policy', headers: H('admin'), payload: { issuePolicy: policy } })
const mint = (who: 'admin' | 'member' | 'other', name: string) =>
  app.inject({ method: 'POST', url: '/api-keys', headers: H(who), payload: { name } })

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  await ensureMembers(tenant.id, [MEMBER, OTHER])
  await admin`INSERT INTO members (tenant_id, sub, role) VALUES (${tenant.id}, ${MEMBER}, 'member'), (${tenant.id}, ${OTHER}, 'member')
              ON CONFLICT (tenant_id, sub) DO NOTHING`
  for (const who of ['member', 'other'] as const) {
    sids[who] = await createSession(valkey, { tenantId: tenant.id, sub: who === 'member' ? MEMBER : OTHER, role: 'member' })
  }
}, 40_000)

afterAll(async () => {
  await admin`DELETE FROM api_keys WHERE tenant_id = ${tenant.id} AND owner_user_id IN (${MEMBER}, ${OTHER})`
  await admin`DELETE FROM members WHERE tenant_id = ${tenant.id} AND sub IN (${MEMBER}, ${OTHER})`
  await admin`UPDATE tenant_settings SET api_key_issue_policy = NULL WHERE tenant_id = ${tenant.id}`
  await deleteTuples(fgaClient, memberTuples(tenant.id, [MEMBER, OTHER])).catch(() => {})
  await db.release()
  await app.close()
  await valkey.quit()
  await admin.end()
  await pool.end()
})

describe('#462: the API-key issuing policy', () => {
  it("defaults to letting members issue — which is what the server already did", async () => {
    await admin`UPDATE tenant_settings SET api_key_issue_policy = NULL WHERE tenant_id = ${tenant.id}`
    const res = await mint('member', 'default-policy')
    expect(res.statusCode, 'an unset policy must not change behaviour for an existing tenant').toBe(201)
    expect((res.json() as { plaintext: string }).plaintext).toMatch(/^wks_/)
  })

  it('refuses a member once the tenant asks for admins only — at the server, not in the UI', async () => {
    expect((await setPolicy('admins_only')).statusCode).toBe(204)
    const refused = await mint('member', 'should-not-exist')
    expect(refused.statusCode, 'the console hiding a button is not a gate').toBe(403)
    const rows = await admin`SELECT id FROM api_keys WHERE tenant_id = ${tenant.id} AND name = 'should-not-exist'`
    expect(rows.length, 'and nothing was written').toBe(0)

    expect((await mint('admin', 'admin-key')).statusCode, 'the admin still issues').toBe(201)
  })

  it('lets members issue again when the tenant says so', async () => {
    expect((await setPolicy('members')).statusCode).toBe(204)
    expect((await mint('member', 'member-key')).statusCode).toBe(201)
  })

  it('only an admin may change the policy', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/admin/api-policy', headers: H('member'), payload: { issuePolicy: 'admins_only' } })
    expect(res.statusCode).toBe(403)
    const [row] = await admin<{ api_key_issue_policy: string | null }[]>`
      SELECT api_key_issue_policy FROM tenant_settings WHERE tenant_id = ${tenant.id}`
    expect(row?.api_key_issue_policy, 'the policy is unchanged').toBe('members')
  })

  it('keeps the /admin/api-policy read and an empty write to admins (an /admin/ route)', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/api-policy', headers: H('member') })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/admin/api-policy', headers: H('admin') })).statusCode).toBe(200)
    // an empty body must not hand a non-admin a 204 that looks like success
    expect((await app.inject({ method: 'PATCH', url: '/admin/api-policy', headers: H('member'), payload: {} })).statusCode).toBe(403)
  })

  it('reports to the caller whether THEY may issue, without being the authority on it', async () => {
    await setPolicy('admins_only')
    expect(((await app.inject({ method: 'GET', url: '/api-keys/policy', headers: H('member') })).json() as { canIssue: boolean }).canIssue).toBe(false)
    expect(((await app.inject({ method: 'GET', url: '/api-keys/policy', headers: H('admin') })).json() as { canIssue: boolean }).canIssue).toBe(true)
    // …and the report is advisory: the refusal above is what actually stops the member
    await setPolicy('members')
  })
})

describe('#462: whose keys a caller can see', () => {
  it("shows a member their own keys and nobody else's", async () => {
    await setPolicy('members')
    await mint('member', 'mine-462')
    await mint('other', 'theirs-462')

    const mine = (await app.inject({ method: 'GET', url: '/api-keys/mine', headers: H('member') })).json() as { name: string }[]
    const names = mine.map((k) => k.name)
    expect(names).toContain('mine-462')
    expect(names, "another member's integration is not this member's business").not.toContain('theirs-462')
  })

  it('keeps the tenant-wide list to admins — it maps out who automates what', async () => {
    const asMember = await app.inject({ method: 'GET', url: '/api-keys', headers: H('member') })
    expect(asMember.statusCode, 'every member could read this before #462').toBe(403)

    const asAdmin = await app.inject({ method: 'GET', url: '/api-keys', headers: H('admin') })
    expect(asAdmin.statusCode).toBe(200)
    const names = (asAdmin.json() as { name: string }[]).map((k) => k.name)
    expect(names).toEqual(expect.arrayContaining(['mine-462', 'theirs-462']))
  })

  it('still lets only the owner revoke a key', async () => {
    const created = (await mint('member', 'revoke-462')).json() as { id: string }
    const byOther = await app.inject({ method: 'DELETE', url: `/api-keys/${created.id}`, headers: H('other') })
    expect(byOther.statusCode, 'not yours to revoke — and the 404 does not confirm it exists').toBe(404)
    const byOwner = await app.inject({ method: 'DELETE', url: `/api-keys/${created.id}`, headers: H('member') })
    expect(byOwner.statusCode).toBe(204)
  })
})
