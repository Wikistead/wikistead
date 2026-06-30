// Ask-KB egress perimeter (#130 / ADR-077). /ai/ask is the only AI egress point. Verifies the
// EGRESS GATE: the provider is invoked ONLY when the full two-stage consent passes (entitled
// AND configured AND tenant opted-in). A recording stub proves no egress happens when any gate
// fails (tenant not opted in → 403 and provider NOT called; no provider → 503; unauthenticated
// → 401). The FGA-scoping of the context itself is covered by ai-context.test.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import { registerAIProvider, resetAIProvider } from '@wikistead/hooks'
import { setTenantAiEnabled } from '../routes/ai.js'
import type { Tenant } from '@wikistead/types'

const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const HOST = 'dev.localhost'
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
let db: TenantDb, app: FastifyInstance

// Recording provider: tracks whether (and with what) it was invoked = whether egress happened.
const stub = { called: false, lastContext: undefined as string | undefined }
const recordingProvider = {
  name: 'recording',
  complete: async (input: { prompt: string; context?: string }) => {
    stub.called = true
    stub.lastContext = input.context
    return { text: 'stub-answer' }
  },
}

beforeAll(async () => {
  db = await acquireTenantDb(asTenant(TENANT))
  app = await buildApp(); await app.ready()
  await valkey.del(`ai-rl:tenant:${TENANT}`) // deterministic rate bucket
  registerAIProvider(recordingProvider)
  await setTenantAiEnabled(db, TENANT, false)
}, 30_000)
afterAll(async () => {
  resetAIProvider()
  await setTenantAiEnabled(db, TENANT, false).catch(() => {})
  await app.close(); await db.release(); await valkey.quit(); await pool.end()
}, 30_000)

const ask = (body: unknown, auth = true) =>
  app.inject({ method: 'POST', url: '/ai/ask', headers: { host: HOST, 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer dev-token' } : {}) }, payload: JSON.stringify(body) })

describe('POST /ai/ask egress perimeter (#130 / ADR-077)', () => {
  it('tenant NOT opted in → 403 and the provider is NEVER called (no egress)', async () => {
    stub.called = false
    await setTenantAiEnabled(db, TENANT, false)
    const res = await ask({ question: 'what is X?' })
    expect(res.statusCode).toBe(403)
    expect(stub.called).toBe(false) // the egress gate held — nothing left the system
  })

  it('all gates pass (entitled+configured+opted-in) → 200, answer, provider invoked', async () => {
    stub.called = false
    await setTenantAiEnabled(db, TENANT, true)
    const res = await ask({ question: 'what is X?' })
    expect(res.statusCode).toBe(200)
    expect(res.json().answer).toBe('stub-answer')
    expect(stub.called).toBe(true) // egress happened only after full consent
    expect(typeof stub.lastContext).toBe('string') // context was assembled (FGA-scoped upstream)
  })

  it('no provider registered → 503, no egress', async () => {
    await setTenantAiEnabled(db, TENANT, true)
    resetAIProvider()
    try {
      stub.called = false
      const res = await ask({ question: 'x' })
      expect(res.statusCode).toBe(503)
      expect(stub.called).toBe(false)
    } finally {
      registerAIProvider(recordingProvider)
    }
  })

  it('empty question → 400; unauthenticated → 401 (no anon egress)', async () => {
    await setTenantAiEnabled(db, TENANT, true)
    expect((await ask({ question: '   ' })).statusCode).toBe(400)
    expect((await ask({ question: 'x' }, false)).statusCode).toBe(401)
  })
})
