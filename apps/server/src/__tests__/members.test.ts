// Integration tests — real Postgres + real OpenFGA + real Valkey, no mocks.
// Drives the member-management API via app.inject with cookie sessions. Focus:
// the admin authz matrix (point 7), the last-admin lockout guard, and immediate
// session revocation on removal (point 7 — the §7 session index).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { buildApp } from '../app.js'
import { provisionTenant } from '../auth/provisioning.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')

const hasRel = async (user: string, relation: string, object: string) =>
  Boolean((await fgaClient.check({ user, relation, object })).allowed)

let app: FastifyInstance
let tenantId: string
let slug: string
let host: string
let adminSid: string
let plainSid: string

const cookie = (sid: string) => `${SESSION_COOKIE}=${sid}`

// Insert a member row + its FGA grants directly (test fixture).
async function seedMember(sub: string, role: 'admin' | 'member') {
  await admin`SELECT set_config('app.tenant_id', ${tenantId}, false)`
  await admin`INSERT INTO members (tenant_id, sub, role) VALUES (${tenantId}, ${sub}, ${role})
              ON CONFLICT (tenant_id, sub) DO UPDATE SET role = EXCLUDED.role`
  const tuples = [{ user: `user:${sub}`, relation: 'member', object: `tenant:${tenantId}` }]
  if (role === 'admin') tuples.push({ user: `user:${sub}`, relation: 'admin', object: `tenant:${tenantId}` })
  await writeTuples(fgaClient, tuples)
}

beforeAll(async () => {
  slug = `p14mem-${Date.now().toString(36)}`
  host = `${slug}.localhost`
  ;({ tenantId } = await provisionTenant(fgaClient, { slug, admin: { sub: 'mem-admin', email: 'a@x.test' } }))
  await seedMember('mem-admin2', 'admin') // second admin so the guard has room
  await seedMember('mem-plain', 'member')

  app = await buildApp()
  await app.ready()
  adminSid = await createSession(valkey, { tenantId, sub: 'mem-admin', role: 'admin' })
  plainSid = await createSession(valkey, { tenantId, sub: 'mem-plain', role: 'member' })
})

afterAll(async () => {
  await app.close()
  for (const sub of ['mem-admin', 'mem-admin2', 'mem-plain', 'mem-victim']) {
    await deleteTuples(fgaClient, [
      { user: `user:${sub}`, relation: 'member', object: `tenant:${tenantId}` },
      { user: `user:${sub}`, relation: 'admin', object: `tenant:${tenantId}` },
    ]).catch(() => {})
  }
  await admin`DELETE FROM invites WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await admin.end()
  await valkey.quit()
  await pool.end()
})

// ── point 7: a non-admin member must not reach ANY management route ──────────
describe('admin authz matrix', () => {
  const reqs: [string, string][] = [
    ['GET', '/members'],
    ['GET', '/members/invites'],
    ['POST', '/members/invites'],
    ['PATCH', '/members/mem-admin2'],
    ['DELETE', '/members/mem-admin2'],
    ['DELETE', '/members/invites/some-id'],
  ]
  for (const [method, url] of reqs) {
    it(`rejects a non-admin: ${method} ${url} → 403`, async () => {
      const res = await app.inject({ method: method as 'GET', url, headers: { host, cookie: cookie(plainSid) }, payload: { role: 'member' } })
      expect(res.statusCode).toBe(403)
    })
  }

  it('allows an admin to list members', async () => {
    const res = await app.inject({ method: 'GET', url: '/members', headers: { host, cookie: cookie(adminSid) } })
    expect(res.statusCode).toBe(200)
    const subs = (res.json().members as { sub: string }[]).map((m) => m.sub).sort()
    expect(subs).toEqual(['mem-admin', 'mem-admin2', 'mem-plain'])
  })
})

// ── invites via the admin API ───────────────────────────────────────────────
describe('invite admin API', () => {
  it('creates an invite (returns the link), lists it, then revokes it', async () => {
    const create = await app.inject({
      method: 'POST', url: '/members/invites',
      headers: { host, cookie: cookie(adminSid) }, payload: { email: 'newbie@x.test', role: 'member' },
    })
    expect(create.statusCode).toBe(201)
    const body = create.json() as { inviteUrl: string; emailed: boolean }
    expect(body.inviteUrl).toMatch(/\/invite\?token=inv_/)
    expect(typeof body.emailed).toBe('boolean')

    const list = await app.inject({ method: 'GET', url: '/members/invites', headers: { host, cookie: cookie(adminSid) } })
    const invites = list.json().invites as { id: string; email: string }[]
    expect(invites.some((i) => i.email === 'newbie@x.test')).toBe(true)

    const id = invites.find((i) => i.email === 'newbie@x.test')!.id
    const del = await app.inject({ method: 'DELETE', url: `/members/invites/${id}`, headers: { host, cookie: cookie(adminSid) } })
    expect(del.statusCode).toBe(204)
    const after = await app.inject({ method: 'GET', url: '/members/invites', headers: { host, cookie: cookie(adminSid) } })
    expect((after.json().invites as unknown[]).length).toBe(0)
  })
})

// ── role changes + FGA tuple sync ───────────────────────────────────────────
describe('role change', () => {
  it('promotes a member to admin and demotes back, syncing the FGA admin tuple', async () => {
    const up = await app.inject({ method: 'PATCH', url: '/members/mem-plain', headers: { host, cookie: cookie(adminSid) }, payload: { role: 'admin' } })
    expect(up.statusCode).toBe(200)
    expect(await hasRel('user:mem-plain', 'admin', `tenant:${tenantId}`)).toBe(true)

    const down = await app.inject({ method: 'PATCH', url: '/members/mem-plain', headers: { host, cookie: cookie(adminSid) }, payload: { role: 'member' } })
    expect(down.statusCode).toBe(200)
    expect(await hasRel('user:mem-plain', 'admin', `tenant:${tenantId}`)).toBe(false)
    expect(await hasRel('user:mem-plain', 'member', `tenant:${tenantId}`)).toBe(true) // still a member
  })
})

// ── point 7: immediate session revocation on removal ────────────────────────
describe('removal revokes sessions immediately', () => {
  it("deletes a removed member's live session (not at TTL)", async () => {
    await seedMember('mem-victim', 'member')
    const victimSid = await createSession(valkey, { tenantId, sub: 'mem-victim', role: 'member' })
    // Sanity: the victim can use their session.
    const before = await app.inject({ method: 'GET', url: '/auth/me', headers: { host, cookie: cookie(victimSid) } })
    expect(before.statusCode).toBe(200)

    const del = await app.inject({ method: 'DELETE', url: '/members/mem-victim', headers: { host, cookie: cookie(adminSid) } })
    expect(del.statusCode).toBe(204)

    // The previously-valid session no longer authenticates.
    const after = await app.inject({ method: 'GET', url: '/auth/me', headers: { host, cookie: cookie(victimSid) } })
    expect(after.statusCode).toBe(401)
    expect(await hasRel('user:mem-victim', 'member', `tenant:${tenantId}`)).toBe(false)
  })
})

// ── last-admin lockout guard (run last: it demotes the spare admin) ──────────
describe('last-admin guard', () => {
  it('refuses to demote or remove the final admin', async () => {
    // Demote the spare admin → mem-admin is now the ONLY admin.
    const demoteSpare = await app.inject({ method: 'PATCH', url: '/members/mem-admin2', headers: { host, cookie: cookie(adminSid) }, payload: { role: 'member' } })
    expect(demoteSpare.statusCode).toBe(200)

    const demoteLast = await app.inject({ method: 'PATCH', url: '/members/mem-admin', headers: { host, cookie: cookie(adminSid) }, payload: { role: 'member' } })
    expect(demoteLast.statusCode).toBe(409)

    const removeLast = await app.inject({ method: 'DELETE', url: '/members/mem-admin', headers: { host, cookie: cookie(adminSid) } })
    expect(removeLast.statusCode).toBe(409)
    // Still an admin (guard held).
    expect(await hasRel('user:mem-admin', 'admin', `tenant:${tenantId}`)).toBe(true)
  })
})
