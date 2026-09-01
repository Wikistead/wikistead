// #987 / ADR-270 §3.1, §3.3, §3.3a: the Prometheus exposition endpoint, on its OWN listener.
//
// Why a second Fastify instance in the same process rather than a route on the tenant app: the tenant
// app's `onRequest` hook enforces session auth on everything outside an explicit URL allowlist, and the
// k8s/Helm ingress publishes `/api/(.*)` from that app to the internet — a `/metrics` route there is
// either session-gated (wrong: a scrape job has no session) or, once allowlisted, reachable by anyone.
// ADR-270 rev 1 pointed at the operator console (`operator/app.ts`) as the sibling plane to mount on;
// rev 3 corrects the premise: that console is a separate process only the Cloud overlay deploys, so a
// self-hoster (the reader §3.6 exists for) would never have it. This listener keeps every property
// the ADR argued for — off the tenant route table, off the ingress (nothing publishes this port),
// token-gated — and runs wherever the API server runs.
//
// The token is a single-purpose shared secret (ruled, #987 §6.3): compared as SHA-256 digests
// with `timingSafeEqual`, the same shape `api-key-auth.ts` uses, so the lengths always match and a
// plain `===` timing side channel never comes back. Unset token → the route is NOT registered (404,
// §6.4) and the listener is not started; the process says so at startup, because a 404 is
// indistinguishable from "wrong token" from the outside and an operator who thinks they configured
// metrics would otherwise never learn otherwise.
import Fastify, { type FastifyInstance } from 'fastify'
import { createHash, timingSafeEqual } from 'node:crypto'
import { Registry, Histogram, Counter, collectDefaultMetrics } from 'prom-client'

/** The process-wide registry every instrument registers on. */
export const metricsRegistry = new Registry()
collectDefaultMetrics({ register: metricsRegistry })

// #1037 / ADR-270 §3.4: the request instruments. Labels are bounded to what is true of the PROCESS —
// the route TEMPLATE (`/pages/:pageId`, never the literal path, which carries an id), the method,
// and the status class. No tenant, user, page or space identifier is ever a label value: a label
// with one value per tenant both grows without bound and tells whoever reads the exposition how
// much traffic each workspace serves. A request that matched no route is `(unmatched)`, so a
// scanner's random paths cannot mint one series each.
const REQUEST_LABELS = ['route', 'method', 'status_class'] as const

export const httpRequestDuration = new Histogram({
  name: 'wikistead_http_request_duration_seconds',
  help: 'Time to answer an HTTP request, by route template, method and status class.',
  labelNames: REQUEST_LABELS,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
})

export const httpRequestsTotal = new Counter({
  name: 'wikistead_http_requests_total',
  help: 'HTTP requests answered, by route template, method and status class.',
  labelNames: REQUEST_LABELS,
  registers: [metricsRegistry],
})

export const UNMATCHED_ROUTE = '(unmatched)'

/** Observe every answered request on `app`. Called once from buildApp; measured by a pin (#1037). */
export function instrumentRequests(app: FastifyInstance): void {
  app.addHook('onResponse', async (req, reply) => {
    const labels = {
      route: req.routeOptions?.url ?? UNMATCHED_ROUTE,
      method: req.method,
      status_class: `${Math.floor(reply.statusCode / 100)}xx`,
    }
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000)
    httpRequestsTotal.inc(labels)
  })
}

export const METRICS_PORT_DEFAULT = 9464

/** Constant-time bearer comparison: both sides hashed so the buffers always have equal length. */
export function bearerMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export interface MetricsAppOpts {
  /** METRICS_TOKEN; empty/undefined means the feature is off and `/metrics` does not exist. */
  token: string | undefined
  registry?: Registry
}

/**
 * The metrics plane. With a token, `GET /metrics` answers the Prometheus text format to a matching
 * bearer and 401 to anything else (a missing header and a non-matching token are the same fact —
 * "not the scrape job" — so they get the same answer, §3.3). Without a token the route is never
 * registered, so the app answers Fastify's plain 404, never 401 and never 200.
 */
export function buildMetricsApp(opts: MetricsAppOpts): FastifyInstance {
  const app = Fastify({ logger: false })
  const registry = opts.registry ?? metricsRegistry
  const token = opts.token?.trim()
  if (!token) return app

  app.get('/metrics', async (req, reply) => {
    const auth = req.headers.authorization
    const presented = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined
    if (!bearerMatches(presented, token)) {
      await reply.code(401).send({})
      return
    }
    reply.type(registry.contentType)
    return registry.metrics()
  })
  return app
}

/**
 * Starts the listener when configured, and NAMES the disabled state when not (the ruling's condition
 * on the 404: the fact has to appear on the side that was configured, i.e. the startup log).
 * Returns the app when listening, null when metrics are disabled.
 */
export async function startMetricsListener(
  // The caller reads `process.env.METRICS_TOKEN` / `METRICS_PORT` itself (server.ts): the env
  // catalogue and the #815 deployment pin both walk for literal `process.env.NAME` reads, and a
  // read hidden behind a parameter would make the variable look unread — and therefore undelivered.
  opts: { token: string | undefined; port: string | number | undefined },
  log: (msg: string) => void,
): Promise<FastifyInstance | null> {
  const token = opts.token?.trim()
  if (!token) {
    log('metrics: disabled — METRICS_TOKEN is unset, so /metrics is not registered and its listener is not started')
    return null
  }
  const port = Number(opts.port ?? METRICS_PORT_DEFAULT)
  const app = buildMetricsApp({ token })
  await app.listen({ port, host: '0.0.0.0' })
  log(`metrics: listening on :${port} (bearer-gated; not published by the ingress)`)
  return app
}
