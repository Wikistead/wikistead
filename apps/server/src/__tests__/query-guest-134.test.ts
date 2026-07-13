// #324 / ADR-134 Hole A rev2: `GET /pages/:id/query` is MEMBER-ONLY. The route omits `config.guest`, so a
// share_link (guest) token is rejected — a guest NEVER triggers a live reverse-lookup (the anonymous/public
// surface renders the static snapshot instead, ②b). A member (dev-token) succeeds. Real Postgres + OpenFGA +
// Fastify against the seeded demo page.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { mintGuestToken } from '@wikistead/auth'
import { buildApp } from '../app.js'

const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 }
let app: FastifyInstance
let guestTok: string
const MEMBER = { host: 'dev.localhost', authorization: 'Bearer dev-token' }

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  // A page-bound VIEW guest token for the seeded demo page (whatever its grants — the route rejects it before
  // any FGA check because it is not guest-capable, which is the property under test).
  guestTok = await mintGuestToken(guestCfg, { tenantId: 'tenant_dev', shareLinkId: 'demo_view_perm', resource: { type: 'page', id: 'demo' }, capability: 'view' })
}, 30_000)

afterAll(async () => {
  await app.close()
}, 30_000)

describe('#324 :::query route is member-only (Hole A rev2)', () => {
  it('a member resolves the query list (200)', async () => {
    const res = await app.inject({ method: 'GET', url: '/pages/demo/query?spec=backlinks', headers: MEMBER })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })

  it('an unrecognised spec is an empty list, never an error (the body is authoring free-text)', async () => {
    const res = await app.inject({ method: 'GET', url: '/pages/demo/query?spec=' + encodeURIComponent('not a real spec'), headers: MEMBER })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('a share_link (guest) token is REJECTED — no live reverse-lookup for a guest', async () => {
    const res = await app.inject({ method: 'GET', url: '/pages/demo/query?spec=backlinks', headers: { host: 'dev.localhost', authorization: `Bearer ${guestTok}` } })
    expect(res.statusCode).toBeGreaterThanOrEqual(401)
    expect(res.statusCode).toBeLessThan(500) // a clean auth rejection, not a crash
    expect(res.statusCode).not.toBe(200)
  })
})
