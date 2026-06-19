// Integration tests — real Postgres + real OpenFGA + real Valkey, no mocks.
// Drives the auth hook via app.inject (cookie sessions are HTTP-level).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { looksLikeMemberCollabToken } from '@wikistead/auth'
import { buildApp } from '../app.js'
import { establishMemberSession, createSession, readSession, destroySession, sessionCookieOptions, SESSION_COOKIE } from '../auth/session.js'
import type { Tenant } from '@wikistead/types'

const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const MEMBER = 'sess-member-c2'
const STRANGER = 'sess-stranger-c2'

let tenant: Tenant
let db: TenantDb
let app: FastifyInstance

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await deleteTuples(fgaClient, [{ user: `user:${MEMBER}`, relation: 'member', object: `tenant:${tenant.id}` }]).catch(() => {})
  await db.sql`DELETE FROM members WHERE sub IN (${MEMBER}, ${STRANGER})`.catch(() => {})
  await db.release()
  await valkey.quit()
  await pool.end()
})

// ── (a) identity ≠ membership: un-invited subjects are rejected ─────────────
describe('establishMemberSession: membership gate', () => {
  it('rejects a subject that is not a tenant member (un-invited)', async () => {
    // STRANGER has no tenant#member tuple — IdP could verify them, but they cannot enter.
    await expect(
      establishMemberSession({ db, fga: fgaClient, valkey }, { id: tenant.id }, { sub: STRANGER, email: 's@x.test' }),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('accepts a provisioned member and creates a session + upserts the profile', async () => {
    await writeTuples(fgaClient, [{ user: `user:${MEMBER}`, relation: 'member', object: `tenant:${tenant.id}` }])
    const sid = await establishMemberSession({ db, fga: fgaClient, valkey }, { id: tenant.id }, { sub: MEMBER, email: 'm@x.test', name: 'M' })
    const sess = await readSession(valkey, sid)
    expect(sess).toMatchObject({ tenantId: tenant.id, sub: MEMBER })
    const [row] = await db.sql<{ email: string }[]>`SELECT email FROM members WHERE sub = ${MEMBER}`
    expect(row.email).toBe('m@x.test')
    await destroySession(valkey, sid)
  })
})

// ── cookie is host-only (no Domain) → cannot cross the tenant boundary ───────
describe('session cookie hardening', () => {
  it('cookie options are host-only (no domain), httpOnly, sameSite=lax', () => {
    const o = sessionCookieOptions()
    expect(o).not.toHaveProperty('domain') // host-only: acme cookie never sent to other
    expect(o.httpOnly).toBe(true)
    expect(o.sameSite).toBe('lax')
  })
})

// ── (b) a cross-tenant cookie is EXPLICITLY rejected (not a generic 401) ─────
describe('cross-tenant session cookie', () => {
  it('a session for tenant_acme presented on the dev host is rejected and the cookie cleared', async () => {
    const acmeSid = await createSession(valkey, { tenantId: 'tenant_acme', sub: 'acme-user-c2' })

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${acmeSid}` },
    })

    // Distinct from a plain "no credentials" 401: a specific reason + the cookie is cleared.
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: 'session tenant mismatch' })
    const setCookie = String(res.headers['set-cookie'] ?? '')
    expect(setCookie).toContain(SESSION_COOKIE) // cleared

    // contrast: NO cookie at all → the generic unauthorized path (different signal)
    const bare = await app.inject({ method: 'GET', url: '/auth/me', headers: { host: 'dev.localhost' } })
    expect(bare.statusCode).toBe(401)
    expect(bare.json()).toMatchObject({ error: 'unauthorized' })

    await destroySession(valkey, acmeSid)
  })
})

// ── /auth/me + logout (real Valkey revocation) ──────────────────────────────
describe('session endpoints', () => {
  it('/auth/me returns the member; logout deletes the Valkey session and clears the cookie', async () => {
    await writeTuples(fgaClient, [{ user: `user:${MEMBER}`, relation: 'member', object: `tenant:${tenant.id}` }]).catch(() => {})
    const sid = await establishMemberSession({ db, fga: fgaClient, valkey }, { id: tenant.id }, { sub: MEMBER, email: 'm@x.test' })

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${sid}` } })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ sub: MEMBER })

    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${sid}` } })
    expect(out.statusCode).toBe(204)
    expect(String(out.headers['set-cookie'] ?? '')).toContain(SESSION_COOKIE) // cleared
    expect(await readSession(valkey, sid)).toBeNull() // real revocation: Valkey entry gone
  })

  it('/auth/collab-token mints a member collab token from the session', async () => {
    await writeTuples(fgaClient, [{ user: `user:${MEMBER}`, relation: 'member', object: `tenant:${tenant.id}` }]).catch(() => {})
    const sid = await establishMemberSession({ db, fga: fgaClient, valkey }, { id: tenant.id }, { sub: MEMBER, email: 'm@x.test' })
    const res = await app.inject({ method: 'POST', url: '/auth/collab-token', headers: { host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${sid}` } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { token: string; expiresInSeconds: number }
    expect(looksLikeMemberCollabToken(body.token)).toBe(true)
    expect(body.expiresInSeconds).toBeGreaterThan(0)
    await destroySession(valkey, sid)
  })
})
