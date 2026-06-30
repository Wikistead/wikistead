// Integration test — API-key request rate limiting (#175 / ADR-063). Verifies the limiter
// trips at the entitlement-resolved cap (per-key AND per-tenant, stricter wins → 429 + Retry-
// After), and is skipped entirely on the self-host UNLIMITED resolver. Drives the real auth
// hook via inject, with a custom resolver supplying low limits for determinism.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import IORedis from 'ioredis'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import { createApiKey } from '../routes/api-keys.js'
import { UNLIMITED, registerEntitlementsResolver, resetEntitlementsResolver, type Entitlements } from '@wikistead/entitlements'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const TENANT = 'tenant_dev'
const HOST = 'dev.localhost'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
let db: TenantDb, app: FastifyInstance
const bearer = (tok: string) => ({ host: HOST, authorization: `Bearer ${tok}` })
const limits = (perKey: number, perTenant: number): Entitlements => ({ ...UNLIMITED, apiRateLimit: { perKey, perTenant } })
const get = (tok: string) => app.inject({ method: 'GET', url: '/api-keys', headers: bearer(tok) })

beforeAll(async () => { db = await acquireTenantDb(asTenant(TENANT)); app = await buildApp(); await app.ready() }, 30_000)
afterAll(async () => {
  resetEntitlementsResolver()
  await app.close()
  await admin`DELETE FROM api_keys WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release(); await admin.end(); await valkey.quit(); await pool.end()
}, 30_000)
beforeEach(() => resetEntitlementsResolver())

async function freshKey(): Promise<{ id: string; plaintext: string }> {
  const k = await createApiKey(db, { tenantId: TENANT, plan: 'pro', ownerUserId: 'dev-user', name: 'rl', scope: 'read' })
  await valkey.del(`apikey-rl:key:${k.id}`)
  return k
}

describe('API key request rate limiting (#175)', () => {
  it('trips per-key at the entitlement cap → 429 + Retry-After (earlier requests pass)', async () => {
    const k = await freshKey()
    await valkey.del(`apikey-rl:tenant:${TENANT}`)
    registerEntitlementsResolver(() => limits(2, 1000)) // per-key 2; tenant high so per-key trips
    expect((await get(k.plaintext)).statusCode).toBe(200) // 1
    expect((await get(k.plaintext)).statusCode).toBe(200) // 2
    const third = await get(k.plaintext)
    expect(third.statusCode).toBe(429)                    // 3 → over per-key cap
    expect(third.headers['retry-after']).toBeTruthy()
  })

  it('trips per-tenant across multiple keys (the all-keys ceiling)', async () => {
    const a = await freshKey(); const b = await freshKey()
    await valkey.del(`apikey-rl:tenant:${TENANT}`)
    registerEntitlementsResolver(() => limits(1000, 2)) // per-key high; tenant 2 → combined trips
    expect((await get(a.plaintext)).statusCode).toBe(200) // tenant 1 (key a)
    expect((await get(b.plaintext)).statusCode).toBe(200) // tenant 2 (key b)
    expect((await get(a.plaintext)).statusCode).toBe(429) // tenant 3 → over per-tenant cap
  })

  it('self-host UNLIMITED skips the limiter (no 429 under load)', async () => {
    const k = await freshKey()
    await valkey.del(`apikey-rl:tenant:${TENANT}`)
    // default resolver = UNLIMITED (apiRateLimit Infinity) → never limited
    for (let i = 0; i < 8; i++) expect((await get(k.plaintext)).statusCode).toBe(200)
  })
})

// #126 (review rejection): apiAccess must be re-checked on the REQUEST path, not only at key
// creation — a plan downgrade that strips apiAccess has to stop ALREADY-ISSUED keys immediately.
describe('API key apiAccess request-path gate (#126)', () => {
  it('apiAccess:true (default) lets a valid key through (200)', async () => {
    const k = await freshKey()
    await valkey.del(`apikey-rl:tenant:${TENANT}`)
    expect((await get(k.plaintext)).statusCode).toBe(200)
  })

  it('downgraded plan (apiAccess:false) rejects an already-issued key with 403 BEFORE the rate limit (not 429); key row is NOT deleted', async () => {
    const k = await freshKey()
    await valkey.del(`apikey-rl:tenant:${TENANT}`)
    registerEntitlementsResolver(() => ({ ...UNLIMITED, apiAccess: false }))
    const res = await get(k.plaintext)
    expect(res.statusCode).toBe(403)                         // gated, not 200 and not 429
    expect((res.json() as { error: string }).error).toMatch(/not available/i)
    const rows = await admin`SELECT 1 FROM api_keys WHERE id = ${k.id}` // non-destructive (ADR-064)
    expect(rows.length).toBe(1)                              // key survives downgrade → re-upgrade restores
  })

  it('apiAccess 403 and read-only-scope 403 are distinct paths (different messages)', async () => {
    const k = await freshKey() // scope: 'read'
    await valkey.del(`apikey-rl:tenant:${TENANT}`)
    // apiAccess:false on a GET (method allowed for a read key) → apiAccess 403, not the scope path
    registerEntitlementsResolver(() => ({ ...UNLIMITED, apiAccess: false }))
    const denied = await get(k.plaintext)
    expect(denied.statusCode).toBe(403)
    expect((denied.json() as { error: string }).error).toMatch(/not available/i)
    // apiAccess:true + a read key on a WRITE → read-only 403 (scope path runs before apiAccess)
    resetEntitlementsResolver()
    const write = await app.inject({
      method: 'POST', url: '/api-keys',
      headers: { ...bearer(k.plaintext), 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x', scope: 'read' }),
    })
    expect(write.statusCode).toBe(403)
    expect((write.json() as { error: string }).error).toMatch(/read-only/i)
  })
})
