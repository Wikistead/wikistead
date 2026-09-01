// #987 / ADR-270 §3.4: request metrics carry the route TEMPLATE, the method and the status class —
// and never a tenant, user, page or space identifier. Measured on the EXPOSITION TEXT after real
// traffic through the real app, not by reading the instrumentation code: a label added next month
// by somebody who never read the ADR shows up here as a UUID in the output.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { metricsRegistry, UNMATCHED_ROUTE } from '../metrics.js'

let app: FastifyInstance
const probeId = randomUUID()
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  // real traffic: a route with an id in its path, a plain route, and a path no route matches
  await app.inject({ method: 'GET', url: `/pages/${probeId}`, headers: H })
  await app.inject({ method: 'GET', url: '/healthz' })
  await app.inject({ method: 'GET', url: `/no-such-route-${probeId}`, headers: H })
}, 60_000)

afterAll(async () => { await app.close() })

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

describe('#987 / ADR-270 §3.4: request metrics are keyed by route template, never by identifier', () => {
  it('the exposition names the template and the status class for the id-carrying route', async () => {
    const text = await metricsRegistry.metrics()
    expect(text).toMatch(/http_server_requests_total\{[^}]*route="\/pages\/:pageId"[^}]*method="GET"[^}]*status_class="[2-5]xx"[^}]*\}/)
    expect(text).toMatch(/http_server_request_duration_seconds_bucket\{[^}]*route="\/pages\/:pageId"/)
    expect(text).toMatch(/route="\/healthz"/)
  })

  it('no label value anywhere is a UUID, the probe id, the host, or the tenant', async () => {
    const text = await metricsRegistry.metrics()
    const labelValues = [...text.matchAll(/\{([^}]*)\}/g)].flatMap((m) => m[1]!.split(',').map((kv) => kv.split('=')[1] ?? ''))
    expect(labelValues.length, 'no labelled series at all — the walk measured nothing').toBeGreaterThan(5)
    for (const v of labelValues) {
      expect(v, `a label value carries an identifier: ${v}`).not.toMatch(UUID)
      expect(v).not.toContain(probeId)
      expect(v).not.toContain('dev.localhost')
    }
    expect(text).not.toContain(probeId)
  })

  it('an unmatched path is one bounded series, not one series per random path', async () => {
    const text = await metricsRegistry.metrics()
    expect(text).toMatch(new RegExp(`route="${UNMATCHED_ROUTE.replace(/[()]/g, '\\$&')}"`))
    expect(text).not.toContain('no-such-route')
  })
})
