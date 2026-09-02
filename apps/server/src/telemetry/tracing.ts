// #987 / ADR-270 §3.2: OpenTelemetry tracing, OFF unless an operator names a collector.
//
// The shape this file introduces has no precedent in this tree (ADR-270 §3.2 says so explicitly
// after an earlier draft borrowed the wrong analogy): a whole feature that stays fully off — no
// SDK loaded, no exporter constructed, no span recorded — until one environment variable names a
// real endpoint. A self-hoster on modest hardware pays nothing for a signal nobody is reading.
//
// ── How "off" is made a property rather than a hope ─────────────────────────────────────────────
//
// The SDK is imported DYNAMICALLY and only on the enabled branch. `@opentelemetry/sdk-node` pulls
// in dozens of packages at load time; requiring it at the top of this module would make every
// self-host boot pay that cost for nothing, and — the thing the acceptance pin actually measures —
// the OTLP exporter defaults to `localhost:4318` when constructed with no URL, so a design that
// constructed it "just in case" would have every instance in the world knocking on a port nobody
// answers. The disabled branch here touches neither.
//
// What IS always loaded is `@opentelemetry/api`: the vendor-neutral surface every span in this tree
// is written against. With no SDK registered its tracer is a no-op proxy — `startActiveSpan` runs
// the callback and records nothing — which is the documented zero-cost path, and what lets the
// instrumentation below live in the code permanently rather than behind a flag at every call site.
//
// ── What is NOT put on a span ───────────────────────────────────────────────────────────────────
//
// ADR-270 §3.4 forbids tenant / user / page / space identifiers as METRIC labels, for two reasons
// that both apply to span attributes just as well: an operator running several client workspaces on
// one deployment would otherwise read one tenant's traffic through another's trace, and an id-shaped
// attribute is unbounded cardinality for whatever indexes the traces. So request spans carry the
// ROUTE TEMPLATE (`/pages/:id`), method and status; storage spans carry an operation name, never a
// key; FGA spans carry the SDK method, never an object. The rule is the same one, applied to the
// second signal.
import { context, propagation, trace, SpanKind, SpanStatusCode, type Attributes, type Span } from '@opentelemetry/api'
import type { FastifyInstance } from 'fastify'
import { productName } from '../product-name.js'

/** The one variable that turns tracing on. Read here and nowhere else in this tree. */
export const OTLP_ENDPOINT_ENV = 'OTEL_EXPORTER_OTLP_ENDPOINT'

/**
 * Instrumentation-scope name every span in this process is created under — a library identifier,
 * so it names the component, not the product (#575: the product name is read, never written).
 */
export const TRACER_NAME = 'server'

/**
 * The default `service.name`: the product as this deployment calls itself (a rebranded self-host
 * keeps its own name in its own traces), suffixed by the component. OTEL_SERVICE_NAME, if an operator
 * sets it, wins inside the SDK.
 */
export function defaultServiceName(): string {
  return `${productName().toLowerCase().replace(/\s+/g, '-')}-server`
}

/** What `startTracing` says at boot when it stays off — pinned, so a silent "off" cannot ship. */
export const TRACING_DISABLED_LINE = `[tracing] disabled: ${OTLP_ENDPOINT_ENV} is unset — spans are not recorded or exported`

export function tracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Read as a plain property, not through the constant: `scripts/env-catalog.mjs` walks the code for
  // `env.NAME` reads and refuses to document a variable it cannot see being read (ADR-237 §2.2).
  return (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim() !== ''
}

/** Where traces go, per the OTLP exporter spec: the signal-specific URL verbatim, else endpoint + `/v1/traces`. */
export function otlpTracesUrl(env: NodeJS.ProcessEnv): string {
  const specific = (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? '').trim()
  if (specific) return specific
  return `${(env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim().replace(/\/+$/, '')}/v1/traces`
}

export interface TracingHandle {
  /** Flushes what is buffered and stops the exporter. Idempotent. */
  shutdown(): Promise<void>
}

/**
 * Start the SDK — or, with the endpoint unset, do nothing at all and say so once.
 *
 * Returns `null` on the disabled branch so a caller can tell the two apart without re-reading the
 * environment. `spanProcessors` is a test seam: the acceptance pins hand in a synchronous processor
 * over an in-memory exporter and read spans back without a flush, through the SAME `NodeSDK`
 * construction and global registration the production path uses — only the exporter differs, and
 * the production exporter has its own pin against a real collector.
 */
export async function startTracing(
  env: NodeJS.ProcessEnv = process.env,
  opts: { log?: (line: string) => void; spanProcessors?: unknown[] } = {},
): Promise<TracingHandle | null> {
  const log = opts.log ?? ((line: string) => console.log(line))
  if (!tracingEnabled(env) && !opts.spanProcessors) {
    // The condition #987's ruling attached to the metrics 404 applies here for the same reason: a
    // feature that is off is invisible from outside, so the side that was configured — the boot
    // log — is where the fact has to be stated, or an operator who set the wrong variable name
    // never learns that nothing is being exported.
    log(TRACING_DISABLED_LINE)
    return null
  }
  // Loaded here, on this branch only — see the header for why that placement is the feature.
  const [{ NodeSDK }, { OTLPTraceExporter }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
  ])
  // The URL is handed to the exporter explicitly, derived from the `env` THIS function was given.
  // Left to its own devices the exporter reads `process.env` — which is right in production and
  // wrong for anything that hands in an environment of its own, and the acceptance pin that points
  // it at a local collector found it knocking on `localhost:4318` instead. The derivation follows
  // the OTLP spec: the traces-specific variable wins verbatim, otherwise the signal path is appended
  // to the general endpoint. Headers, timeout and OTEL_SERVICE_NAME stay the SDK's own reads.
  type Processors = NonNullable<ConstructorParameters<typeof NodeSDK>[0]>['spanProcessors']
  const sdk = new NodeSDK(
    opts.spanProcessors
      ? { serviceName: defaultServiceName(), spanProcessors: opts.spanProcessors as Processors }
      : { serviceName: defaultServiceName(), traceExporter: new OTLPTraceExporter({ url: otlpTracesUrl(env) }) },
  )
  sdk.start()
  log(`[tracing] enabled: exporting spans to ${opts.spanProcessors ? '(test processor)' : otlpTracesUrl(env)}`)
  let stopped: Promise<void> | null = null
  return {
    shutdown: () => (stopped ??= sdk.shutdown()),
  }
}

/**
 * Run `fn` inside a span. The span is ended whichever way `fn` leaves, and an exception marks it
 * as an error before propagating unchanged — this helper never swallows anything.
 *
 * With no SDK started this is the no-op tracer's `startActiveSpan`: `fn` runs, nothing is recorded.
 */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>, kind: SpanKind = SpanKind.INTERNAL): Promise<T> {
  return trace.getTracer(TRACER_NAME).startActiveSpan(name, { kind, attributes }, async (span) => {
    try {
      return await fn(span)
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) })
      if (e instanceof Error) span.recordException(e)
      throw e
    } finally {
      span.end()
    }
  })
}

declare module 'fastify' {
  interface FastifyRequest {
    /** #987 / ADR-270 §3.2: the span that covers this request, from first hook to last byte. */
    otelSpan?: Span
  }
}

/**
 * One span per request, opened in the FIRST `onRequest` hook and closed in `onResponse`.
 *
 * The parent context is established with `context.with(...)` around Fastify's `done` callback:
 * every later hook and the handler run as continuations started inside that callback, and the
 * SDK's AsyncLocalStorage context manager carries the active span through them — so a `withSpan`
 * in a route body, or in the DB acquire below, parents itself under the request span without being
 * handed it. (This is the same mechanism the upstream Fastify instrumentation relies on; it is
 * pinned here rather than assumed, because the parent link is the whole value of a trace.)
 *
 * The route TEMPLATE is only known after routing, so it is set at response time; a request that
 * never matched a route (a 404) carries its method alone.
 */
export function registerRequestSpans(app: FastifyInstance): void {
  const tracer = trace.getTracer(TRACER_NAME)
  app.addHook('onRequest', (req, _reply, done) => {
    // Honour an inbound W3C `traceparent` from an operator's own reverse proxy or a caller that
    // propagates context — the standard header set is what the SDK's default propagator reads.
    const parent = propagation.extract(context.active(), req.headers)
    const span = tracer.startSpan(
      `${req.method} request`,
      { kind: SpanKind.SERVER, attributes: { 'http.request.method': req.method } },
      parent,
    )
    req.otelSpan = span
    context.with(trace.setSpan(parent, span), done)
  })
  app.addHook('onResponse', async (req, reply) => {
    const span = req.otelSpan
    if (!span) return
    const route = req.routeOptions?.url
    if (route) {
      span.updateName(`${req.method} ${route}`)
      span.setAttribute('http.route', route)
    }
    span.setAttribute('http.response.status_code', reply.statusCode)
    if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR })
    span.end()
  })
  app.addHook('onError', async (req, _reply, err) => {
    req.otelSpan?.recordException(err)
  })
}
