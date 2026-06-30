// AI tenant-consent toggle (#130 / ADR-077 two-stage egress consent). Verifies the tenant
// half of the consent: capability is OFF by default even when entitled + a provider is
// configured (fail-safe), an admin can enable/disable it, disabling is reflected immediately
// (fresh read = consent revocation), a non-admin cannot toggle, and a bad body is rejected.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { registerAIProvider, resetAIProvider } from '@wikistead/hooks'
import { setTenantAiEnabled } from '../routes/ai.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const HOST = 'dev.localhost'
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
let db: TenantDb, app: FastifyInstance

beforeAll(async () => {
  db = await acquireTenantDb(asTenant(TENANT))
  app = await buildApp(); await app.ready()
  registerAIProvider({ name: 'fake', complete: async () => ({ text: '' }) }) // configured=true
  await setTenantAiEnabled(db, TENANT, false) // known baseline
}, 30_000)
afterAll(async () => {
  resetAIProvider()
  await setTenantAiEnabled(db, TENANT, false).catch(() => {})
  await app.close(); await db.release(); await valkey.quit(); await admin.end(); await pool.end()
}, 30_000)

const cap = () =>
  app.inject({ method: 'GET', url: '/ai/capability', headers: { host: HOST, authorization: 'Bearer dev-token' } }).then((r) => r.json())
const putSettings = (enabled: unknown, auth: Record<string, string>) =>
  app.inject({ method: 'PUT', url: '/admin/ai-settings', headers: { host: HOST, 'content-type': 'application/json', ...auth }, payload: JSON.stringify({ enabled }) })

describe('AI tenant consent toggle (#130 / ADR-077 two-stage consent)', () => {
  it('default opt-in is OFF → not available even when entitled + configured (fail-safe)', async () => {
    await setTenantAiEnabled(db, TENANT, false)
    const c = await cap()
    expect(c.entitled).toBe(true) // UNLIMITED default
    expect(c.configured).toBe(true) // fake provider registered
    expect(c.tenantEnabled).toBe(false)
    expect(c.available).toBe(false) // AND-ed → off until the tenant opts in
  })

  it('admin enabling makes it available; disabling revokes immediately (fresh read)', async () => {
    const auth = { authorization: 'Bearer dev-token' } // dev-user is tenant_dev admin (seed)
    expect((await putSettings(true, auth)).statusCode).toBe(200)
    expect((await cap()).available).toBe(true)
    expect((await putSettings(false, auth)).statusCode).toBe(200)
    expect((await cap()).available).toBe(false) // revocation reflected without cache lag
  })

  it('rejects a non-boolean body (400)', async () => {
    expect((await putSettings('yes', { authorization: 'Bearer dev-token' })).statusCode).toBe(400)
  })

  it('a non-admin member cannot toggle (403)', async () => {
    const sid = await createSession(valkey, { tenantId: TENANT, sub: 'ai-nonadmin-user' })
    const res = await putSettings(true, { cookie: `${SESSION_COOKIE}=${sid}` })
    expect(res.statusCode).toBe(403)
  })
})
