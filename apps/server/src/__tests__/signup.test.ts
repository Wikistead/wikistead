// Integration tests for Cloud self-serve signup (P1.2 P2d) against a minimal REAL
// OpenID Provider acting as the platform IdP. Real PG + OpenFGA + Valkey.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { fgaClient, deleteTuples } from '@wikistead/authz'
import { buildApp } from '../app.js'
import { SIGNUP_COOKIE } from '../auth/signup-session.js'
import { startTestIssuer, type TestIssuer } from './helpers/oidc-issuer.js'

const CLIENT_ID = 'signup-client'
const CREATOR = 'signup-creator'
const PLATFORM_HOST = 'platform.localhost'
const admin = postgres(process.env.DATABASE_ADMIN_URL!)

let issuer: TestIssuer
let app: FastifyInstance
const createdSlugs: string[] = []

beforeAll(async () => {
  issuer = await startTestIssuer({ clientId: CLIENT_ID })
  issuer.setSubject(CREATOR, { email: 'creator@e2e.test', name: 'Creator' })
  process.env.PLATFORM_OIDC_ISSUER = issuer.url
  process.env.PLATFORM_OIDC_CLIENT_ID = CLIENT_ID
  delete process.env.PLATFORM_OIDC_CLIENT_SECRET // public client
  process.env.PLATFORM_OIDC_REDIRECT_URI = `http://${PLATFORM_HOST}/signup/callback`
  process.env.PUBLIC_TENANT_BASE_HOST = 'localhost:5180'
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  for (const slug of createdSlugs) {
    const [t] = await admin<{ id: string }[]>`SELECT id FROM tenants WHERE slug = ${slug}`
    if (t) {
      await deleteTuples(fgaClient, [
        { user: `user:${CREATOR}`, relation: 'admin', object: `tenant:${t.id}` },
        { user: `user:${CREATOR}`, relation: 'member', object: `tenant:${t.id}` },
      ]).catch(() => {})
      await admin`DELETE FROM members WHERE tenant_id = ${t.id}`.catch(() => {})
      await admin`DELETE FROM tenants WHERE id = ${t.id}`.catch(() => {})
    }
  }
  for (const k of ['PLATFORM_OIDC_ISSUER', 'PLATFORM_OIDC_CLIENT_ID', 'PLATFORM_OIDC_REDIRECT_URI', 'PUBLIC_TENANT_BASE_HOST']) delete process.env[k]
  await app.close()
  await issuer.close()
  await admin.end()
  await pool.end()
})

// Drive /signup/login → platform IdP /authorize → return the signup callback path.
async function startSignup(): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/signup/login', headers: { host: PLATFORM_HOST } })
  expect(res.statusCode).toBe(302)
  const authRes = await fetch(res.headers.location as string, { redirect: 'manual' })
  const u = new URL(authRes.headers.get('location')!)
  return u.pathname + u.search // /signup/callback?code&state
}

describe('Cloud signup', () => {
  it('signup → callback issues a signup session cookie (Path=/signup), not a member session', async () => {
    const res = await app.inject({ method: 'GET', url: await startSignup(), headers: { host: PLATFORM_HOST } })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/join/workspace')
    const setCookie = String(res.headers['set-cookie'] ?? '')
    expect(setCookie).toContain(`${SIGNUP_COOKIE}=`)
    expect(setCookie).toMatch(/Path=\/signup/i) // confined to /signup
    expect(setCookie).not.toContain('wks_sess=') // NOT a member session
  })

  it('creates a tenant from the signup session with the creator as admin, then consumes it', async () => {
    const cb = await app.inject({ method: 'GET', url: await startSignup(), headers: { host: PLATFORM_HOST } })
    const sid = /wks_signup=([^;]+)/.exec(String(cb.headers['set-cookie']))![1]

    const slug = `myws-${Date.now().toString(36)}`
    createdSlugs.push(slug)
    const res = await app.inject({
      method: 'POST', url: '/signup/tenants',
      headers: { host: PLATFORM_HOST, cookie: `${SIGNUP_COOKIE}=${sid}`, 'content-type': 'application/json' },
      payload: { slug },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().tenantUrl).toBe(`http://${slug}.localhost:5180`)
    // signup session consumed (cookie cleared)
    expect(String(res.headers['set-cookie'] ?? '')).toContain(`${SIGNUP_COOKIE}=`)

    const [t] = await admin<{ id: string }[]>`SELECT id FROM tenants WHERE slug = ${slug}`
    const ms = await admin`SELECT sub, role FROM members WHERE tenant_id = ${t.id}`
    expect(ms).toEqual([{ sub: CREATOR, role: 'admin' }])
    expect((await fgaClient.check({ user: `user:${CREATOR}`, relation: 'admin', object: `tenant:${t.id}` })).allowed).toBe(true)

    // reusing the consumed signup session cannot create another tenant
    const reuse = await app.inject({
      method: 'POST', url: '/signup/tenants',
      headers: { host: PLATFORM_HOST, cookie: `${SIGNUP_COOKIE}=${sid}`, 'content-type': 'application/json' },
      payload: { slug: `myws2-${Date.now().toString(36)}` },
    })
    expect(reuse.statusCode).toBe(401)
  })

  it('create-tenant requires a signup session', async () => {
    const res = await app.inject({
      method: 'POST', url: '/signup/tenants',
      headers: { host: PLATFORM_HOST, 'content-type': 'application/json' },
      payload: { slug: 'whatever' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('invalid / reserved workspace slug is rejected', async () => {
    const cb = await app.inject({ method: 'GET', url: await startSignup(), headers: { host: PLATFORM_HOST } })
    const sid = /wks_signup=([^;]+)/.exec(String(cb.headers['set-cookie']))![1]
    const res = await app.inject({
      method: 'POST', url: '/signup/tenants',
      headers: { host: PLATFORM_HOST, cookie: `${SIGNUP_COOKIE}=${sid}`, 'content-type': 'application/json' },
      payload: { slug: 'api' }, // reserved
    })
    expect(res.statusCode).toBe(400)
  })

  // SEPARATION: a signup session is NOT an authz session — it cannot reach tenant
  // resources. onRequest reads only wks_sess; presenting wks_signup to /api gets 401.
  it('a signup session cannot access tenant resources (create-only)', async () => {
    const cb = await app.inject({ method: 'GET', url: await startSignup(), headers: { host: PLATFORM_HOST } })
    const sid = /wks_signup=([^;]+)/.exec(String(cb.headers['set-cookie']))![1]
    const res = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { host: 'dev.localhost', cookie: `${SIGNUP_COOKIE}=${sid}` },
    })
    expect(res.statusCode).toBe(401) // signup session ignored by the member auth path
  })
})
