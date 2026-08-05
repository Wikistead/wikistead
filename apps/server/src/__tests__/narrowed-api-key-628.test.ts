// Integration — real Postgres + real OpenFGA. #628 / ADR-215 §2: a NARROWED api key is asked, per
// request, whether it may be where it is.
//
// The order of these cases is the order the ADR puts them in. A narrowed key that can mint another key
// has narrowed nothing — it hands the holder one request's worth of work to get everything back — so
// that case comes before any question about which routes a capability opens.
//
// Narrowing is EE. CE gets a seam, and a narrowed key arriving with nothing registered is REFUSED, not
// widened: the only way to hold one on a CE deployment is that the overlay was removed after the key
// was issued, and the one answer that must never happen is "so it becomes an ordinary key again".
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes, createHash } from 'node:crypto'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { registerNarrowedKeyGate, resetNarrowedKeyGate } from '@wikistead/hooks'
import type { FastifyInstance } from 'fastify'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const OWNER = 'dev-user'
const STAMP = Date.now().toString(36)

let app: FastifyInstance

/** Mint a key row directly: the product cannot issue a narrowed key yet (that is the EE half), and the
 *  question here is what the REQUEST PATH does when one arrives. */
async function mintKey(name: string, capabilities: string[] | null): Promise<string> {
  const prefix = randomBytes(6).toString('base64url')
  const plaintext = `wks_${prefix}_${randomBytes(24).toString('base64url')}`
  await admin`
    INSERT INTO api_keys (tenant_id, owner_user_id, name, key_prefix, key_hash, scope, capabilities)
    VALUES (${T}, ${OWNER}, ${`nar628-${name}-${STAMP}`}, ${`wks_${prefix}`},
            ${createHash('sha256').update(plaintext).digest('hex')}, 'write', ${capabilities})`
  return plaintext
}

const call = (token: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { host: 'dev.localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(payload ? { payload } : {}) })

beforeAll(async () => { app = await buildApp(); await app.ready() }, 180_000)
afterAll(async () => {
  resetNarrowedKeyGate()
  await admin`DELETE FROM api_keys WHERE tenant_id = ${T} AND name LIKE ${'nar628-%'}`.catch(() => {})
  await app.close(); await admin.end(); await pool.end()
}, 60_000)

describe('#628 §2: a narrowed key cannot mint another credential — whatever it carries', () => {
  it.each([
    ['POST', '/api-keys', { name: 'x' }],
    ['POST', '/auth/collab-token', { pageId: 'demo' }],
    ['POST', '/share-links', { pageId: 'demo', capability: 'view' }],
  ] as const)('%s %s is refused', async (method, url, payload) => {
    // Given EVERY capability the product has — the point is that no capability opens these.
    registerNarrowedKeyGate(() => true)
    const token = await mintKey(`mint-${url.replace(/\W+/g, '')}`, ['view', 'comment', 'edit', 'publish', 'delete', 'share', 'settings', 'moderate', 'manageAccess'])
    const res = await call(token, method, url, payload)
    expect(res.statusCode, `${method} ${url} — ${res.body}`).toBe(403)
    expect(res.json().code, 'and says which rule stopped it').toBe('narrowed_key')
  }, 120_000)

  it('an UN-narrowed key is not affected — this refuses narrowing, not keys', async () => {
    registerNarrowedKeyGate(() => true)
    const token = await mintKey('plain-mint', null)
    const res = await call(token, 'POST', '/api-keys', { name: `nar628-child-${STAMP}` })
    expect(res.statusCode, `an ordinary key still issues keys — ${res.body}`).toBe(201)
    await admin`DELETE FROM api_keys WHERE name = ${`nar628-child-${STAMP}`}`.catch(() => {})
  }, 120_000)
})

describe('#628 §2: with no EE gate registered, a narrowed key is refused rather than widened', () => {
  it('every route answers 403 — CE does not fall back to the owner\'s full rights', async () => {
    resetNarrowedKeyGate()
    const token = await mintKey('no-gate', ['view'])
    const res = await call(token, 'GET', '/spaces')
    expect(res.statusCode, `a narrowed key with nothing to consult is refused — ${res.body}`).toBe(403)
    expect(res.json().code).toBe('narrowed_key')
  }, 120_000)

  it('…and an UN-narrowed key is untouched by that (the CE default path)', async () => {
    resetNarrowedKeyGate()
    const token = await mintKey('no-gate-plain', null)
    const res = await call(token, 'GET', '/spaces')
    expect(res.statusCode, `an ordinary key on CE works exactly as before — ${res.body}`).toBe(200)
  }, 120_000)
})

describe('#628 §2: the gate decides, and it is asked about the REGISTERED route', () => {
  it('a route the gate allows is reached; one it refuses is not', async () => {
    const seen: { method: string; routePattern: string | undefined }[] = []
    registerNarrowedKeyGate((r) => { seen.push({ method: r.method, routePattern: r.routePattern }); return r.capabilities.includes('view') && r.method === 'GET' })
    const token = await mintKey('gate', ['view'])
    expect((await call(token, 'GET', '/spaces')).statusCode, 'allowed').toBe(200)
    const refused = await call(token, 'POST', '/spaces', { name: `nar628-space-${STAMP}` })
    expect(refused.statusCode, 'refused').toBe(403)
    // The pattern, not the raw URL: a table keyed by raw URLs would miss every route with a parameter.
    await call(token, 'GET', '/pages/demo')
    const withParam = seen.find((s) => s.routePattern?.includes(':'))
    expect(withParam, `the gate is asked about the registered pattern — saw ${JSON.stringify(seen.slice(-4))}`).toBeTruthy()
  }, 120_000)

  it('a key narrowed to NOTHING reaches nothing — [] is not the same as un-narrowed', async () => {
    registerNarrowedKeyGate((r) => r.capabilities.includes('view'))
    const token = await mintKey('empty', [])
    expect((await call(token, 'GET', '/spaces')).statusCode).toBe(403)
  }, 120_000)
})
