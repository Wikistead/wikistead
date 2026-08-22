// #878 / #148: every response says whether it may be stored.
//
// The defect this pins was measured on the running deployment, not imagined: `/api/healthz` came back
// with no `Cache-Control` at all, and the deploy gate's `api-no-cache` row failed against it. A missing
// header is not "do not cache" — HTTP lets an intermediary store such a response heuristically, and the
// same posture reaches every authorised response that travels the same path.
//
// ⚠️ The interesting half is the SECOND one. A blanket `no-store` would pass the first assertion and
// silently delete eight deliberate decisions, two of which are `public, max-age=300` — the public page
// bytes, branding, the avatar proxy. So this file asserts both that the default lands and that it never
// overwrites a route that already chose.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const HOST = 'dev.localhost'
let app: FastifyInstance

const cc = (r: { headers: Record<string, unknown> }): string =>
  String(r.headers['cache-control'] ?? '')

beforeAll(async () => { app = await buildApp(); await app.ready() }, 60_000)
afterAll(async () => { await app.close(); await admin.end(); await pool.end() }, 30_000)

describe('#878: a response says whether it may be stored', () => {
  it('a route that chose nothing gets no-store — the case measured on the deployment', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz', headers: { host: HOST } })
    expect(r.statusCode).toBe(200)
    expect(cc(r), 'this exact response had no posture on the running deployment').toBe('no-store')
  })

  it('and so does a refusal, which is where a leak would be worst', async () => {
    // An unauthenticated call to a real route. The body is a refusal, and a refusal cached by an
    // intermediary is served to somebody else — including, on a shared cache, somebody who would have
    // been allowed.
    const r = await app.inject({ method: 'GET', url: '/spaces', headers: { host: HOST } })
    expect(r.statusCode, 'unauthenticated').toBeGreaterThanOrEqual(400)
    expect(cc(r)).toBe('no-store')
  })

  it('⚠️ but a route that DID choose keeps its own answer', async () => {
    // `/pub/...` serves public bytes and deliberately allows a brief shared cache. If the default were
    // an override rather than a fill-in, this would come back `no-store` and the decision would be gone
    // with nothing to show it. Any 4xx here still exercises the hook — what is asserted is that the
    // header the ROUTE set survives, so the case is skipped only if the route never ran.
    const r = await app.inject({ method: 'GET', url: '/pub/robots.txt', headers: { host: HOST } })
    expect(r.statusCode, 'the public shell answered').toBeLessThan(500)
    // public-shell sets `no-store` itself (ruling b), which the default could also have produced —
    // so proving the route's value SURVIVED needs a header the default cannot make. The logo route is
    // that: `public, max-age=300`. ⚠️ `/branding` is a different route (JSON, no posture of its own):
    // aiming at it read as "the default overwrote branding" when it had simply never set one.
    const b = await app.inject({ method: 'GET', url: '/branding/logo', headers: { host: HOST } })
    if (b.statusCode < 400) {
      expect(cc(b), 'a deliberate public posture is not overwritten by the default').toContain('max-age=300')
    } else {
      // No logo in this fixture, so the route returned before its header. Say so rather than passing
      // quietly (#719), and assert the property on the pure function instead of on nothing.
      console.log(`[#878] /branding/logo answered ${b.statusCode} (no logo in this tenant) — the survival half is asserted below`)
      expect(cc(r), 'the public shell chose no-store itself, and it is what came back').toBe('no-store')
    }
  })

  it('⚠️ and the fill-in leaves an explicit header alone, asserted without needing a fixture', async () => {
    // The half above depends on a tenant having a logo. This one does not: a route registered here
    // sets a posture the default cannot produce, and the assertion is that it comes back unchanged.
    // Without this, a fixture with no logo would leave "the default is a fill-in, not an override"
    // resting on a console.log.
    const probe = await buildApp()
    probe.get('/__cache_probe_878', { config: { public: true } }, async (_req, reply) =>
      reply.header('Cache-Control', 'public, max-age=300').send({ ok: true }))
    await probe.ready()
    try {
      const r = await probe.inject({ method: 'GET', url: '/__cache_probe_878', headers: { host: HOST } })
      expect(r.statusCode).toBe(200)
      expect(cc(r)).toBe('public, max-age=300')
    } finally {
      await probe.close()
    }
  })

  it('the header is set once, not appended to', async () => {
    // A hook that appends rather than fills would produce `no-store, no-store` on a route that also
    // set it — valid HTTP, and a sign the fill-in is running where it should not.
    const r = await app.inject({ method: 'GET', url: '/healthz', headers: { host: HOST } })
    expect(cc(r).split(',').length).toBe(1)
  })
})
