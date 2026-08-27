// #989: CORS reflected WHATEVER Origin header a request carried (`{ origin: true }`) — every website on
// the internet passed this app's own CORS check. Fixed to allow only the request's OWN (trustProxy-
// resolved) host, both schemes. A request with no Origin header (server-to-server, curl, same-origin
// navigation) is not a CORS request at all and is unaffected either way.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app.close()
  await app.valkey.quit().catch(() => {})
}, 60_000)

describe('#989: CORS allows only the request\'s own origin', () => {
  it('reflects the SAME-origin Origin (https)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/healthz', headers: { host: 'dev.localhost', origin: 'https://dev.localhost' },
    })
    expect(res.headers['access-control-allow-origin']).toBe('https://dev.localhost')
  })

  it('reflects the SAME-origin Origin (http, for dev)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/healthz', headers: { host: 'dev.localhost', origin: 'http://dev.localhost' },
    })
    expect(res.headers['access-control-allow-origin']).toBe('http://dev.localhost')
  })

  it('⚠️ #989 regression: a THIRD-PARTY origin is refused, not reflected', async () => {
    const res = await app.inject({
      method: 'GET', url: '/healthz', headers: { host: 'dev.localhost', origin: 'https://evil.example' },
    })
    expect(res.headers['access-control-allow-origin'], 'a foreign origin was reflected back').toBeUndefined()
  })

  it('a DIFFERENT tenant host as Origin is refused (cross-tenant is cross-origin here)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/healthz', headers: { host: 'dev.localhost', origin: 'https://acme.localhost' },
    })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('no Origin header at all is not a CORS request — no allow-origin header either way', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { host: 'dev.localhost' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('credentials are not enabled — no Access-Control-Allow-Credentials header', async () => {
    // Stated as a fact this fix relies on (see app.ts's comment): if this ever flips to true, the
    // same-origin-only restriction above stops being defense-in-depth and starts being load-bearing.
    const res = await app.inject({
      method: 'GET', url: '/healthz', headers: { host: 'dev.localhost', origin: 'https://dev.localhost' },
    })
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })
})
