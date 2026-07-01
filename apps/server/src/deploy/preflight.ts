// Pre-launch deploy gate — automated HTTP smoke checks (#148 / ADR-066).
//
// The runbook (docs/runbooks/prelaunch-deploy-gate.md) names "auto-smoke of these checks" as an
// explicit follow-up to the manual gate; this is that auto-smoke for the HTTP-OBSERVABLE rows. It turns
// the mechanical, header/response-level pass criteria (which a human ticking "OK" could rubber-stamp —
// the formalism risk the owner flagged on ADR-066) into re-runnable assertions the operator runs against
// the prod-pre-cutover deployment. Infra rows that need an action rather than an observation (OpenFGA
// restart persistence, SOPS wrong-key boot refusal, ACME mis-issuance, cross-replica rate limiting,
// ydoc-restart survival, reindex, storage round-trip, semantic-release) stay MANUAL in the runbook —
// they are not HTTP-observable and this tool does not pretend to cover them.
//
// The verdict logic is PURE (headers/strings → verdict) so it is unit-tested with distinct good/bad
// values; the CLI just wires fetch() into these functions. No network in the pure layer.

export interface CheckVerdict {
  pass: boolean
  detail: string
}

// A response's header lookup is case-insensitive; normalize to a lowercased map first. Accepts a real
// Headers instance (global fetch) or a plain header object (node / injected test fixtures).
export function lowerHeaders(h: Record<string, string | string[] | undefined> | Headers): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    h.forEach((v, k) => { out[k.toLowerCase()] = v })
    return out
  }
  for (const [k, v] of Object.entries(h as Record<string, string | string[] | undefined>)) {
    if (v == null) continue
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v)
  }
  return out
}

// Row: security headers (ADR-039 / #187). nosniff + Referrer-Policy ALWAYS; HSTS present iff https.
// A proxy-misconfig single point of failure — the app now sets these itself, so this verifies the live
// response actually carries them end-to-end.
export function securityHeadersVerdict(headers: Record<string, string>, isHttps: boolean): CheckVerdict {
  const problems: string[] = []
  if ((headers['x-content-type-options'] || '').toLowerCase() !== 'nosniff') problems.push('missing X-Content-Type-Options: nosniff')
  if (!headers['referrer-policy']) problems.push('missing Referrer-Policy')
  const hsts = !!headers['strict-transport-security']
  if (isHttps && !hsts) problems.push('https response missing Strict-Transport-Security')
  if (!isHttps && hsts) problems.push('non-https response should NOT carry HSTS (misleading)')
  return { pass: problems.length === 0, detail: problems.join('; ') || `nosniff + Referrer-Policy present; HSTS ${isHttps ? 'present' : 'absent'} (correct for ${isHttps ? 'https' : 'http'})` }
}

// Row: session/affinity cookie is HOST-ONLY (ADR-039 #1) — no `Domain=` attribute, so t1's cookie can
// never be replayed at t2 (cross-subdomain leak). Pass = NO Set-Cookie carries a Domain attribute.
export function cookieHostOnlyVerdict(setCookieHeaders: string[]): CheckVerdict {
  const leaky = setCookieHeaders.filter((c) => /;\s*domain=/i.test(c)).map((c) => c.split('=')[0])
  if (setCookieHeaders.length === 0) return { pass: true, detail: 'no Set-Cookie on this response (nothing to leak)' }
  return { pass: leaky.length === 0, detail: leaky.length ? `cookies set a Domain (cross-subdomain leak): ${leaky.join(', ')}` : 'all cookies are host-only (no Domain=)' }
}

// Row: /api 404 stays JSON (404 unification maintained; never falls through to index.html — an SPA
// catch-all would leak existence + break the uniform-404 hiding).
export function notFoundIsJsonVerdict(status: number, contentType: string): CheckVerdict {
  const isJson = /application\/json/i.test(contentType || '')
  const isHtml = /text\/html/i.test(contentType || '')
  return { pass: status === 404 && isJson && !isHtml, detail: `status=${status} content-type=${contentType || '(none)'}${isHtml ? ' — HTML! (SPA catch-all leaked into /api)' : ''}` }
}

// Row: caching posture. /api and /collab must be non-cacheable (dynamic/authz-sensitive); /assets must
// be long-cache (immutable hashed assets). Pass criterion per the deploy-gate description.
export function cacheControlVerdict(pathKind: 'dynamic' | 'assets', cacheControl: string): CheckVerdict {
  const cc = (cacheControl || '').toLowerCase()
  if (pathKind === 'dynamic') {
    const ok = /no-store|no-cache|max-age=0|private/.test(cc)
    return { pass: ok, detail: ok ? `dynamic route is non-cacheable (${cc || 'no header'})` : `dynamic route is cacheable — MUST be no-store/no-cache (got '${cc || 'none'}')` }
  }
  const m = cc.match(/max-age=(\d+)/)
  const longLived = (m ? Number(m[1]) : 0) >= 86400 || /immutable/.test(cc)
  return { pass: longLived, detail: longLived ? `assets are long-cached (${cc})` : `assets not long-cached — expected a large max-age/immutable (got '${cc || 'none'}')` }
}

// Row: noindex for public pages (#124). API layer sets X-Robots-Tag; the crawler-visible public page
// HTML must also carry noindex (proxy-injected or SSR) so search engines don't index published pages
// before the product decides to. Pass = a noindex signal is present in the header OR the initial HTML.
export function noindexVerdict(input: { xRobotsTag?: string; html?: string }): CheckVerdict {
  const header = /noindex/i.test(input.xRobotsTag || '')
  const meta = /<meta[^>]+name=["']robots["'][^>]*noindex/i.test(input.html || '') || /noindex/i.test(input.html?.match(/<meta[^>]+robots[^>]*>/i)?.[0] || '')
  const ok = header || meta
  return { pass: ok, detail: ok ? `noindex present (${header ? 'X-Robots-Tag' : 'meta'})` : 'no noindex in header or initial HTML — crawlers could index public pages' }
}

// ── CLI orchestration (network layer; the pure verdicts above are what's tested) ─────────────────────

export interface PreflightItem { name: string; verdict: CheckVerdict }

// A minimal fetch shape so tests can inject responses without a live server.
export type FetchLike = (url: string, init?: { redirect?: 'manual' | 'follow' | 'error' }) => Promise<{
  status: number
  headers: Headers | Record<string, string | string[] | undefined>
  text: () => Promise<string>
}>

// Run the HTTP-observable rows against a base URL. Each row is best-effort: a network error on one row
// records a fail for that row (not a crash), so the operator sees the full matrix.
export async function runHttpPreflight(baseUrl: string, fetchImpl: FetchLike): Promise<PreflightItem[]> {
  const isHttps = baseUrl.startsWith('https://')
  const base = baseUrl.replace(/\/$/, '')
  const items: PreflightItem[] = []
  const run = async (name: string, fn: () => Promise<CheckVerdict>) => {
    try { items.push({ name, verdict: await fn() }) }
    catch (e) { items.push({ name, verdict: { pass: false, detail: `check errored: ${(e as Error).message}` } }) }
  }

  await run('security-headers', async () => {
    const r = await fetchImpl(`${base}/api/health`)
    return securityHeadersVerdict(lowerHeaders(r.headers), isHttps)
  })
  await run('api-404-json', async () => {
    const r = await fetchImpl(`${base}/api/__preflight_definitely_missing__`)
    return notFoundIsJsonVerdict(r.status, lowerHeaders(r.headers)['content-type'] || '')
  })
  await run('api-no-cache', async () => {
    const r = await fetchImpl(`${base}/api/health`)
    return cacheControlVerdict('dynamic', lowerHeaders(r.headers)['cache-control'] || '')
  })

  return items
}

export function formatReport(items: PreflightItem[]): { text: string; allPass: boolean } {
  const lines = items.map((i) => `${i.verdict.pass ? 'PASS' : 'FAIL'}  ${i.name.padEnd(20)} ${i.verdict.detail}`)
  const allPass = items.every((i) => i.verdict.pass)
  return { text: lines.join('\n'), allPass }
}
