// #1095 / the workspace-wide default-language ADMIN WRITE surface. tenantDefaultLang()
// (auth/session.ts) has read this column since #419, but nothing wrote it (0 write paths — the
// ticket's own claim, confirmed by grep). This pins: validation (only a known lang or null),
// admin-gating on BOTH verbs, persistence across a re-GET, and — the part that actually closes
// the reported gap — that the write is visible to tenantDefaultLang() itself (the function every
// mail-locale resolution reads via resolveMailLocale's 2nd-priority slot), not merely to this
// route's own re-GET (a pin that only re-read its own route would miss a write that landed in the
// wrong column or the wrong table).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import { createSession, SESSION_COOKIE, tenantDefaultLang } from '../auth/session.js'
import { fgaClient, deleteTuples } from '@wikistead/authz'
import { memberTuples, ensureMembers } from './helpers/membership.js'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
let db: TenantDb
let app: FastifyInstance
// A PRIVATE tenant: this file's PUT tests write tenant_settings.default_lang directly, and vitest
// runs files concurrently — sharing tenant_dev's row would race any other suite reading/writing it.
let pt: PrivateTenant

beforeAll(async () => {
  pt = await privateTenant(admin, 't1095')
  await admin`INSERT INTO tenant_settings (tenant_id) VALUES (${pt.id}) ON CONFLICT (tenant_id) DO NOTHING`
  db = await acquireTenantDb(asTenant(pt.id))
  app = await buildApp(); await app.ready()
}, 30_000)
afterAll(async () => {
  await app.close(); await db.release(); await valkey.quit()
  await pt.dispose().catch(() => {})
  await admin.end(); await pool.end()
}, 30_000)

const dev = () => ({ authorization: pt.AUTH.authorization }) // dev-user is THIS private tenant's admin
const get = (auth: Record<string, string>) => app.inject({ method: 'GET', url: '/admin/default-lang', headers: { host: pt.H.host, ...auth } })
const put = (body: unknown, auth: Record<string, string>) => app.inject({ method: 'PUT', url: '/admin/default-lang', headers: { host: pt.H.host, 'content-type': 'application/json', ...auth }, payload: JSON.stringify(body) })

describe('GET/PUT /admin/default-lang (#1095)', () => {
  it('reads null before any admin has chosen (the pre-#1095 state)', async () => {
    expect((await get(dev())).json()).toEqual({ defaultLang: null })
  })

  it('rejects an unknown language and leaves the stored value unchanged', async () => {
    const r = await put({ defaultLang: 'fr' }, dev())
    expect(r.statusCode).toBe(400)
    expect((await get(dev())).json()).toEqual({ defaultLang: null })
  })

  it('an admin persists a known language, and tenantDefaultLang() itself sees it', async () => {
    expect((await put({ defaultLang: 'ja' }, dev())).json()).toEqual({ defaultLang: 'ja' })
    expect((await get(dev())).json()).toEqual({ defaultLang: 'ja' })
    // This is the actual bug #1095 reports: a write path that only this route could see would not
    // fix the invite-email symptom. tenantDefaultLang() is the function resolveMailLocale calls.
    expect(await tenantDefaultLang(db)).toBe('ja')
  })

  it('can be cleared back to null (tenantDefaultLang() then falls back to en)', async () => {
    expect((await put({ defaultLang: null }, dev())).json()).toEqual({ defaultLang: null })
    expect((await get(dev())).json()).toEqual({ defaultLang: null })
    expect(await tenantDefaultLang(db)).toBe('en')
  })

  it('a NON-admin member is 403 on both read and write (this is an admin-only knob)', async () => {
    await ensureMembers(pt.id, ['lang1095-nonadmin'])
    const sid = await createSession(valkey, { tenantId: pt.id, sub: 'lang1095-nonadmin' })
    const cookie = { cookie: `${SESSION_COOKIE}=${sid}` }
    expect((await get(cookie)).statusCode).toBe(403)
    expect((await put({ defaultLang: 'ja' }, cookie)).statusCode).toBe(403)
    await deleteTuples(fgaClient, memberTuples(pt.id, ['lang1095-nonadmin'])).catch(() => {})
  })
})
