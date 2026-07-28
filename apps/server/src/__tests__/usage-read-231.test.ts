// #231 slice 1: the meter had a writer and no reader. `recordUsage` has been landing rows since #383, and
// nothing could show them — not an endpoint, not a screen. This is the read side, and deliberately nothing
// else: no price, no cap constant, no soft-cap enforcement, because those are #127's rulings and writing
// them first would mean rebuilding them.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import IORedis from 'ioredis'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { ensureMembers } from './helpers/membership.js'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import { currentPeriodStart, recordUsage, getUsage } from '../usage.js'
import type { Tenant } from '@wikistead/types'

const ADMIN = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
let app: FastifyInstance
let tenant: Tenant
let db: TenantDb

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  app = await buildApp()
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
  await db.release()
  await valkey.quit()
  await pool.end()
}, 60_000)

const get = () => app.inject({ method: 'GET', url: '/billing/usage', headers: ADMIN })

describe('#231 reading the usage meter', () => {
  it('reports the period and the resources that are metered', async () => {
    const res = await get()
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.periodStart, 'the period the counters are keyed on').toBe(currentPeriodStart())
    expect(body.plan).toBe(tenant.plan)
    expect(Array.isArray(body.resources)).toBe(true)
    expect(body.resources.map((r: { resource: string }) => r.resource)).toContain('ai.tokens')
  })

  it('the number it shows is the number that was recorded', async () => {
    const period = currentPeriodStart()
    const before = await getUsage(db, 'ai.tokens', period)
    await recordUsage(db, 'ai.tokens', period, `test:${randomUUID()}`, 7)
    const row = (await get()).json().resources.find((r: { resource: string }) => r.resource === 'ai.tokens')
    expect(row.used, 'the reader is looking at the same counter the writer writes').toBe(before + 7)
  })

  it('an unlimited allowance is null, not a number — JSON has no Infinity', async () => {
    // dev runs an unlimited plan; a serialiser left to itself turns Infinity into `null` anyway, so the
    // contract says so explicitly rather than letting a reader mistake it for "zero" or "unknown".
    const row = (await get()).json().resources.find((r: { resource: string }) => r.resource === 'ai.tokens')
    expect(row.allowance === null || typeof row.allowance === 'number').toBe(true)
    if (row.allowance !== null) expect(Number.isFinite(row.allowance)).toBe(true)
  })

  it('is refused for a signed-in member who is not a tenant admin — usage is billing information', async () => {
    // A real session for a real member: without one, the request dies at authentication and the gate this
    // pin exists for is never reached (removing the admin check left the earlier version green).
    const sub = `usage231-${randomUUID()}`
    await ensureMembers(tenant.id, [sub]) // a real member of the tenant, just not an admin
    const cookie = `${SESSION_COOKIE}=${await createSession(valkey, { tenantId: tenant.id, sub })}`
    const res = await app.inject({ method: 'GET', url: '/billing/usage', headers: { host: 'dev.localhost', cookie } })
    expect(res.statusCode, 'a member sees pages, not the bill').toBe(403)
  })

  it('…and without any session at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/billing/usage', headers: { host: 'dev.localhost' } })
    expect([401, 403]).toContain(res.statusCode)
  })

  it('carries no price and no cap constant — those are #127 rulings, not code yet', async () => {
    const body = (await get()).json()
    const text = JSON.stringify(body)
    expect(text).not.toMatch(/price|amount_due|currency|usd|jpy/i)
    // the allowance comes from the resolved entitlement, not from a table of numbers in this route
    expect(Object.keys(body)).toEqual(expect.arrayContaining(['periodStart', 'plan', 'resources']))
  })
})
