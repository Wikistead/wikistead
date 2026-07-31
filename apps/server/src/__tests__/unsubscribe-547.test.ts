// #547 / ADR-196 §3 (S3): the emailed unsubscribe. Pinned per the ADR's anti-tests: a tampered /
// expired / wrong-TENANT / wrong-TYP token is a uniform 404; GET alone changes nothing (mail scanners
// prefetch); the RFC 8058 POST flips exactly one pref for exactly one (tenant, member); the digest
// action never touches the immediate pref and vice versa.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { mintUnsubToken, mintGuestToken } from '@wikistead/auth'
import { buildApp } from '../app.js'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const SUB = `unsub-${STAMP}`
const SECRET = process.env.GUEST_TOKEN_SECRET!

let app: FastifyInstance
const cfg = { secret: SECRET, ttlSeconds: 3600 }
const host = { host: 'dev.localhost' }

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await adminPool`INSERT INTO members (tenant_id, sub, display_name, email) VALUES (${TENANT}, ${SUB}, ${SUB}, ${`${SUB}@t.test`})`
}, 60_000)

afterAll(async () => {
  await adminPool`DELETE FROM members WHERE tenant_id = ${TENANT} AND sub = ${SUB}`.catch(() => {})
  await app.close(); await adminPool.end(); await pool.end()
}, 60_000)

const prefs = async () => (await adminPool<{ email_immediate: boolean; email_digest: boolean }[]>`
  SELECT email_immediate, email_digest FROM members WHERE tenant_id = ${TENANT} AND sub = ${SUB}`)[0]!
const get = (token: string) => app.inject({ method: 'GET', url: `/email/unsubscribe?token=${encodeURIComponent(token)}`, headers: host })
const post = (token: string) => app.inject({
  method: 'POST', url: `/email/unsubscribe?token=${encodeURIComponent(token)}`, headers: { ...host, 'content-type': 'application/x-www-form-urlencoded' },
  payload: 'List-Unsubscribe=One-Click', // the RFC 8058 one-click body, verbatim
})

describe('#547 S3: unsubscribe', () => {
  it('GET confirms and changes NOTHING; the RFC 8058 POST flips exactly the named pref', async () => {
    const token = await mintUnsubToken(cfg, { tenantId: TENANT, sub: SUB, action: 'immediate' })
    const page = await get(token)
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('<form method="post"')
    expect((await prefs()).email_immediate, 'a GET (scanner prefetch) never unsubscribes').toBe(true)

    const flip = await post(token)
    expect(flip.statusCode).toBe(200)
    const p = await prefs()
    expect(p.email_immediate, 'the named pref flipped').toBe(false)
    expect(p.email_digest, 'the OTHER pref is untouched').toBe(false) // default, unchanged
  }, 60_000)

  it('the digest action flips only email_digest', async () => {
    await adminPool`UPDATE members SET email_immediate = true, email_digest = true WHERE tenant_id = ${TENANT} AND sub = ${SUB}`
    const token = await mintUnsubToken(cfg, { tenantId: TENANT, sub: SUB, action: 'digest' })
    await post(token)
    const p = await prefs()
    expect(p.email_digest).toBe(false)
    expect(p.email_immediate, 'immediate survives a digest unsubscribe').toBe(true)
  }, 60_000)

  it('tampered / expired / wrong-tenant / wrong-typ tokens are ONE uniform 404, and nothing flips', async () => {
    await adminPool`UPDATE members SET email_immediate = true, email_digest = true WHERE tenant_id = ${TENANT} AND sub = ${SUB}`
    const good = await mintUnsubToken(cfg, { tenantId: TENANT, sub: SUB, action: 'immediate' })
    const tampered = good.slice(0, -4) + 'AAAA'
    const expired = await mintUnsubToken({ secret: SECRET, ttlSeconds: -60 }, { tenantId: TENANT, sub: SUB, action: 'immediate' })
    const wrongTenant = await mintUnsubToken(cfg, { tenantId: 'tenant_acme', sub: SUB, action: 'immediate' })
    // typ confusion: a GUEST token signed with the SAME secret must not open this door
    const wrongTyp = await mintGuestToken({ secret: SECRET, ttlSeconds: 3600 }, {
      tenantId: TENANT, shareLinkId: 'x', resource: { type: 'page', id: 'x' }, capability: 'view',
    })
    for (const bad of [tampered, expired, wrongTenant, wrongTyp, 'garbage']) {
      const g = await get(bad)
      const p = await post(bad)
      expect(g.statusCode, `GET rejects (${bad.slice(0, 12)}…)`).toBe(404)
      expect(p.statusCode, `POST rejects (${bad.slice(0, 12)}…)`).toBe(404)
      expect(g.json()).toEqual({ error: 'not found' }) // uniform — never says which part failed
    }
    const p = await prefs()
    expect(p.email_immediate).toBe(true)
    expect(p.email_digest).toBe(true)
  }, 60_000)
})
