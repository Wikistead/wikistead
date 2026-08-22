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
  // A row the run could not observe (the operator did not supply the probe it needs). NOT a pass:
  // this gate blocks a release, and "I did not look" must never print like "I looked and it was fine".
  skipped?: boolean
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

// Set-Cookie is the one header that legitimately repeats, so `lowerHeaders` (which joins with ', ')
// mangles it — a joined pair reads as one cookie and a `Domain=` on the second could be attributed to
// the first. Read it as a LIST: fetch's Headers exposes getSetCookie(), and injected/plain objects may
// carry an array. Returns [] when the response set none.
export function setCookiesFrom(h: Record<string, string | string[] | undefined> | Headers): string[] {
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    const anyH = h as Headers & { getSetCookie?: () => string[] }
    if (typeof anyH.getSetCookie === 'function') return anyH.getSetCookie()
    const one = h.get('set-cookie')
    return one ? [one] : []
  }
  for (const [k, v] of Object.entries(h as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() !== 'set-cookie' || v == null) continue
    return Array.isArray(v) ? v : [String(v)]
  }
  return []
}

// The first same-origin `/assets/...` reference in the served HTML. The asset filenames are hashed, so
// the cache row cannot probe a fixed path — it has to learn one from the document the browser reads.
export function firstAssetPath(html: string): string | undefined {
  const m = html.match(/(?:src|href)=["'](\/assets\/[^"']+)["']/i)
  return m?.[1]
}

// The Referrer-Policy tokens a browser recognises. Anything else leaves the header unrecognised, and
// the browser silently applies its own default — so a header carrying only unknown tokens protects
// exactly as much as no header at all, while reading like a configured one.
const REFERRER_POLICY_TOKENS = new Set([
  'no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin',
  'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url',
])

// The two tokens that send the FULL URL to a cross-origin destination. That is the leak that matters
// here specifically: this product puts page ids and share tokens in the path, so a full-URL referrer
// hands a third-party origin the address of a document it was never granted. The other tokens stop at
// the origin or below. (`origin-when-cross-origin` sends the full URL only same-origin — not a leak.)
const FULL_URL_REFERRER_POLICIES = new Set(['unsafe-url', 'no-referrer-when-downgrade'])

// A comma-separated Referrer-Policy is legal; the browser uses the LAST token it recognises, so that
// is the one to judge. Returns undefined when the header names no recognised token at all.
export function effectiveReferrerPolicy(value: string): string | undefined {
  const known = value.split(',').map((t) => t.trim().toLowerCase()).filter((t) => REFERRER_POLICY_TOKENS.has(t))
  return known.length ? known[known.length - 1] : undefined
}

// One day. Anything shorter expires between two visits, so it is a header rather than a protection.
export const HSTS_MIN_MAX_AGE = 86400

// Row: security headers (ADR-039 / #187). nosniff + Referrer-Policy ALWAYS; HSTS present iff https.
// A proxy-misconfig single point of failure — the app now sets these itself, so this verifies the live
// response actually carries them end-to-end.
//
// #879: these used to be PRESENCE checks, which let two settings through that switch the protection OFF
// while still printing as configured — `Strict-Transport-Security: max-age=0` (tells the browser to
// FORGET the pin) and `Referrer-Policy: unsafe-url` (sends the full URL, ids and all, to third parties).
// A gate whose whole job is to block a release must not certify the very misconfiguration it names.
export function securityHeadersVerdict(headers: Record<string, string>, isHttps: boolean): CheckVerdict {
  const problems: string[] = []
  if ((headers['x-content-type-options'] || '').toLowerCase() !== 'nosniff') problems.push('missing X-Content-Type-Options: nosniff')

  const rpRaw = headers['referrer-policy']
  if (!rpRaw) problems.push('missing Referrer-Policy')
  else {
    const rp = effectiveReferrerPolicy(rpRaw)
    if (!rp) problems.push(`Referrer-Policy '${rpRaw}' names no recognised token — the browser falls back to its own default`)
    else if (FULL_URL_REFERRER_POLICIES.has(rp)) problems.push(`Referrer-Policy '${rp}' sends the FULL URL cross-origin — page ids and share tokens live in the path`)
  }

  const hstsRaw = headers['strict-transport-security']
  if (isHttps && !hstsRaw) problems.push('https response missing Strict-Transport-Security')
  if (!isHttps && hstsRaw) problems.push('non-https response should NOT carry HSTS (misleading)')
  if (isHttps && hstsRaw) {
    const m = hstsRaw.match(/max-age\s*=\s*"?(\d+)"?/i)
    if (!m) problems.push(`Strict-Transport-Security '${hstsRaw}' has no max-age — the directive is required, so the header does nothing`)
    else {
      const age = Number(m[1])
      // max-age=0 is not a weak pin, it is the documented way to REVOKE one.
      if (age === 0) problems.push('Strict-Transport-Security max-age=0 DISABLES HSTS (tells the browser to forget the pin)')
      // Below a day a returning visitor is usually unpinned again, so the header is not protection.
      // Every first-party config ships max-age=31536000 (app.ts, deploy/caddy/Caddyfile).
      else if (age < HSTS_MIN_MAX_AGE) problems.push(`Strict-Transport-Security max-age=${age} is below ${HSTS_MIN_MAX_AGE}s — too short to protect a returning visitor`)
      // Sessions live on tenant subdomains (t1.<host>), so a pin on the apex alone protects nobody
      // where the product actually runs. This is a tenancy requirement, not a generic hardening wish.
      if (!/includesubdomains/i.test(hstsRaw)) problems.push('Strict-Transport-Security lacks includeSubDomains — tenant subdomains carry the sessions')
    }
  }

  return { pass: problems.length === 0, detail: problems.join('; ') || `nosniff + Referrer-Policy '${effectiveReferrerPolicy(headers['referrer-policy'] || '')}' present; HSTS ${isHttps ? `present (${headers['strict-transport-security']})` : 'absent'} (correct for ${isHttps ? 'https' : 'http'})` }
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

// The cookies this product issues. Every one of them carries authority — the session itself
// (`wks_sess`), the second-factor step (`wks_factor`) and the half-finished signup (`wks_signup`) —
// so every one has to be unreadable to script and unavailable over plain http.
//
// A PREFIX rather than a list of three: a fourth `wks_` cookie is judged the day it is written, which
// is the day it would otherwise ship unguarded. Cookies this product did not set are deliberately out
// of scope here — the load balancer's affinity cookie is a routing hint, not a credential, and failing
// a deployment over it would teach the operator to ignore this row.
//
// ⚠️ the prefix was the whole rule, and the tree already had a counter-example — `mcp_flow`
// (`routes/mcp-oauth-flow.ts`) binds an OAuth authorize to the browser that started it, which is
// squarely a credential and was judged by nothing. The naming convention is not a guarantee, so the
// names that do not follow it are listed, and `cookie-names-judged-884.test.ts` walks the tree to
// keep the list honest instead of trusting the next author to remember this comment.
const OWN_COOKIE_PREFIX = 'wks_'
export const OWN_COOKIES_OUTSIDE_THE_PREFIX = ['mcp_flow'] as const

export function isOwnCookie(name: string): boolean {
  return name.startsWith(OWN_COOKIE_PREFIX) || (OWN_COOKIES_OUTSIDE_THE_PREFIX as readonly string[]).includes(name)
}

/** The name of a Set-Cookie line, e.g. `wks_sess=abc; Path=/` → `wks_sess`. */
function cookieName(line: string): string {
  return (line.split('=')[0] ?? '').trim()
}

// Row: our own cookies are HttpOnly, and Secure wherever the run is https (ADR-039 / #884).
//
// #879 found the header rows judging presence rather than value; this is the same gap one row over.
// The cookie row asked only whether a `Domain=` was present, so a session cookie readable by any
// script, or one that travels over plain http, passed the gate that exists to stop exactly that.
//
// ⚠️ `Secure` is required only on an https run. Demanding it over http would redden every plaintext
// evaluation stack, and a gate an operator learns to skip protects nothing.
export function cookieAttributesVerdict(setCookieHeaders: string[], isHttps: boolean): CheckVerdict {
  const ours = setCookieHeaders.filter((c) => isOwnCookie(cookieName(c)))
  if (ours.length === 0) {
    // NOT a pass. The run saw cookies but none of ours, so it has no evidence either way — and this
    // gate blocks a release, where "I did not look" must never print like "I looked and it was fine".
    return { pass: false, skipped: true, detail: `no ${OWN_COOKIE_PREFIX}* cookie observed — sign in and re-run with --set-cookie "<the Set-Cookie line>"` }
  }
  const problems: string[] = []
  for (const line of ours) {
    const name = cookieName(line)
    if (!/;\s*httponly\b/i.test(line)) problems.push(`${name} is missing HttpOnly (any script on the page can read the session)`)
    if (isHttps && !/;\s*secure\b/i.test(line)) problems.push(`${name} is missing Secure (it would travel over plain http)`)
  }
  return {
    pass: problems.length === 0,
    detail: problems.join('; ') || `${ours.length} ${OWN_COOKIE_PREFIX}* cookie(s) are HttpOnly${isHttps ? ' and Secure' : ' (Secure not required over http)'}`,
  }
}

// Row: the API is REACHABLE through the edge (#724 / ADR-231). Every other /api row here answers
// a question about a response's shape, and a fully broken edge answers all of them correctly: the
// 404-JSON row in particular PASSES when nothing routes to the server at all, because a stack that
// never strips /api returns exactly a JSON 404. So one row has to ask whether a real endpoint
// answers, or the gate certifies the break it exists to catch.
export function apiReachableVerdict(status: number, contentType: string, body: string): CheckVerdict {
  const isHtml = /text\/html/i.test(contentType || '') || /^\s*<!doctype html/i.test(body)
  if (isHtml) return { pass: false, detail: `the SPA answered (status=${status}) — /api is not reaching the server; the edge is not stripping the prefix, or has no rule for it` }
  return { pass: status === 200, detail: status === 200 ? 'a real API endpoint answered through the edge' : `status=${status} content-type=${contentType || '(none)'}` }
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

export interface PreflightOptions {
  // A published page that the tenant marked noindex. The header is per-page (routes/public.ts), so this
  // row cannot be probed from a fixed path — the operator names one.
  publicPageUrl?: string
  // Set-Cookie lines the operator captured from a REAL sign-in response. The session cookie is only
  // issued to an authenticated callback, so the run cannot obtain one itself; taking it as input keeps
  // the mechanical half of the ADR-039 row (does any cookie carry Domain=?) off the operator's eyeballs.
  // The t1→t2 replay half stays manual — it needs a second host and a live session.
  setCookies?: string[]
}

// Run the HTTP-observable rows against a base URL. Each row is best-effort: a network error on one row
// records a fail for that row (not a crash), so the operator sees the full matrix.
export async function runHttpPreflight(
  baseUrl: string,
  fetchImpl: FetchLike,
  opts: PreflightOptions = {},
): Promise<PreflightItem[]> {
  const isHttps = baseUrl.startsWith('https://')
  const base = baseUrl.replace(/\/$/, '')
  const items: PreflightItem[] = []
  // Every cookie this run saw, from any response. A deployment that sets a Domain= cookie on an
  // unauthenticated route leaks just as widely as one that does it at sign-in, so watch them all.
  const observedCookies: string[] = []
  const run = async (name: string, fn: () => Promise<CheckVerdict>) => {
    try { items.push({ name, verdict: await fn() }) }
    catch (e) { items.push({ name, verdict: { pass: false, detail: `check errored: ${(e as Error).message}` } }) }
  }
  const get: FetchLike = async (url, init) => {
    const r = await fetchImpl(url, init)
    observedCookies.push(...setCookiesFrom(r.headers))
    return r
  }

  // /healthz is the route that EXISTS (app.ts). These rows used to probe /api/health, which the
  // server has never served — so they were reading a 404's headers and calling it a posture check.
  await run('security-headers', async () => {
    const r = await get(`${base}/api/healthz`)
    return securityHeadersVerdict(lowerHeaders(r.headers), isHttps)
  })
  // #879: the row above reads an API response, and the APPLICATION sets those headers itself
  // (app.ts). So it stays green even when the edge sets none — while the response the browser
  // actually loads, and the one that establishes its HSTS pin, is the SPA document, served by a
  // different container (apps/web/nginx.conf) through the edge. Measure the shipped document too,
  // or the row certifies a posture nothing in the browser's path ever had.
  await run('document-security-headers', async () => {
    const r = await get(`${base}/`)
    return securityHeadersVerdict(lowerHeaders(r.headers), isHttps)
  })
  await run('api-reachable', async () => {
    const r = await get(`${base}/api/healthz`)
    return apiReachableVerdict(r.status, lowerHeaders(r.headers)['content-type'] || '', await r.text())
  })
  await run('api-404-json', async () => {
    const r = await get(`${base}/api/__preflight_definitely_missing__`)
    return notFoundIsJsonVerdict(r.status, lowerHeaders(r.headers)['content-type'] || '')
  })
  await run('api-no-cache', async () => {
    const r = await get(`${base}/api/healthz`)
    return cacheControlVerdict('dynamic', lowerHeaders(r.headers)['cache-control'] || '')
  })

  // Assets are hashed, so learn a real one from the served document rather than guessing a path.
  await run('assets-long-cache', async () => {
    const root = await get(`${base}/`)
    const asset = firstAssetPath(await root.text())
    if (!asset) return { pass: false, skipped: true, detail: 'no /assets/ reference in the served HTML — check the cache posture of a hashed asset by hand' }
    const r = await get(`${base}${asset}`)
    return cacheControlVerdict('assets', lowerHeaders(r.headers)['cache-control'] || '')
  })

  // ADR-039 row, mechanical half. Runs LAST so it sees the cookies every earlier row provoked.
  await run('cookie-host-only', async () => {
    const cookies = [...(opts.setCookies ?? []), ...observedCookies]
    if (cookies.length === 0) {
      return { pass: false, skipped: true, detail: 'no Set-Cookie observed — sign in and re-run with --set-cookie "<the Set-Cookie line>" (the t1→t2 replay half stays manual)' }
    }
    const v = cookieHostOnlyVerdict(cookies)
    return { ...v, detail: `${v.detail} [${cookies.length} cookie(s); replay at a second tenant host is still manual]` }
  })

  // #884: the row above asks where a cookie may be SENT; this one asks who may read it and over what.
  // Same evidence, separate verdicts, because a deployment can fail one and pass the other and the
  // operator has to know which.
  await run('session-cookie-attributes', async () => {
    const cookies = [...(opts.setCookies ?? []), ...observedCookies]
    return cookieAttributesVerdict(cookies, isHttps)
  })

  await run('public-page-noindex', async () => {
    if (!opts.publicPageUrl) {
      return { pass: false, skipped: true, detail: 'no --public-page <url> given — the header is per-page (#124), so name a published page whose noindex is ON' }
    }
    const r = await get(opts.publicPageUrl)
    return noindexVerdict({ xRobotsTag: lowerHeaders(r.headers)['x-robots-tag'], html: await r.text() })
  })

  return items
}

export function formatReport(items: PreflightItem[]): { text: string; allPass: boolean; skipped: number } {
  const label = (i: PreflightItem) => (i.verdict.skipped ? 'SKIP' : i.verdict.pass ? 'PASS' : 'FAIL')
  const lines = items.map((i) => `${label(i)}  ${i.name.padEnd(20)} ${i.verdict.detail}`)
  // A skipped row is neither a pass nor a fail: it did not run. It must not close the gate, so it is
  // excluded from allPass and counted separately for the caller's exit code.
  const skipped = items.filter((i) => i.verdict.skipped).length
  const allPass = items.every((i) => i.verdict.skipped || i.verdict.pass)
  return { text: lines.join('\n'), allPass, skipped }
}
