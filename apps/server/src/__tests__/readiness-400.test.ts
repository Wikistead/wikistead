// #400: /readyz pings every hard dependency (DB / OpenFGA / Valkey / search); /healthz stays a
// static liveness ok. The pure matrix (success / failure / timeout) runs on stubs; the HTTP layer
// runs against the real test stack (all deps live → 200 with every flag true).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { checkReadiness } from '../readiness.js'
import { buildApp } from '../app.js'

describe('#400 checkReadiness (pure)', () => {
  it('all pings green → ok with every dep true', async () => {
    const r = await checkReadiness({ a: async () => {}, b: async () => {} })
    expect(r).toEqual({ ok: true, deps: { a: true, b: true } })
  })

  it('a failing ping → ok:false, ONLY that dep false, and the failure is reported to the logger hook', async () => {
    const failed: string[] = []
    const r = await checkReadiness(
      { good: async () => {}, bad: async () => { throw new Error('down') } },
      (dep) => failed.push(dep),
    )
    expect(r).toEqual({ ok: false, deps: { good: true, bad: false } })
    expect(failed).toEqual(['bad'])
  })

  it('a HANGING ping resolves to false via the timeout (never wedges the probe)', async () => {
    const r = await checkReadiness({ hang: () => new Promise(() => {}) }, undefined, 50)
    expect(r).toEqual({ ok: false, deps: { hang: false } })
  })
})

describe('#400 /readyz + /healthz (real stack)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
    await pool.end()
  })

  it('healthz stays a static liveness ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { host: 'dev.localhost' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('readyz reports every dependency ready on the live stack (no internals in the body)', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz', headers: { host: 'dev.localhost' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, deps: { db: true, fga: true, valkey: true, search: true } })
  })
})
