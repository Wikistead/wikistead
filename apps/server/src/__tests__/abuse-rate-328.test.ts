// #328 / ADR-140 increment 2: guest publish rate caps — integration (real Postgres + OpenFGA + Valkey +
// Fastify, no mocks). The load-bearing boundaries:
//   - defaults (NULL caps) never limit and do NO Valkey I/O (the Infinity short-circuit),
//   - the per-SESSION bucket (#331 anon id) trips for one flooding guest but NOT a co-editor on the
//     SAME link (the isolation the ADR mandates),
//   - the per-LINK bucket bounds the whole link across sessions,
//   - members are never capped, and the 429 body is a STATIC reason code (no content/limit echo).
// The shared tenant's caps are ALWAYS reset in afterEach; each test mints its own link/session ids so
// fixed-window buckets never bleed across tests.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import type IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteObjectTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { createSpace } from '../routes/spaces.js'
import { createPage } from '../routes/pages.js'
import { guestPublishRateAllowed, normalizeRateMax } from '../abuse-rate.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 3600 }
const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

let app: FastifyInstance
let db: TenantDb
let spaceId: string, pageId: string

const setCaps = (caps: { linkMax?: number | null; sessionMax?: number | null }) =>
  admin`UPDATE tenant_settings SET abuse_publish_rate_link_max = ${caps.linkMax ?? null}, abuse_publish_rate_session_max = ${caps.sessionMax ?? null} WHERE tenant_id = ${TENANT}`
const resetCaps = () =>
  admin`UPDATE tenant_settings SET abuse_publish_rate_link_max = NULL, abuse_publish_rate_session_max = NULL WHERE tenant_id = ${TENANT}`

// Mint an EDIT share link on the test page + a guest token on it with the given session pseudonym.
async function mkEditLink(): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/share-links', headers: dev, payload: { resource: { type: 'page', id: pageId }, capability: 'edit', expiresInSeconds: null } })
  expect(r.statusCode).toBe(201)
  return (r.json() as { id: string }).id
}
const mkTok = (linkId: string, anonId: string) =>
  mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: linkId, resource: { type: 'page', id: pageId }, capability: 'edit', anonId })
const publish = (token: string) =>
  app.inject({ method: 'POST', url: `/pages/${pageId}/publish`, headers: { host: 'dev.localhost', authorization: `Bearer ${token}` } })
let seq = 0
const anon = () => `anon:${(Date.now() + seq++).toString(16).slice(-12).padStart(12, '0')}`

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await admin`INSERT INTO tenant_settings (tenant_id) VALUES (${TENANT}) ON CONFLICT (tenant_id) DO NOTHING`
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `abrate-${Date.now().toString(36)}` })).id
  pageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'rate' })).id
}, 30_000)

afterEach(async () => { await resetCaps() }) // never leave the shared tenant capped

afterAll(async () => {
  await resetCaps()
  await app.searchDriver.deleteDoc(pageId).catch(() => {})
  await deleteObjectTuples(fgaClient, `page:${pageId}`).catch(() => {})
  await admin`DELETE FROM share_links WHERE resource_id = ${pageId}`.catch(() => {})
  await admin`DELETE FROM revisions WHERE page_id = ${pageId}`.catch(() => {})
  await admin`DELETE FROM search_outbox WHERE page_id = ${pageId}`.catch(() => {})
  await admin`DELETE FROM pages WHERE id = ${pageId}`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${spaceId}`.catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
  await pool.end()
}, 30_000)

describe('guest publish rate caps (#328 / ADR-140 increment 2)', () => {
  it('defaults (NULL caps): repeated guest publishes are never rate-limited', async () => {
    const tok = await mkTok(await mkEditLink(), anon())
    for (let i = 0; i < 3; i++) {
      const r = await publish(tok)
      expect(r.statusCode, r.body).toBe(200) // unchanged draft → publish no-ops, but is never 429
    }
  })

  it('per-session cap trips the flooding session ONLY — a co-editor on the SAME link is unaffected', async () => {
    const link = await mkEditLink()
    const flooder = await mkTok(link, anon())
    const coEditor = await mkTok(link, anon())
    await setCaps({ sessionMax: 2 })
    expect((await publish(flooder)).statusCode).toBe(200)
    expect((await publish(flooder)).statusCode).toBe(200)
    const third = await publish(flooder)
    expect(third.statusCode).toBe(429)
    // the co-editor's own session bucket is fresh — the flooder did not consume the link's budget
    expect((await publish(coEditor)).statusCode).toBe(200)
  })

  it('per-link cap bounds the whole link ACROSS sessions', async () => {
    const link = await mkEditLink()
    const s1 = await mkTok(link, anon())
    const s2 = await mkTok(link, anon())
    await setCaps({ linkMax: 2 })
    expect((await publish(s1)).statusCode).toBe(200)
    expect((await publish(s1)).statusCode).toBe(200)
    expect((await publish(s2)).statusCode).toBe(429) // link budget is shared across sessions
  })

  it('the 429 body is a STATIC reason code only (no content / limit / id echo)', async () => {
    const tok = await mkTok(await mkEditLink(), anon())
    await setCaps({ sessionMax: 1 })
    await publish(tok)
    const r = await publish(tok)
    expect(r.statusCode).toBe(429)
    expect(r.json()).toEqual({ error: 'rate limited', reason: 'publish_rate' })
  })

  it('members are never capped, even with the knobs set', async () => {
    await setCaps({ linkMax: 1, sessionMax: 1 })
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ method: 'POST', url: `/pages/${pageId}/publish`, headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' } })
      expect(r.statusCode, r.body).toBe(200)
    }
  })

  it('zero-overhead default: NULL caps never touch Valkey (Infinity short-circuit)', async () => {
    const poisoned = { incr: () => { throw new Error('valkey must not be touched') } } as unknown as IORedis
    await expect(guestPublishRateAllowed(poisoned, db, { tenantId: TENANT, shareLinkId: 'nolimit', anonId: anon() })).resolves.toBe(true)
  })

  it('normalizeRateMax: NULL/0/negative = unlimited; a positive cap passes through', () => {
    expect(normalizeRateMax(null)).toBe(Infinity)
    expect(normalizeRateMax(undefined)).toBe(Infinity)
    expect(normalizeRateMax(0)).toBe(Infinity)
    expect(normalizeRateMax(-5)).toBe(Infinity)
    expect(normalizeRateMax(7)).toBe(7)
  })
})
