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
  // #806 / ADR-249: the deployment declares the SHAPE of a workspace address. Without it, self-serve
  // creation is closed — which is its own test below.
  process.env.WKS_TENANT_URL_TEMPLATE = 'http://{slug}.localhost:5180'
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
  for (const k of ['PLATFORM_OIDC_ISSUER', 'PLATFORM_OIDC_CLIENT_ID', 'PLATFORM_OIDC_REDIRECT_URI', 'WKS_TENANT_URL_TEMPLATE']) delete process.env[k]
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

  // #806 / ADR-249: a deployment that cannot say WHERE a new workspace would live does not create
  // one. The owner's ruling (#806) put the refusal here rather than at boot — a single host
  // with a platform IdP has no true template to write, and refusing to start would demand a fiction
  // and stop a server that signs people in today.
  describe('with no workspace-address template', () => {
    const withoutTemplate = async <T>(body: () => Promise<T>): Promise<T> => {
      const saved = process.env.WKS_TENANT_URL_TEMPLATE
      delete process.env.WKS_TENANT_URL_TEMPLATE
      try { return await body() } finally { process.env.WKS_TENANT_URL_TEMPLATE = saved! }
    }

    it('self-serve creation is closed — and leaves NO workspace behind', async () => {
      const cb = await app.inject({ method: 'GET', url: await startSignup(), headers: { host: PLATFORM_HOST } })
      const sid = /wks_signup=([^;]+)/.exec(String(cb.headers['set-cookie']))![1]
      const slug = `closed-${Date.now().toString(36)}`
      const res = await withoutTemplate(() => app.inject({
        method: 'POST', url: '/signup/tenants',
        headers: { host: PLATFORM_HOST, cookie: `${SIGNUP_COOKIE}=${sid}`, 'content-type': 'application/json' },
        payload: { slug },
      }))
      expect(res.statusCode).toBe(404)
      // ⚠️ THE assertion. The reported defect IS "the workspace exists and the address does not", so
      // the status code alone would pass over a refusal that happens after `provisionTenant`.
      const rows = await admin`SELECT id FROM tenants WHERE slug = ${slug}`
      expect(rows.length, 'the refusal happened AFTER the provision — the reported symptom, with a 404 on top').toBe(0)
    })

    it('and the entry points do not walk anybody into a flow that cannot finish', async () => {
      const res = await withoutTemplate(() => app.inject({ method: 'GET', url: '/signup/login', headers: { host: PLATFORM_HOST } }))
      expect(res.statusCode).toBe(404)
    })

    it('but signing in still works, and an existing workspace still serves', async () => {
      // Both halves of the ruling. A pin that only checked the 404 would pass over a change that
      // took the rest of the product down with the door.
      await withoutTemplate(async () => {
        const login = await app.inject({ method: 'GET', url: '/auth/login', headers: { host: 'dev.localhost' } })
        expect(login.statusCode, 'sign-in is not what this closes').not.toBe(404)
        // NOT `/api/spaces`: the `/api` prefix is the dev proxy's, not the server's (measured — that
        // path 404s here for a reason that has nothing to do with this ticket).
        const me = await app.inject({
          method: 'GET', url: '/spaces',
          headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' },
        })
        expect(me.statusCode, 'an existing workspace still serves').toBe(200)
      })
    })

    it('and a server configured this way starts', async () => {
      // The pin that holds the ruling: the previous revision of ADR-249 refused to BOOT here, which
      // would have stopped every deployment that signs people in today, on upgrade.
      const started = await withoutTemplate(() => buildApp())
      try {
        expect(started.hasRoute({ method: 'GET', url: '/auth/login' })).toBe(true)
      } finally {
        await started.close()
      }
    }, 60_000)
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

// #537 B4: signup IS a platform-OIDC login — it used to call loadPlatformOidc() directly and would
// have ignored a ceiling that dropped the method. Both the start AND the callback gate (a state
// minted before the ceiling change must not complete after it).
describe('#537 signup honours the login-method ceiling', () => {
  it('a ceiling without platform-oidc 404s /signup/login and /signup/callback', async () => {
    process.env.LOGIN_METHODS = 'tenant-oidc,saml'
    try {
      const start = await app.inject({ method: 'GET', url: '/signup/login', headers: { host: PLATFORM_HOST } })
      expect(start.statusCode).toBe(404)
      const cb = await app.inject({ method: 'GET', url: '/signup/callback?state=x&code=y', headers: { host: PLATFORM_HOST } })
      expect(cb.statusCode).toBe(404)
      expect(cb.headers['set-cookie']).toBeUndefined()
      // Review finding F: the create step gates too — a pre-ceiling signup session must not
      // complete into a tenant nobody can sign in to (gate sits before the session check).
      const create = await app.inject({ method: 'POST', url: '/signup/tenants', headers: { host: PLATFORM_HOST }, payload: { slug: 'never-lands' } })
      expect(create.statusCode).toBe(404)
    } finally {
      delete process.env.LOGIN_METHODS
    }
  })
})
