// #987 / ADR-270 §3.3, §3.3a, §5: the Prometheus exposition plane.
//
// Pinned against the REAL metrics app (built and injected), not the source: a missing header and a
// wrong token both 401; the right token answers the text format; with no token the route does not
// exist (404 — never 401, never 200); the disabled state is said out loud at startup; and the tenant
// app never grows a `/metrics` of its own (the ingress publishes that app to the internet).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Registry, Counter } from 'prom-client'
import { buildMetricsApp, startMetricsListener, bearerMatches } from '../metrics.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

function freshRegistry(): Registry {
  const r = new Registry()
  new Counter({ name: 'probe_total', help: 'probe', registers: [r] }).inc()
  return r
}

describe('#987 / ADR-270 §3.3: /metrics is bearer-gated with one valid token', () => {
  const TOKEN = 'scrape-secret-1036'

  it('no Authorization header → 401', async () => {
    const app = buildMetricsApp({ token: TOKEN, registry: freshRegistry() })
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(401)
  })

  it('a non-matching token → 401 (the same fact as a missing one: "not the scrape job")', async () => {
    const app = buildMetricsApp({ token: TOKEN, registry: freshRegistry() })
    const res = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer scrape-secret-1036x' } })
    expect(res.statusCode).toBe(401)
  })

  it('the matching token → 200 in the Prometheus text format', async () => {
    const app = buildMetricsApp({ token: TOKEN, registry: freshRegistry() })
    const res = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${TOKEN}` } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.body).toContain('# HELP probe_total')
    expect(res.body).toContain('probe_total 1')
  })
})

describe('#987 / ADR-270 §6.4: an unset token means the route does not exist', () => {
  it('GET /metrics → 404, never 401 and never 200', async () => {
    for (const token of [undefined, '', '   ']) {
      const app = buildMetricsApp({ token, registry: freshRegistry() })
      const res = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer anything' } })
      expect(res.statusCode, `token=${JSON.stringify(token)}`).toBe(404)
    }
  })

  // The ruling's condition on the 404: the disabled state must be visible on the side that was
  // configured. Measured independently of the 404 above — dropping the log line leaves the 404
  // green and turns only this red.
  it('startup names the disabled state and starts no listener', async () => {
    const lines: string[] = []
    const app = await startMetricsListener({ token: '', port: undefined }, (m) => lines.push(m))
    expect(app).toBeNull()
    expect(lines.some((l) => /metrics: disabled/.test(l) && /METRICS_TOKEN/.test(l)), lines.join('\n')).toBe(true)
  })
})

describe('#987 / ADR-270 §3.3a: the tenant app never carries /metrics', () => {
  // The k8s and Helm ingresses publish `/api/(.*)` from the tenant app to the internet, so a
  // `/metrics` registered there would be reachable token or not. Walk the shipped route sources:
  // the only registration of that path lives in metrics.ts, on its own listener.
  it('no shipped source outside metrics.ts registers a /metrics route', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!/\.ts$/.test(entry.name) || entry.name === 'metrics.ts') continue
        const text = readFileSync(full, 'utf8')
        if (/\.(get|route|all)\s*(<[^>]*>)?\s*\(\s*['"`]\/metrics['"`]/.test(text)) offenders.push(full.slice(SRC.length + 1))
      }
    }
    walk(SRC)
    expect(offenders).toEqual([])
  })

  it('the k8s and Helm ingresses still publish only the API port (the metrics port is never routed)', () => {
    const repo = join(SRC, '../../..')
    let measured = 0
    for (const rel of ['deploy/k8s/base/ingress.yaml', 'charts/wikistead/templates/ingress.yaml']) {
      // #785 / #704: `deploy/` is erased from the public tree, so ask whether the file is there.
      if (!existsSync(join(repo, rel))) continue
      measured++
      const text = readFileSync(join(repo, rel), 'utf8')
      expect(text.includes('9464'), `${rel} routes the metrics port`).toBe(false)
      expect(/metrics/.test(text), `${rel} names the metrics port`).toBe(false)
    }
    // The chart ships in the public tree, so at least one manifest is always measured here.
    expect(measured, 'no ingress manifest was found — a green that checked nothing').toBeGreaterThan(0)
  })
})

describe('#987 / ADR-270 §3.3: the comparison is constant-time', () => {
  it('bearerMatches hashes both sides and compares with timingSafeEqual (mechanism pin)', () => {
    const src = readFileSync(join(SRC, 'metrics.ts'), 'utf8')
    expect(src).toMatch(/timingSafeEqual\(/)
    // A plain `===` on the presented token is the side channel this exists to avoid.
    expect(src).not.toMatch(/presented\s*===\s*/)
    expect(bearerMatches('a', 'a')).toBe(true)
    expect(bearerMatches('a', 'b')).toBe(false)
    expect(bearerMatches(undefined, 'a')).toBe(false)
  })
})
