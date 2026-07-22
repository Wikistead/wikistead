// #491 / ADR-140: the tenant-admin abuse-filter config surface. Verifies the server-side normalization
// (the security semantics: an out-of-range shrink ratio is stored as OFF, never a value that reads as on
// but never fires; banned words are trimmed / de-duplicated / capped), the admin round-trip, and — the
// authz-critical part — that a NON-admin member is 403 on BOTH read and write (the banned-word list is
// moderation intelligence, never shown to ordinary members).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { fgaClient, deleteTuples } from '@wikistead/authz'
import { memberTuples, ensureMembers } from './helpers/membership.js'
import { normalizeShrinkRatio, normalizeBannedWords } from '../routes/abuse-config.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const HOST = 'dev.localhost'
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
let db: TenantDb
let app: FastifyInstance

beforeAll(async () => {
  db = await acquireTenantDb(asTenant(TENANT))
  app = await buildApp(); await app.ready()
}, 30_000)
afterAll(async () => {
  await admin`UPDATE tenant_settings SET abuse_shrink_ratio = NULL, abuse_banned_words = '{}' WHERE tenant_id = ${TENANT}`.catch(() => {})
  await app.close(); await db.release(); await valkey.quit(); await admin.end(); await pool.end()
}, 30_000)

const dev = { authorization: 'Bearer dev-token' } // dev-user is tenant_dev admin (seed)
const get = (auth: Record<string, string>) => app.inject({ method: 'GET', url: '/tenant/abuse-filter', headers: { host: HOST, ...auth } })
const patch = (body: unknown, auth: Record<string, string>) => app.inject({ method: 'PATCH', url: '/tenant/abuse-filter', headers: { host: HOST, 'content-type': 'application/json', ...auth }, payload: JSON.stringify(body) })

describe('abuse-filter config normalization (#491)', () => {
  it('clamps the shrink ratio to (0,1], else OFF (null)', () => {
    expect(normalizeShrinkRatio(0.2)).toBe(0.2)
    expect(normalizeShrinkRatio(1)).toBe(1)
    expect(normalizeShrinkRatio(0)).toBeNull()
    expect(normalizeShrinkRatio(1.5)).toBeNull()
    expect(normalizeShrinkRatio(-0.3)).toBeNull()
    expect(normalizeShrinkRatio('0.2')).toBeNull() // a non-number never enables the guard
    expect(normalizeShrinkRatio(null)).toBeNull()
  })
  it('trims, drops empties, de-duplicates (case-insensitively) and caps banned words', () => {
    expect(normalizeBannedWords(['  a  ', 'A', '', '   ', 'b'])).toEqual(['a', 'b'])
    expect(normalizeBannedWords('nope')).toEqual([])
    expect(normalizeBannedWords([1, 'ok', null])).toEqual(['ok'])
    expect(normalizeBannedWords(Array.from({ length: 600 }, (_, i) => `w${i}`)).length).toBe(500)
  })
})

describe('GET/PATCH /tenant/abuse-filter (#491)', () => {
  it('an admin persists a NORMALIZED config and reads it back', async () => {
    const r = await patch({ shrinkRatio: 1.5, bannedWords: ['  Spam ', 'spam', 'badword', ''] }, dev)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ shrinkRatio: null, bannedWords: ['Spam', 'badword'] }) // 1.5→off; trim + case-insensitive dedup + empty drop
    expect((await get(dev)).json()).toEqual({ shrinkRatio: null, bannedWords: ['Spam', 'badword'] })
    // a valid ratio round-trips
    expect((await patch({ shrinkRatio: 0.25, bannedWords: [] }, dev)).json()).toEqual({ shrinkRatio: 0.25, bannedWords: [] })
  })

  it('a NON-admin member is 403 on BOTH read and write (banned words are not member-visible)', async () => {
    await ensureMembers(TENANT, ['abuse491-nonadmin'])
    const sid = await createSession(valkey, { tenantId: TENANT, sub: 'abuse491-nonadmin' })
    const cookie = { cookie: `${SESSION_COOKIE}=${sid}` }
    expect((await get(cookie)).statusCode).toBe(403)
    expect((await patch({ shrinkRatio: 0.5, bannedWords: ['x'] }, cookie)).statusCode).toBe(403)
    await deleteTuples(fgaClient, memberTuples(TENANT, ['abuse491-nonadmin'])).catch(() => {})
  })
})
