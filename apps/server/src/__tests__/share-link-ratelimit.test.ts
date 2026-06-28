// #107 / ADR-026: rate limit on the public share-link exchange. Real Fastify + Valkey
// (app.inject). Two independent fixed-window buckets (per IP, per link id) checked BEFORE the
// lookup, so a 429 is outcome-agnostic — an unknown id is 404 under the limit and 429 over it,
// exactly like a real id, so the limiter never reveals whether an id exists.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { pool } from '../db/pool.js'

let app: FastifyInstance
const H = { host: 'dev.localhost' }
const tokenReq = (id: string, ip: string) =>
  app.inject({ method: 'POST', url: `/public/share-links/${id}/token`, headers: H, remoteAddress: ip })
const clearBuckets = async () => {
  const keys = await app.valkey.keys('rl:slx:*')
  if (keys.length) await app.valkey.del(...keys)
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await clearBuckets() // a prior run's keys may still be inside the 60s window
})
afterAll(async () => {
  await clearBuckets()
  await app.close()
  await pool.end()
})

describe('#107 share-link exchange rate limit', () => {
  it('per-link bucket: the 11th hit to one id is 429 — unknown id is 404 under the limit (no oracle)', async () => {
    const id = 'rl-link-aaaa'
    const codes: number[] = []
    // distinct IPs so the per-IP bucket (30) never trips first — isolate the per-link bucket (10)
    for (let i = 0; i < 11; i++) codes.push((await tokenReq(id, `10.0.0.${i + 1}`)).statusCode)
    expect(codes.slice(0, 10).every((c) => c === 404)).toBe(true) // unknown id → 404 while within the window
    expect(codes[10]).toBe(429) // 11th exceeds the per-link window
  })

  it('429 carries Retry-After', async () => {
    const id = 'rl-link-bbbb'
    let last: Awaited<ReturnType<typeof tokenReq>> | undefined
    for (let i = 0; i < 11; i++) last = await tokenReq(id, `10.0.1.${i + 1}`)
    expect(last!.statusCode).toBe(429)
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('per-IP bucket: the 31st hit from one IP (varied ids) is 429', async () => {
    const ip = '10.9.9.9'
    const codes: number[] = []
    for (let i = 0; i < 31; i++) codes.push((await tokenReq(`rl-ip-${i}`, ip)).statusCode)
    expect(codes.slice(0, 30).every((c) => c === 404)).toBe(true)
    expect(codes[30]).toBe(429)
  })
})
