// #537 Slice 3 — the admin login-methods view + the platform-login toggle (ruling 4). Integration
// (real PG + FGA + Valkey). Security pins:
//   1. tenant#admin gated: a plain member gets 403 on GET and PATCH (authz boundary);
//   2. ruling 4: platform login cannot be turned OFF without an EFFECTIVE own IdP (409
//      own_idp_required, nothing persisted) — and CAN with one;
//   3. the pref actually bites: with platform off, /auth/login-options stops offering oidc and
//      /auth/login answers the unified 404 (two-layer rule: the server refuses, not just the UI);
//   4. §1 display: a ceiling-excluded method still reports the tenant's stored selection.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { buildApp } from '../app.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const HOST = 'dev.localhost'
let app: FastifyInstance
let tenant: Tenant
let memberSid: string

const ADMIN_H = { host: HOST, authorization: 'Bearer dev-token' }

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))! as Tenant
  const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
  memberSid = await createSession(valkey, { tenantId: tenant.id, sub: 'lm537-member', role: 'member' })
  valkey.disconnect()
  // #471 tenant binding: every principal must be an FGA tenant#member to get past the hook at all —
  // the 403 pin below is then the ROUTE's admin gate, not the membership gate. Own sub, cleaned up.
  await writeTuples(fgaClient, [{ user: 'user:lm537-member', relation: 'member', object: `tenant:${tenant.id}` }])
}, 30_000)

afterEach(async () => {
  await admin`DELETE FROM tenant_login_prefs WHERE tenant_id = ${tenant.id}`.catch(() => {})
  await admin`DELETE FROM tenant_oidc WHERE tenant_id = ${tenant.id}`.catch(() => {})
  delete process.env.PLATFORM_OIDC_ISSUER
  delete process.env.PLATFORM_OIDC_CLIENT_ID
  delete process.env.PLATFORM_OIDC_REDIRECT_URI
  delete process.env.LOGIN_METHODS
})
afterAll(async () => {
  await deleteTuples(fgaClient, [{ user: 'user:lm537-member', relation: 'member', object: `tenant:${tenant.id}` }]).catch(() => {})
  await app.close()
  await admin.end()
  await pool.end()
}, 30_000)

const setPlatformEnv = () => {
  process.env.PLATFORM_OIDC_ISSUER = 'https://platform.example'
  process.env.PLATFORM_OIDC_CLIENT_ID = 'pc'
  process.env.PLATFORM_OIDC_REDIRECT_URI = `http://${HOST}/auth/callback`
}
const enableTenantOidc = () =>
  admin`INSERT INTO tenant_oidc (tenant_id, issuer, client_id, redirect_uri, enabled)
    VALUES (${tenant.id}, 'https://idp.example', 'c', ${'http://' + HOST + '/auth/callback'}, true)
    ON CONFLICT (tenant_id) DO UPDATE SET enabled = true`
const get = (h: Record<string, string> = ADMIN_H) => app.inject({ method: 'GET', url: '/admin/login-methods', headers: h })
const patch = (enabled: boolean, h: Record<string, string> = ADMIN_H) =>
  app.inject({ method: 'PATCH', url: '/admin/login-methods', headers: h, payload: { platformLoginEnabled: enabled } })

describe('#537 /admin/login-methods', () => {
  it('is tenant#admin gated: a plain member gets 403 on both verbs (authz boundary)', async () => {
    const H = { host: HOST, cookie: `${SESSION_COOKIE}=${memberSid}` }
    expect((await get(H)).statusCode).toBe(403)
    expect((await patch(false, H)).statusCode).toBe(403)
  })

  it('ruling 4: platform login cannot be turned off without an effective own IdP; can with one', async () => {
    setPlatformEnv()
    const denied = await patch(false)
    expect(denied.statusCode).toBe(409)
    expect(denied.json()).toMatchObject({ code: 'own_idp_required' })
    expect((await get()).json().methods['platform-oidc'].selected, 'nothing persisted').toBe(true)

    await enableTenantOidc() // an effective own IdP (enabled row; the resolver loads it)
    expect((await patch(false)).statusCode).toBe(204)
    const view = (await get()).json()
    expect(view.methods['platform-oidc'].selected).toBe(false)
    expect(view.methods['platform-oidc'].effective).toBe(false)
    expect(view.methods['tenant-oidc'].effective).toBe(true)
    // …and back on needs no precondition.
    expect((await patch(true)).statusCode).toBe(204)
    expect((await get()).json().methods['platform-oidc'].effective).toBe(true)
  })

  it('the pref BITES on the login surface: options stop offering oidc, /auth/login 404s (two-layer)', async () => {
    setPlatformEnv()
    await enableTenantOidc()
    expect((await patch(false)).statusCode).toBe(204)
    await admin`DELETE FROM tenant_oidc WHERE tenant_id = ${tenant.id}` // own IdP gone after the toggle
    const options = await app.inject({ method: 'GET', url: '/auth/login-options', headers: { host: HOST } })
    expect(options.json().methods, 'no method is offered').toEqual([])
    const login = await app.inject({ method: 'GET', url: '/auth/login', headers: { host: HOST } })
    expect(login.statusCode, 'the server refuses — not just the UI').toBe(404)
    expect(login.json()).toEqual({ error: 'not found' })
  })

  it('§1: a ceiling-excluded method reports unavailable-by-policy, not a silently-wiped selection', async () => {
    await enableTenantOidc()
    process.env.LOGIN_METHODS = 'platform-oidc,saml'
    const view = (await get()).json()
    expect(view.methods['tenant-oidc']).toMatchObject({ inCeiling: false, selected: true, effective: false })
  })

  it('/auth/login-options publishes the method kinds (§6/§7)', async () => {
    await enableTenantOidc()
    const options = await app.inject({ method: 'GET', url: '/auth/login-options', headers: { host: HOST } })
    expect(options.json().methods).toEqual(['oidc'])
  })
})
