// Integration — real server via inject. #613 / ADR-198 §3 M8: the deployment ceiling gates the local
// ENDPOINTS, not just the login screen. Before this, removing `local` from LOGIN_METHODS hid the
// password form while POST /auth/local/login kept authenticating — the operator believed the password
// attack surface was closed and it was not. OIDC and SAML start/callback 404 under the same operation,
// which is the contrast that made this a hole rather than a design.
//
// The ceiling is read per call (loginMethodCeiling takes process.env at call time), so ONE app serves
// both worlds: the env is narrowed for the ceiling block and restored after. Every local entrance is
// hit — pinning one endpoint and calling it done is exactly how the hole shipped.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'
import type { FastifyInstance } from 'fastify'

const HOST = 'dev.localhost'
const anon = { host: HOST, origin: `http://${HOST}` }
const H = { host: HOST, authorization: 'Bearer dev-token' }

let app: FastifyInstance
let db: TenantDb
let savedCeiling: string | undefined

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb({ id: 'tenant_dev', slug: 'dev', plan: 'free', isolation: 'logical' } as Tenant)
  savedCeiling = process.env.LOGIN_METHODS
}, 60_000)

afterAll(async () => {
  if (savedCeiling === undefined) delete process.env.LOGIN_METHODS
  else process.env.LOGIN_METHODS = savedCeiling
  await db.release()
  await app.close()
  await pool.end()
}, 60_000)

const noLocal = () => { process.env.LOGIN_METHODS = 'tenant-oidc,platform-oidc,saml' }
const restore = () => { if (savedCeiling === undefined) delete process.env.LOGIN_METHODS; else process.env.LOGIN_METHODS = savedCeiling }

// The uniform not-found the OIDC/SAML surfaces answer under the ceiling (ADR-195 §7): same status,
// same body, so a probe cannot tell "method exists but is off" from "no such thing here".
const UNIFORM = { statusCode: 404, body: JSON.stringify({ error: 'not found' }) }

describe('#613: with local outside the ceiling, every local entrance is the uniform not-found', () => {
  const ENTRANCES: { name: string; hit: () => Promise<{ statusCode: number; body: string }> }[] = [
    { name: 'POST /auth/local/login', hit: () => app.inject({ method: 'POST', url: '/auth/local/login', headers: anon, payload: { identifier: 'a@b.test', password: 'x'.repeat(12) } }) },
    { name: 'POST /auth/local/accept', hit: () => app.inject({ method: 'POST', url: '/auth/local/accept', headers: anon, payload: { token: 'winv_nope', password: 'x'.repeat(12) } }) },
    { name: 'POST /auth/local/reset-request', hit: () => app.inject({ method: 'POST', url: '/auth/local/reset-request', headers: anon, payload: { identifier: 'a@b.test' } }) },
    { name: 'POST /auth/local/reset', hit: () => app.inject({ method: 'POST', url: '/auth/local/reset', headers: anon, payload: { token: 'pwr_nope', password: 'x'.repeat(12) } }) },
    { name: 'POST /auth/local/password', hit: () => app.inject({ method: 'POST', url: '/auth/local/password', headers: H, payload: { currentPassword: 'x', newPassword: 'y'.repeat(12) } }) },
  ]

  it('all five answer the OIDC/SAML 404, and none of them before the change (measured red first)', async () => {
    noLocal()
    try {
      const failures: string[] = []
      for (const e of ENTRANCES) {
        const r = await e.hit()
        if (r.statusCode !== UNIFORM.statusCode || r.body !== UNIFORM.body) {
          failures.push(`${e.name}: ${r.statusCode} ${r.body.slice(0, 80)}`)
        }
      }
      expect(failures, failures.join('\n')).toEqual([])
    } finally {
      restore()
    }
  }, 60_000)

  it('with local back inside the ceiling, the entrances answer as themselves again (non-regression)', async () => {
    const r = await app.inject({ method: 'POST', url: '/auth/local/login', headers: anon, payload: { identifier: 'a@b.test', password: 'x'.repeat(12) } })
    expect(r.statusCode, 'the ordinary refusal, not a 404 — the ceiling gate must not linger').toBe(401)
  }, 60_000)
})
