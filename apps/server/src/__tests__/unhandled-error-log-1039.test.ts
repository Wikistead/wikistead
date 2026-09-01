// #987 / ADR-270 §3.5 (rev 2: structured error logs only): an unhandled route error produces exactly
// ONE error-level log line with a stable, greppable shape — route template, method, status, request
// id, and the error itself (name / message / stack) — and never the request body or headers. The
// existing OpenFGA-store redaction (#619) keeps running first on the same error object.
//
// Measured through the REAL app and the REAL handler: an `onRequest` hook swaps `req.log` for a
// recorder, a probe route throws, and the recorder is read back — not a source pin, and not a spy on
// `app.log`, which a per-request child logger never reaches.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'

type Call = { level: string; obj: unknown; msg: string | undefined }

function recorder(calls: Call[]) {
  const make = (level: string) => (obj: unknown, msg?: string) => { calls.push({ level, obj, msg: typeof obj === 'string' ? obj : msg }) }
  const log: Record<string, unknown> = {}
  for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']) log[level] = make(level)
  log.child = () => log
  log.level = 'info'
  return log
}

let app: FastifyInstance
const calls: Call[] = []

beforeAll(async () => {
  app = await buildApp()
  app.addHook('onRequest', async (req) => { (req as unknown as { log: unknown }).log = recorder(calls) })
  app.get('/__1039_boom', async () => { throw new Error('kaboom-1039') })
  app.get('/__1039_teapot', async () => { const e = Object.assign(new Error('short and stout'), { statusCode: 418 }); throw e })
  await app.ready()
}, 60_000)

afterAll(async () => { await app.close() })

const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }

describe('#987 / ADR-270 §3.5: an unhandled route error is one structured error-level log line', () => {
  it('a thrown 500 logs exactly one error line, with the stable shape', async () => {
    calls.length = 0
    const res = await app.inject({ method: 'GET', url: '/__1039_boom', headers: { ...H, 'x-secret-header': 'do-not-log-me' } })
    expect(res.statusCode).toBe(500)
    const errors = calls.filter((c) => c.level === 'error')
    expect(errors, JSON.stringify(calls)).toHaveLength(1)
    const [line] = errors
    const obj = line!.obj as Record<string, unknown>
    expect(line!.msg).toBe('unhandled request error')
    expect(obj.route).toBe('/__1039_boom')
    expect(obj.method).toBe('GET')
    expect(obj.status).toBe(500)
    expect(typeof obj.reqId).toBe('string')
    const err = obj.err as { name?: string; message?: string; stack?: string }
    expect(err?.message).toBe('kaboom-1039')
    expect(err?.stack).toContain('kaboom-1039')
    // Never the request's headers or body (PII / secret risk, §3.5).
    expect(JSON.stringify(obj)).not.toContain('do-not-log-me')
    expect(obj).not.toHaveProperty('headers')
    expect(obj).not.toHaveProperty('body')
  })

  it('a deliberate 4xx refusal is not an error log (it is an answer, not a failure)', async () => {
    calls.length = 0
    const res = await app.inject({ method: 'GET', url: '/__1039_teapot', headers: H })
    expect(res.statusCode).toBe(418)
    expect(calls.filter((c) => c.level === 'error')).toHaveLength(0)
  })
})
