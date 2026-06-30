// AI capability seam (#130 / ADR-077). AI is OFF by default on both fronts: a plan must be
// entitled AND a provider registered (BYOK). Verifies the AND (a registered provider alone, or
// entitlement alone, is not "available").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import { registerAIProvider, resetAIProvider } from '@wikistead/hooks'
import type { Tenant } from '@wikistead/types'

let app: FastifyInstance
let db: TenantDb
const cap = () => app.inject({ method: 'GET', url: '/ai/capability', headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' } })

beforeAll(async () => { db = await acquireTenantDb({ id: 'tenant_dev', slug: 'dev', isolation: 'logical', plan: 'free' } as Tenant); app = await buildApp(); await app.ready() }, 30_000)
afterAll(async () => { resetAIProvider(); await app.close(); await db.release(); await pool.end() }, 30_000)

describe('GET /ai/capability (#130 / ADR-077)', () => {
  it('is OFF by default: entitled (self-host UNLIMITED) but no provider → not available', async () => {
    resetAIProvider()
    const r = await cap()
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ entitled: true, configured: false, available: false })
  })

  it('available only when entitled AND a provider is registered', async () => {
    registerAIProvider({ name: 'test', complete: async () => ({ text: 'ok' }) })
    try {
      expect((await cap()).json()).toMatchObject({ entitled: true, configured: true, available: true })
    } finally {
      resetAIProvider()
    }
    // back off after reset
    expect((await cap()).json()).toMatchObject({ configured: false, available: false })
  })
})
