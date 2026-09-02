// #1038 / ADR-270 §3.2: with OTEL_EXPORTER_OTLP_ENDPOINT set, spans actually LEAVE the process, over
// HTTP, to the address the variable names — the production exporter, not a test double.
//
// Its own file on purpose: `otel-tracing-1038.test.ts` registers an SDK with an in-memory exporter,
// and OpenTelemetry's global tracer provider can be set once per process. Vitest isolates files, so
// this one gets a process in which the real OTLP exporter is the first and only registration.
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { startTracing, withSpan, OTLP_ENDPOINT_ENV } from '../telemetry/tracing.js'

describe('#1038 a named collector receives the spans', () => {
  it('⚠️ the production exporter POSTs OTLP to the endpoint the variable names', { timeout: 30_000 }, async () => {
    const received: { url: string; contentType: string; body: Buffer }[] = []
    const collector = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        received.push({ url: req.url ?? '', contentType: String(req.headers['content-type'] ?? ''), body: Buffer.concat(chunks) })
        res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end()
      })
    }).listen(0, '127.0.0.1')
    await new Promise((r) => collector.once('listening', r))
    const endpoint = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`
    const lines: string[] = []
    // OTEL_SERVICE_NAME is read by the SDK's own environment detector, i.e. from process.env — set
    // there for the duration, so the exported resource is what an operator would get.
    process.env.OTEL_SERVICE_NAME = 'operator-chosen-name'
    let handle: Awaited<ReturnType<typeof startTracing>>
    try {
      handle = await startTracing({ [OTLP_ENDPOINT_ENV]: endpoint, OTEL_SERVICE_NAME: 'operator-chosen-name' }, { log: (l) => lines.push(l) })
    } finally {
      delete process.env.OTEL_SERVICE_NAME
    }
    expect(handle).not.toBeNull()
    expect(lines.some((l) => l.includes(endpoint)), 'the boot line names where spans go').toBe(true)
    await withSpan('wikistead.export_probe', { 'probe': 'yes' }, async () => {})
    await handle!.shutdown() // flush + stop; the BatchSpanProcessor would otherwise wait its schedule
    // The exporter keeps its connection alive; `close()` alone would wait for that idle socket.
    collector.closeAllConnections()
    await new Promise((r) => collector.close(r))
    expect(received.length, 'the collector saw no export at all').toBeGreaterThan(0)
    const traces = received.find((r) => r.url.endsWith('/v1/traces'))
    expect(traces, `exports went to ${received.map((r) => r.url).join(', ')}, not /v1/traces`).toBeDefined()
    expect(traces!.contentType).toMatch(/protobuf|json/)
    // The span name is a UTF-8 string inside the protobuf (or JSON) body either way.
    expect(traces!.body.includes(Buffer.from('wikistead.export_probe')), 'the exported payload does not contain the span').toBe(true)
    // ⚠️ The operator's service name reached the wire — and the default did NOT replace it. The
    // first draft handed `serviceName` to the SDK unconditionally, and the SDK's merge lets that
    // override the environment detector (review measured `operator-chosen-name` → default).
    expect(traces!.body.includes(Buffer.from('operator-chosen-name')), 'OTEL_SERVICE_NAME must be the exported service.name').toBe(true)
    expect(traces!.body.includes(Buffer.from('-server')), 'the default must not be exported alongside the operator\'s choice').toBe(false)
  })
})
