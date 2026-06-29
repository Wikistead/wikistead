// Integration tests for the OIDC login flow (P1.1 C3b) against a minimal REAL
// OpenID Provider (helpers/oidc-issuer). Real PG + OpenFGA + Valkey; the app's
// openid-client runs its genuine discovery/PKCE/nonce/code-exchange flow.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { groupFgaId } from '../auth/group-sync.js'
import { buildApp } from '../app.js'
import { encryptSecret } from '../auth/secret-crypto.js'
import { SESSION_COOKIE } from '../auth/session.js'
import { startTestIssuer, type TestIssuer } from './helpers/oidc-issuer.js'
import type { Tenant } from '@wikistead/types'

const CLIENT_ID = 'test-client'
const MEMBER = 'oidc-member-c3'
const STRANGER = 'oidc-stranger-c3'
const REDIRECT = 'http://dev.localhost/auth/callback'

let issuer: TestIssuer
let app: FastifyInstance
let tenant: Tenant
let db: TenantDb

// Drive login → IdP /authorize (real fetch) → return the relative callback path.
async function startLogin(returnTo?: string, host = 'dev.localhost'): Promise<string> {
  const url = '/auth/login' + (returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : '')
  const res = await app.inject({ method: 'GET', url, headers: { host } })
  expect(res.statusCode).toBe(302)
  const authorizeUrl = res.headers.location as string
  const authRes = await fetch(authorizeUrl, { redirect: 'manual' })
  const u = new URL(authRes.headers.get('location')!)
  return u.pathname + u.search // /auth/callback?code=...&state=...
}
const cb = (path: string, host = 'dev.localhost') => app.inject({ method: 'GET', url: path, headers: { host } })

beforeAll(async () => {
  issuer = await startTestIssuer({ clientId: CLIENT_ID })
  app = await buildApp()
  await app.ready()
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  // Point tenant_dev's OIDC config at the test issuer (secret encrypted at rest).
  await db.sql`
    INSERT INTO tenant_oidc (tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri)
    VALUES (${tenant.id}, ${issuer.url}, ${CLIENT_ID}, ${encryptSecret('test-secret')}, 'openid email profile', ${REDIRECT})
    ON CONFLICT (tenant_id) DO UPDATE SET
      issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id, client_secret_enc = EXCLUDED.client_secret_enc,
      scopes = EXCLUDED.scopes, redirect_uri = EXCLUDED.redirect_uri, enabled = true, updated_at = now()`
  // MEMBER is provisioned (FGA tenant#member); STRANGER is not.
  await writeTuples(fgaClient, [{ user: `user:${MEMBER}`, relation: 'member', object: `tenant:${tenant.id}` }])
})

afterAll(async () => {
  await deleteTuples(fgaClient, [{ user: `user:${MEMBER}`, relation: 'member', object: `tenant:${tenant.id}` }]).catch(() => {})
  // #102: drop any group#member tuples the groups-claim test synced (defensive — the test's
  // second login already diffs them away, but a mid-test failure could leave them).
  for (const g of ['Engineering', 'Sales']) {
    await deleteTuples(fgaClient, [{ user: `user:${MEMBER}`, relation: 'member', object: `group:${groupFgaId(tenant.id, g)}` }]).catch(() => {})
  }
  await db.sql`DELETE FROM members WHERE sub IN (${MEMBER}, ${STRANGER})`.catch(() => {})
  // Restore the dummy dev OIDC config (don't leave it pointing at a dead test issuer).
  await db.sql`UPDATE tenant_oidc SET issuer = ${process.env.OIDC_ISSUER!}, enabled = true WHERE tenant_id = ${tenant.id}`.catch(() => {})
  await app.close()
  await issuer.close()
  await db.release()
  await pool.end()
})

describe('OIDC login flow', () => {
  it('happy path: an invited member logs in and gets a session', async () => {
    issuer.setSubject(MEMBER, { email: 'm@x.test', name: 'Member' })
    const res = await cb(await startLogin('/'))
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/') // returnTo
    const setCookie = String(res.headers['set-cookie'] ?? '')
    expect(setCookie).toContain(`${SESSION_COOKIE}=`)
    const sid = /wks_sess=([^;]+)/.exec(setCookie)![1]

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${sid}` } })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ sub: MEMBER })
  })

  // #102 / ADR-055: the id_token groups claim flows into members.groups AND the FGA group#member
  // sync (#111), so a group grant (#163) resolves — and a non-array claim is ignored (coerced).
  it('groups claim → members.groups + FGA group#member; garbage claim is ignored', async () => {
    issuer.setSubject(MEMBER, { email: 'm@x.test', groups: ['Engineering', 'Sales'] })
    await cb(await startLogin('/'))
    const [m] = await db.sql<[{ groups: string[] }]>`SELECT groups FROM members WHERE sub = ${MEMBER}`
    expect(new Set(m.groups)).toEqual(new Set(['Engineering', 'Sales']))
    // the #111 sync wrote the group#member tuples → a member of Engineering resolves it (group is
    // not a page/space ResourceRef, so check via the raw FGA client, like group-sync.test).
    expect((await fgaClient.check({ user: `user:${MEMBER}`, relation: 'member', object: `group:${groupFgaId(tenant.id, 'Engineering')}` })).allowed).toBe(true)

    // Re-login with a GARBAGE (non-array) groups claim → coerced to [] (membership unaffected: the
    // diff removes the previous groups). An IdP anomaly never throws / blocks login.
    issuer.setSubject(MEMBER, { email: 'm@x.test', groups: 'not-an-array' })
    const res = await cb(await startLogin('/'))
    expect(res.statusCode).toBe(302) // login still succeeds
    const [m2] = await db.sql<[{ groups: string[] }]>`SELECT groups FROM members WHERE sub = ${MEMBER}`
    expect(m2.groups).toEqual([])
  })

  // identity ≠ membership, through the REAL flow: the IdP authenticates STRANGER
  // fine, but with no tenant#member grant the callback refuses to seat them.
  it('un-invited subject: authenticated by IdP but denied a session (vague error)', async () => {
    issuer.setSubject(STRANGER, { email: 's@x.test' })
    const res = await cb(await startLogin('/'))
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/login?error=access') // vague — no enumeration hint
    expect(String(res.headers['set-cookie'] ?? '')).not.toContain(`${SESSION_COOKIE}=`)
    const [row] = await db.sql`SELECT 1 AS x FROM members WHERE sub = ${STRANGER}`
    expect(row).toBeUndefined() // membership never created
  })

  it('invalid state: callback with an unknown state is rejected before any exchange', async () => {
    const res = await cb('/auth/callback?state=bogus-not-in-store&code=whatever')
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'invalid login state' })
  })

  it('replayed state: a consumed state cannot be reused (consume-once)', async () => {
    issuer.setSubject(MEMBER, { email: 'm@x.test' })
    const path = await startLogin('/')
    const first = await cb(path)
    expect(first.statusCode).toBe(302)
    expect(first.headers.location).toBe('/') // succeeded
    const second = await cb(path) // same state again
    expect(second.statusCode).toBe(400)
    expect(second.json()).toMatchObject({ error: 'invalid login state' })
  })

  it('returnTo open-redirect: an external returnTo is ignored, falls back to "/"', async () => {
    issuer.setSubject(MEMBER, { email: 'm@x.test' })
    const res = await cb(await startLogin('https://evil.com/phish'))
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/') // NOT evil.com
  })
})

// CE first-admin bootstrap THROUGH the real callback (P1.2 P2c): a member-less
// tenant configured with its own IdP makes the FIRST login admin, exactly once.
describe('CE first-admin bootstrap via callback', () => {
  const admin = postgres(process.env.DATABASE_ADMIN_URL!)
  const slug = `boot-cb-${Date.now().toString(36)}`
  const host = `${slug}.localhost`
  const BOOT = 'boot-admin-cb'
  const SECOND = 'boot-second-cb'
  let tenantId: string

  beforeAll(async () => {
    const [t] = await admin<{ id: string }[]>`INSERT INTO tenants (slug, plan) VALUES (${slug}, 'free') RETURNING id`
    tenantId = t.id
    await admin`
      INSERT INTO tenant_oidc (tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri)
      VALUES (${tenantId}, ${issuer.url}, ${CLIENT_ID}, ${encryptSecret('test-secret')}, 'openid email profile', ${`http://${host}/auth/callback`})`
  })
  afterAll(async () => {
    await deleteTuples(fgaClient, [
      { user: `user:${BOOT}`, relation: 'admin', object: `tenant:${tenantId}` },
      { user: `user:${BOOT}`, relation: 'member', object: `tenant:${tenantId}` },
    ]).catch(() => {})
    await admin`DELETE FROM members WHERE tenant_id = ${tenantId}`.catch(() => {})
    await admin`DELETE FROM tenant_oidc WHERE tenant_id = ${tenantId}`.catch(() => {})
    await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
    await admin.end()
  })

  it('first login into a member-less tenant is bootstrapped as admin', async () => {
    issuer.setSubject(BOOT, { email: 'boot@x.test' })
    const res = await cb(await startLogin('/', host), host)
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/')
    expect(String(res.headers['set-cookie'] ?? '')).toContain(`${SESSION_COOKIE}=`)
    expect((await fgaClient.check({ user: `user:${BOOT}`, relation: 'admin', object: `tenant:${tenantId}` })).allowed).toBe(true)
  })

  it('a second login is NOT auto-admitted — membership now requires an invite', async () => {
    issuer.setSubject(SECOND, { email: 'second@x.test' })
    const res = await cb(await startLogin('/', host), host)
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/login?error=access') // vague denial
    expect(String(res.headers['set-cookie'] ?? '')).not.toContain(`${SESSION_COOKIE}=`)
  })
})
