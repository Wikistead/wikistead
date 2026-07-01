// Defense-in-depth security headers on every response (#148 deploy-gate / ADR-039). The SERVER is the
// fortress: these must hold even if the prod proxy is misconfigured. Verified on a real built app via
// inject, with DISTINCT cases (always-on content headers vs HTTPS-only HSTS) so the guard is real.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'

let app: FastifyInstance

beforeAll(async () => { app = await buildApp(); await app.ready() }, 30_000)
afterAll(async () => { await app.close(); await app.valkey.quit().catch(() => {}); await pool.end() }, 30_000)

const get = (headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: '/healthz', headers })

describe('security headers (#148 / ADR-039)', () => {
  it('sets nosniff + Referrer-Policy on every response', async () => {
    const r = await get()
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
  })

  it('sends HSTS only over HTTPS (X-Forwarded-Proto https)', async () => {
    const https = await get({ 'x-forwarded-proto': 'https' })
    expect(https.headers['strict-transport-security']).toMatch(/max-age=\d+/)
    expect(https.headers['strict-transport-security']).toContain('includeSubDomains')
  })

  it('does NOT send HSTS over plain HTTP (no localhost/dev pinning)', async () => {
    const http = await get() // inject default protocol is http, no X-Forwarded-Proto
    expect(http.headers['strict-transport-security']).toBeUndefined()
  })

  it('applies the headers to a 404 too (error/unknown routes)', async () => {
    const r = await app.inject({ method: 'GET', url: '/no-such-route-xyz' })
    expect(r.statusCode).toBe(404)
    expect(r.headers['x-content-type-options']).toBe('nosniff')
  })
})
