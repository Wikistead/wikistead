// #987 / ADR-270 §3.5 (rev 2: structured error logs only): an unhandled route error produces exactly
// ONE error-level log line, structured (request id, response status, the error with its stack),
// never the request body or headers — and a deliberate 4xx answer is not an error-level line.
//
// ⚠️ Measured on the REAL log stream, not on a swapped `req.log`: the first cut of this pin replaced
// `req.log` in an `onRequest` hook, saw zero error lines, and concluded nothing was logged. Fastify
// logs the error through `reply.log` (the fallback handler that `reply.send(err)` re-enters), which
// that swap never touched — so the "missing" line was a measurement artefact, and the extra line the
// conclusion led to was a duplicate. `buildApp({ logStream })` hands pino a stream this pin can read.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'

const lines: Record<string, unknown>[] = []
const stream = new Writable({
  write(chunk, _enc, cb) {
    for (const l of String(chunk).split('\n')) if (l.trim()) { try { lines.push(JSON.parse(l)) } catch { /* not json */ } }
    cb()
  },
})

let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp({ logStream: stream })
  app.get('/__1039_boom', async () => { throw new Error('kaboom-1039') })
  app.get('/__1039_teapot', async () => { throw Object.assign(new Error('short and stout'), { statusCode: 418 }) })
  await app.ready()
}, 60_000)

afterAll(async () => { await app.close() })

const H = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'x-secret-header': 'do-not-log-me' }
const errorLines = () => lines.filter((l) => l.level === 50)

describe('#987 / ADR-270 §3.5: an unhandled route error is one structured error-level log line', () => {
  it('a thrown 500 logs exactly one error line with the request id, the status and the stack', async () => {
    lines.length = 0
    const res = await app.inject({ method: 'GET', url: '/__1039_boom', headers: H })
    expect(res.statusCode).toBe(500)
    const errs = errorLines()
    expect(errs, JSON.stringify(lines)).toHaveLength(1)
    const line = errs[0]!
    expect(typeof line.reqId).toBe('string')
    expect((line.res as { statusCode?: number })?.statusCode).toBe(500)
    const err = line.err as { message?: string; stack?: string }
    expect(err?.message).toBe('kaboom-1039')
    expect(err?.stack).toContain('kaboom-1039')
    // Never the request's headers or body (PII / secret risk, §3.5).
    const text = JSON.stringify(line)
    expect(text).not.toContain('do-not-log-me')
    expect(text).not.toContain('dev-token')
  })

  it('a deliberate 4xx refusal is not an error-level line (it is an answer, not a failure)', async () => {
    lines.length = 0
    const res = await app.inject({ method: 'GET', url: '/__1039_teapot', headers: H })
    expect(res.statusCode).toBe(418)
    expect(errorLines()).toHaveLength(0)
  })
})
