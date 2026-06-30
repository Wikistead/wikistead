// AI metering soft-cap end-to-end (#128 / ADR-082, consumer wiring of the usage ledger). /ai/ask
// records the consumed tokens (provider-reported, authoritative) and refuses a NEW billable call once
// the period allowance is reached — BEFORE egress, non-destructively. Real Postgres ledger + RLS db.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import { registerAIProvider, resetAIProvider } from '@wikistead/hooks'
import { onDomainEvent } from '@wikistead/events'
import { registerEntitlementsResolver, resetEntitlementsResolver, UNLIMITED } from '@wikistead/entitlements'
import { setTenantAiEnabled } from '../routes/ai.js'
import { getUsage, currentPeriodStart } from '../usage.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const HOST = 'dev.localhost'
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const PERIOD = currentPeriodStart()
let db: TenantDb, app: FastifyInstance

const ask = (q: string) =>
  app.inject({
    method: 'POST', url: '/ai/ask',
    headers: { host: HOST, 'content-type': 'application/json', authorization: 'Bearer dev-token' },
    payload: JSON.stringify({ question: q }),
  })
const clear = () => admin`DELETE FROM usage_counters WHERE tenant_id = ${TENANT} AND resource = 'ai.tokens' AND period_start = ${PERIOD}`

beforeAll(async () => {
  db = await acquireTenantDb(asTenant(TENANT))
  app = await buildApp(); await app.ready()
  await setTenantAiEnabled(db, TENANT, true)
  await clear()
}, 30_000)
afterAll(async () => {
  resetAIProvider(); resetEntitlementsResolver()
  await setTenantAiEnabled(db, TENANT, false).catch(() => {})
  await clear().catch(() => {})
  await app.close(); await db.release(); await valkey.quit(); await admin.end(); await pool.end()
}, 30_000)

describe('AI metering soft-cap (#128 / ADR-082)', () => {
  it('records provider-reported tokens, then soft-caps (402) at the allowance with NO further recording', async () => {
    registerAIProvider({ name: 'fake', complete: async () => ({ text: 'answer', tokens: 60 }) })
    registerEntitlementsResolver(() => ({ ...UNLIMITED, aiTokenAllowance: 100 }))

    const r1 = await ask('q1')
    expect(r1.statusCode).toBe(200)
    expect(await getUsage(db, 'ai.tokens', PERIOD)).toBe(60) // provider tokens (not the char estimate)

    const r2 = await ask('q2') // usedBefore 60 < 100 → allowed, records → 120
    expect(r2.statusCode).toBe(200)
    expect(await getUsage(db, 'ai.tokens', PERIOD)).toBe(120)

    const r3 = await ask('q3') // usedBefore 120 ≥ 100 → blocked BEFORE egress, non-destructive
    expect(r3.statusCode).toBe(402)
    expect(await getUsage(db, 'ai.tokens', PERIOD)).toBe(120) // unchanged — nothing recorded on a blocked call
  })

  it('self-host UNLIMITED (Infinity allowance) never soft-caps — metering inert', async () => {
    await clear()
    resetEntitlementsResolver() // default UNLIMITED → aiTokenAllowance Infinity
    registerAIProvider({ name: 'fake', complete: async () => ({ text: 'x', tokens: 1_000_000_000 }) })
    const r = await ask('big')
    expect(r.statusCode).toBe(200) // enormous usage, still allowed under an Infinity cap
    expect(await getUsage(db, 'ai.tokens', PERIOD)).toBe(1_000_000_000)
  })

  it('emits usage.threshold_crossed once per threshold as usage advances (alert before the wall)', async () => {
    await clear()
    registerEntitlementsResolver(() => ({ ...UNLIMITED, aiTokenAllowance: 100 }))
    registerAIProvider({ name: 'fake', complete: async () => ({ text: 'a', tokens: 60 }) })
    const seen: Array<{ resource: string; threshold: number }> = []
    const off = onDomainEvent((e) => {
      if (e.type === 'usage.threshold_crossed') seen.push({ resource: e.resource, threshold: e.threshold })
    })
    try {
      expect((await ask('c1')).statusCode).toBe(200) // 0 → 60: below 80% — no alert
      expect(seen).toEqual([])
      expect((await ask('c2')).statusCode).toBe(200) // 60 → 120: crosses 80% then 100%
      expect(seen).toEqual([
        { resource: 'ai.tokens', threshold: 0.8 },
        { resource: 'ai.tokens', threshold: 1.0 },
      ])
    } finally {
      off()
    }
  })

  it('falls back to an estimate when the provider does not report tokens', async () => {
    await clear()
    registerEntitlementsResolver(() => ({ ...UNLIMITED, aiTokenAllowance: Infinity }))
    registerAIProvider({ name: 'fake', complete: async () => ({ text: 'some answer text' }) }) // no tokens
    const r = await ask('estimate me please')
    expect(r.statusCode).toBe(200)
    expect(await getUsage(db, 'ai.tokens', PERIOD)).toBeGreaterThan(0) // estimated, recorded
  })
})
