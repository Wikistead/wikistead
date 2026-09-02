// #1038 / #987 / ADR-270 §3.2: tracing is OFF unless an operator names a collector, and ON means one
// span per request with the codebase's own calls as children.
//
// The disabled case is measured by CONNECTION ATTEMPT, not by reading configuration (the ticket's own
// wording): the OTLP exporter defaults to `localhost:4318` when constructed with no URL, so a library
// that quietly constructs one regardless of the environment would be caught by nothing that merely
// checks a flag. The outbound-transport constructors are hooked for the duration of the case and
// anything that tries to reach an OTLP port is recorded.
//
// The enabled case drives the REAL `NodeSDK` construction — through `startTracing`'s exporter seam,
// not a hand-built provider — with an in-memory exporter, so what it reads back is what this wiring
// produces. Exporting to an actual collector over HTTP is measured by `otel-export-1038.test.ts`,
// in its own process: a second SDK cannot replace the global tracer provider the first registered.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { startTracing, withSpan, tracingEnabled, defaultServiceName, serviceNameFor, OTLP_ENDPOINT_ENV, TRACING_DISABLED_LINE } from '../telemetry/tracing.js'

const HOST = 'dev.localhost'
const OTLP_PORTS = new Set([4317, 4318])

/** Record every outbound target the process asks a transport for while `fn` runs. */
async function recordingOutbound(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = []
  const note = (host: unknown, port: unknown) => { seen.push(`${String(host ?? '')}:${String(port ?? '')}`) }
  const origHttp = http.request, origHttps = https.request, origH2 = http2.connect, origNet = net.Socket.prototype.connect
  const asTarget = (a: unknown): { host?: unknown; port?: unknown } => {
    if (typeof a === 'string') { try { const u = new URL(a); return { host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80) } } catch { return {} } }
    if (a instanceof URL) return { host: a.hostname, port: a.port }
    return (a ?? {}) as { host?: unknown; port?: unknown }
  }
  http.request = ((...args: unknown[]) => { const t = asTarget(args[0]); note(t.host, t.port); return origHttp.apply(http, args as never) }) as typeof http.request
  https.request = ((...args: unknown[]) => { const t = asTarget(args[0]); note(t.host, t.port); return origHttps.apply(https, args as never) }) as typeof https.request
  http2.connect = ((...args: unknown[]) => { const t = asTarget(args[0]); note(t.host, t.port); return origH2.apply(http2, args as never) }) as typeof http2.connect
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    // ⚠️ An http.Agent — which is how every OTLP/HTTP export leaves the process — calls this with
    // its arguments already NORMALISED: `args[0]` is an ARRAY `[options]`, not the options object.
    // The first draft of this recorder read `.host` off that array, saw `undefined:undefined` for
    // every exporter connection, and stayed green against the exact defect it exists to catch
    // (review measured it). Unwrap before reading.
    const a = Array.isArray(args[0]) ? args[0][0] : args[0]
    if (typeof a === 'object' && a !== null) note((a as { host?: unknown }).host, (a as { port?: unknown }).port)
    else if (typeof a === 'number') note(args[1], a)
    return origNet.apply(this, args as never)
  } as typeof net.Socket.prototype.connect
  try {
    await fn()
  } finally {
    http.request = origHttp; https.request = origHttps; http2.connect = origH2; net.Socket.prototype.connect = origNet
  }
  return seen
}

describe('#1038 tracing is off unless a collector is named', () => {
  it('reads exactly one variable, and an empty value is "unset"', () => {
    expect(tracingEnabled({})).toBe(false)
    expect(tracingEnabled({ [OTLP_ENDPOINT_ENV]: '  ' })).toBe(false)
    expect(tracingEnabled({ [OTLP_ENDPOINT_ENV]: 'http://tempo:4318' })).toBe(true)
  })

  it("an operator's OTEL_SERVICE_NAME is what the SDK is handed, not overridden by the default", () => {
    // The SDK merges `serviceName` AFTER its environment detectors and lets it win, so the default
    // must only be handed over when the operator has not chosen (measured by review: the first
    // draft handed it over unconditionally and the operator's name lost). `serviceNameFor` is the
    // rule; the export pin drives the real SDK with the variable set and reads the name back.
    expect(serviceNameFor({ OTEL_SERVICE_NAME: 'operator-chosen-name' })).toBe('operator-chosen-name')
    expect(serviceNameFor({ OTEL_SERVICE_NAME: '  ' })).toBe(defaultServiceName())
    expect(serviceNameFor({})).toBe(defaultServiceName())
  })

  it('⚠️ with the endpoint unset, nothing in the process reaches for an OTLP port — measured by connection, not config', async () => {
    // A version of this that started the SDK regardless of the environment exports on the batch
    // processor's schedule — 5 s by default — so a recorder that stopped listening after 300 ms
    // would never have seen it (review measured: nothing at 300 ms, two connects at 6.3 s). The
    // schedule is the SDK's own knob, read from the process environment; shortened here so the
    // window this measures contains the export, and restored after.
    const prevDelay = process.env.OTEL_BSP_SCHEDULE_DELAY
    process.env.OTEL_BSP_SCHEDULE_DELAY = '50'
    const lines: string[] = []
    let app: FastifyInstance | null = null
    let seen: string[]
    try {
      seen = await recordingOutbound(async () => {
        // NOT asserted on: `startTracing`'s return value is the configuration-side answer, and the
        // ADR says the configuration-side answer is not what this measures. The connection list is.
        await startTracing({}, { log: (l) => lines.push(l) })
        app = await buildApp()
        // A request through the whole hook chain, plus a span opened by hand: both are the paths a
        // stray exporter would have been fed by.
        const r = await app.inject({ method: 'GET', url: '/healthz', headers: { host: HOST } })
        expect(r.statusCode).toBe(200)
        await withSpan('wikistead.probe', {}, async () => {})
        await new Promise((r) => setTimeout(r, 600))
      })
    } finally {
      if (prevDelay === undefined) delete process.env.OTEL_BSP_SCHEDULE_DELAY
      else process.env.OTEL_BSP_SCHEDULE_DELAY = prevDelay
    }
    await app!.close()
    const otlp = seen.filter((t) => OTLP_PORTS.has(Number(t.split(':').pop())))
    expect(otlp, `something tried to reach an OTLP port with tracing off: ${otlp.join(', ')}`).toEqual([])
    // Not vacuous, and on the RIGHT path: an exporter leaves through an http.Agent, whose socket
    // connect the recorder must be able to read. `/healthz` opens no outbound socket, so make one
    // the same way an exporter would — a keep-alive Agent, against a port we own — and require the
    // recorder to have read the host AND the port off it, not merely to have been called.
    const srv = http.createServer((_q, s) => s.end('ok')).listen(0, '127.0.0.1')
    await new Promise((r) => srv.once('listening', r))
    const port = (srv.address() as net.AddressInfo).port
    const agent = new http.Agent({ keepAlive: true })
    const probe = await recordingOutbound(async () => {
      await new Promise<void>((done, fail) => http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => { res.resume(); res.on('end', done) }).on('error', fail))
    })
    agent.destroy()
    await new Promise((r) => srv.close(r))
    expect(probe, 'the recorder must read host:port off an Agent-driven connect, the shape an exporter uses').toContain(`127.0.0.1:${port}`)
  })

  it('ships no static import of the SDK — the "not even loaded" claim, pinned where a connection cannot see it', () => {
    // The connection pin above cannot tell "the SDK was loaded and stayed quiet" from "the SDK was
    // never loaded". This can: the only mention of the SDK and exporter packages in shipped code is
    // the dynamic import on the enabled branch of `startTracing`.
    const src = readFileSync(resolve(import.meta.dirname, '../telemetry/tracing.ts'), 'utf8')
    const staticImports = [...src.matchAll(/^import .*@opentelemetry\/(sdk-node|exporter-trace-otlp-http)/gm)]
    expect(staticImports, 'the SDK must not be a static import').toEqual([])
    expect(src, 'and IS loaded on the enabled branch').toMatch(/import\('@opentelemetry\/sdk-node'\)/)
  })

  it('⚠️ and says so once at boot — a silent "off" hides a mistyped variable name', async () => {
    const lines: string[] = []
    await startTracing({ OTEL_EXPORTER_OTLP_ENDPOINTS: 'http://tempo:4318' /* a typo an operator would make */ }, { log: (l) => lines.push(l) })
    expect(lines).toContain(TRACING_DISABLED_LINE)
    expect(TRACING_DISABLED_LINE).toContain(OTLP_ENDPOINT_ENV)
  })

  it('the server entry starts tracing before it builds the app', () => {
    // `startServer` listens and spawns workers, so it is pinned as source: the call must precede
    // `buildApp()` — a span provider registered after the app exists is one the first requests miss.
    const src = readFileSync(resolve(import.meta.dirname, '../server.ts'), 'utf8')
    const start = src.indexOf('await startTracing(process.env)')
    const build = src.indexOf('await buildApp()')
    expect(start, 'startServer must call startTracing').toBeGreaterThan(-1)
    expect(start, 'and call it before buildApp').toBeLessThan(build)
  })

  it('the SIGTERM flush re-raises the signal — a listener alone would cancel Node\'s default exit', () => {
    // Also source-pinned: sending the worker SIGTERM is not something a unit test survives. Nothing
    // else in the process handles SIGTERM (measured at the time of writing), so a listener that
    // flushed and returned would leave the container running until the orchestrator's SIGKILL.
    const src = readFileSync(resolve(import.meta.dirname, '../server.ts'), 'utf8')
    const handler = src.match(/process\.once\('SIGTERM'[\s\S]*?\n\s*\}\)/)?.[0] ?? ''
    expect(handler, 'the tracing flush hangs off SIGTERM').not.toBe('')
    expect(handler, 'and hands the signal back once the flush is done').toMatch(/shutdown\(\)[\s\S]*process\.kill\(process\.pid, 'SIGTERM'\)/)
  })
})

describe('#1038 with a collector named, one span per request and the codebase\'s own calls beneath it', () => {
  let app: FastifyInstance
  let exporter: import('@opentelemetry/sdk-node').tracing.InMemorySpanExporter
  let handle: { shutdown(): Promise<void> } | null

  beforeAll(async () => {
    // The SDK's own in-memory exporter behind a SYNCHRONOUS processor, through the SAME NodeSDK
    // construction and global registration production uses. Synchronous so the spans can be read
    // back without a flush — `InMemorySpanExporter.shutdown()` discards what it holds, so a shutdown
    // cannot be the thing that makes them visible.
    const { tracing } = await import('@opentelemetry/sdk-node')
    exporter = new tracing.InMemorySpanExporter()
    const lines: string[] = []
    handle = await startTracing({ [OTLP_ENDPOINT_ENV]: 'http://127.0.0.1:1' }, { log: (l) => lines.push(l), spanProcessors: [new tracing.SimpleSpanProcessor(exporter)] })
    expect(handle, 'the enabled branch hands back a shutdown').not.toBeNull()
    expect(lines.some((l) => l.includes('[tracing] enabled')), 'the enabled branch says so too').toBe(true)
    app = await buildApp()
  })
  afterAll(async () => {
    await app?.close()
    await handle?.shutdown()
  })

  it('⚠️ a request is one SERVER span named by its route template, with the DB acquire and the FGA checks as children', async () => {
    // The space list: tenant-resolved (so the DB acquire runs) and FGA-filtered (so a check runs),
    // and it needs no fixture page to exist — the seeded demo page is exactly what #969 / #1027
    // measure going missing.
    const r = await app.inject({ method: 'GET', url: '/spaces', headers: { host: HOST, authorization: 'Bearer dev-token' } })
    expect(r.statusCode).toBe(200)
    const spans = exporter.getFinishedSpans()
    const req = spans.find((s) => s.name === 'GET /spaces')
    expect(req, `no request span among: ${spans.map((s) => s.name).join(', ')}`).toBeDefined()
    expect(req!.kind, 'SpanKind.SERVER').toBe(1)
    expect(req!.attributes['http.route']).toBe('/spaces')
    expect(req!.attributes['http.response.status_code']).toBe(200)
    const parentOf = (s: (typeof spans)[number]) => (s as { parentSpanContext?: { spanId: string }; parentSpanId?: string }).parentSpanContext?.spanId ?? (s as { parentSpanId?: string }).parentSpanId
    const db = spans.filter((s) => s.name === 'db.acquire_tenant')
    expect(db.length, 'the tenant DB acquire is a span').toBeGreaterThan(0)
    expect(parentOf(db[0]), 'and it sits UNDER the request span — the parent link is the whole value of a trace').toBe(req!.spanContext().spanId)
    const fga = spans.filter((s) => s.name.startsWith('fga.') && s.spanContext().traceId === req!.spanContext().traceId)
    expect(fga.length, 'the OpenFGA round-trips are spans in the same trace').toBeGreaterThan(0)
    expect(fga[0].kind, 'SpanKind.CLIENT').toBe(2)
  })

  it('⚠️ no span carries a tenant, user, page or space identifier (ADR-270 §3.4, applied to traces)', () => {
    const spans = exporter.getFinishedSpans()
    expect(spans.length).toBeGreaterThan(0)
    // The seeded identifiers this traffic touched, AND any UUID — page and space ids are UUIDs, so a
    // future `setAttribute('space.id', …)` must trip this without anyone re-reading the ADR.
    const forbidden = /tenant_dev|dev-token|(^|[^a-z])demo($|[^a-z])|demo_space|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    // Everything a span can carry text in: name, attributes, status message, and every event's
    // attributes (`recordException` writes the message and stack there — review found the first
    // draft looked at the first two only).
    for (const s of spans) {
      expect(s.name, `span name leaks an identifier`).not.toMatch(forbidden)
      for (const [k, v] of Object.entries(s.attributes)) {
        expect(`${k}=${String(v)}`, `span attribute leaks an identifier on ${s.name}`).not.toMatch(forbidden)
      }
      expect(s.status.message ?? '', `status message leaks an identifier on ${s.name}`).not.toMatch(forbidden)
      for (const ev of s.events) {
        for (const [k, v] of Object.entries(ev.attributes ?? {})) {
          expect(`${k}=${String(v)}`, `event ${ev.name} leaks an identifier on ${s.name}`).not.toMatch(forbidden)
        }
      }
    }
    // The walk is not vacuous: the traffic DID involve identifiers (the tenant, the seeded space),
    // which is what makes their absence from the spans a measurement.
    expect(spans.some((s) => s.name === 'GET /spaces')).toBe(true)
  })

  it('service.name defaults to the product name, lower-cased, plus the component', () => {
    const spans = exporter.getFinishedSpans()
    expect(spans.length).toBeGreaterThan(0)
    const names = new Set(spans.map((s) => String(s.resource.attributes['service.name'])))
    expect([...names]).toEqual([defaultServiceName()])
    expect(defaultServiceName()).toMatch(/-server$/)
  })

  it('a span records the failure it wrapped, and lets it through unchanged', async () => {
    const boom = new Error('deliberate')
    await expect(withSpan('wikistead.failing', {}, async () => { throw boom })).rejects.toBe(boom)
  })
})
