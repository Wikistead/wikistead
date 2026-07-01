import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'

// SSRF-guarded external fetch (#108 / #140 · ADR-071/ADR-074). The shared gate for any server-side
// fetch of a user/operator-supplied URL (external embeds, PlantUML/Kroki render). It refuses
// non-https and any host that resolves to a private / loopback / link-local / cloud-metadata
// address — so a `plantuml`/embed URL can't make the server reach an internal service. The IP
// classification is pure (testable); DNS resolution is injectable for tests.

// Is this literal IP in a blocked range? IPv4: loopback/private/link-local(incl. 169.254.169.254
// metadata)/CGNAT/this-network. IPv6: loopback/ULA/link-local + IPv4-mapped (re-checked as v4).
export function isBlockedIp(ip: string): boolean {
  const v4 = ip.includes('.') ? ip.split('.').map(Number) : null
  if (v4 && v4.length === 4 && v4.every((o) => Number.isInteger(o) && o >= 0 && o <= 255)) {
    const [a, b] = v4
    if (a === 10 || a === 127 || a === 0) return true               // private / loopback / this-network
    if (a === 169 && b === 254) return true                          // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true                 // private
    if (a === 192 && b === 168) return true                          // private
    if (a === 100 && b >= 64 && b <= 127) return true                // CGNAT (100.64.0.0/10)
    return false
  }
  const lc = ip.toLowerCase()
  if (lc === '::1' || lc === '::') return true                       // loopback / unspecified
  const mapped = lc.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)           // IPv4-mapped → re-check as v4
  if (mapped) return isBlockedIp(mapped[1]!)
  if (lc.startsWith('fc') || lc.startsWith('fd')) return true        // ULA fc00::/7
  if (lc.startsWith('fe8') || lc.startsWith('fe9') || lc.startsWith('fea') || lc.startsWith('feb')) return true // link-local fe80::/10
  return false
}

type Resolver = (host: string) => Promise<string[]>
const defaultResolve: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address)

export interface GuardOpts {
  resolve?: Resolver
  // Operator opt-in (NOT tenant/admin-settable): permit private/loopback destinations for this
  // fetch only, so a self-hosted Wikistead can reach a self-hosted IdP on the same private network
  // (ADR-083). Defaults false → cloud/multi-tenant stays guarded.
  allowPrivate?: boolean
}

// Resolve + validate a URL for a server-side fetch, returning the URL AND the exact resolved IPs so
// the caller can PIN the connection to them (defeats DNS rebinding: the IP we validated is the IP we
// connect to). https only; every resolved IP must be public unless the operator opted into private.
export async function resolveGuarded(raw: string, opts: GuardOpts = {}): Promise<{ url: URL; ips: string[] }> {
  let u: URL
  try { u = new URL(raw) } catch { throw Object.assign(new Error('invalid URL'), { statusCode: 400, code: 'invalid_url' }) }
  if (u.protocol !== 'https:') throw Object.assign(new Error('only https is allowed'), { statusCode: 400, code: 'scheme_blocked' })
  const ips = await (opts.resolve ?? defaultResolve)(u.hostname)
  if (ips.length === 0) throw Object.assign(new Error('host did not resolve'), { statusCode: 400, code: 'dns_unresolved' })
  if (!opts.allowPrivate) {
    for (const ip of ips) {
      if (isBlockedIp(ip)) throw Object.assign(new Error('host resolves to a blocked address'), { statusCode: 400, code: 'ssrf_blocked' })
    }
  }
  return { url: u, ips }
}

// Validate a URL for server-side fetch: https only, and EVERY resolved IP must be public (an
// attacker can point a domain at a private IP). Throws on violation; returns the parsed URL.
export async function assertSafeUrl(raw: string, opts: GuardOpts = {}): Promise<URL> {
  return (await resolveGuarded(raw, opts)).url
}

// A node `lookup` that ALWAYS hands back a pre-validated IP and never consults DNS again — so the
// socket connects to the exact address we checked, closing the DNS-rebinding TOCTOU (a hostile
// resolver returning public at validation time then private at connect time). TLS still uses the
// URL's hostname for SNI/cert verification, so pinning to the IP does not weaken TLS. Pure/testable.
export function pinnedLookup(ips: string[]): (hostname: string, options: unknown, cb: (...a: unknown[]) => void) => void {
  const fam = (ip: string) => (ip.includes(':') ? 6 : 4)
  return (_hostname, options, cb) => {
    if (options && typeof options === 'object' && (options as { all?: boolean }).all) {
      cb(null, ips.map((address) => ({ address, family: fam(address) })))
    } else {
      cb(null, ips[0]!, fam(ips[0]!))
    }
  }
}

// Read an async byte stream into a string, REFUSING to buffer more than maxBytes (no OOM from a
// hostile/large body). Pure over any AsyncIterable so it is unit-testable without a socket.
export async function readCapped(source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<string> {
  let received = 0
  const chunks: Buffer[] = []
  for await (const chunk of source) {
    received += chunk.length
    if (received > maxBytes) throw Object.assign(new Error('response body too large'), { statusCode: 502, code: 'body_too_large' })
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

// SSRF-guarded fetch: validate → fetch with bounded time + NO credential/cookie forward. Callers
// (external embed / PlantUML render) use this instead of fetch(); page-view authz is enforced
// separately by the route before calling (ADR-071). Redirects are disabled so a 30x can't bounce
// to a private host post-validation (the caller re-validates if it must follow one).
export async function safeFetch(raw: string, opts: { resolve?: Resolver; timeoutMs?: number } = {}): Promise<Response> {
  const u = await assertSafeUrl(raw, opts)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000)
  try {
    return await fetch(u, { redirect: 'error', signal: ctrl.signal, headers: {} }) // no Authorization/Cookie forwarded
  } finally {
    clearTimeout(timer)
  }
}

// SSRF-guarded GET of a JSON document over a connection PINNED to the validated IPs (ADR-083). Used
// for tenant-admin-supplied URLs the server must fetch itself (OIDC issuer discovery, JWKS): the
// holes were a raw fetch (SSRF) + an unbounded `r.json()` (OOM). This routes through the SSRF guard
// (operator-opt-in for private), pins the connection to the validated IP (no DNS rebinding), caps the
// body, forces https, forwards no credentials, and refuses redirects. Throws (statusCode/code) on
// any violation; never buffers an unbounded body.
export async function safeFetchJson(
  raw: string,
  opts: GuardOpts & { timeoutMs?: number; maxBytes?: number } = {},
): Promise<unknown> {
  const { url, ips } = await resolveGuarded(raw, opts)
  const maxBytes = opts.maxBytes ?? 256 * 1024
  const timeoutMs = opts.timeoutMs ?? 5000
  const body = await new Promise<string>((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: 'GET', lookup: pinnedLookup(ips) as never, headers: {} }, // pinned IP; no creds
      (res) => {
        const status = res.statusCode ?? 0
        // No redirect bounce: a 30x could otherwise point past the guard to a private host.
        if (status >= 300 && status < 400) { res.destroy(); reject(Object.assign(new Error('redirect not allowed'), { statusCode: 502, code: 'redirect_blocked' })); return }
        if (status < 200 || status >= 300) { res.destroy(); reject(Object.assign(new Error(`HTTP ${status}`), { statusCode: 502, code: 'bad_status', httpStatus: status })); return }
        readCapped(res, maxBytes).then(resolve, (e) => { res.destroy(); reject(e) })
      },
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { statusCode: 504, code: 'timeout' })))
    req.end()
  })
  try {
    return JSON.parse(body)
  } catch {
    throw Object.assign(new Error('response was not valid JSON'), { statusCode: 502, code: 'invalid_json' })
  }
}

// Normalize a Fetch BodyInit that openid-client hands us into something node:https can write.
// openid-client's token exchange sends a form body (string | URLSearchParams); GET requests have none.
function normalizeBody(body: unknown): string | Buffer | undefined {
  if (body == null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body))
  return String(body)
}

// A Fetch-API-compatible function for openid-client's `customFetch` seam (ADR-083 / #181 review). The
// login flow (openid-client) makes THREE issuer-derived fetches — discovery, JWKS (id_token signature
// keys), and the token endpoint — and `customFetch` is assigned to the resolved Configuration so ONE
// function guards ALL of them. This closes the SSRF the discovery-only fix left open: a legit public
// discovery doc could point `jwks_uri` / `token_endpoint` at an INTERNAL address and the unguarded key/
// token fetch would reach it. Every call re-validates its URL (https-only, all resolved IPs public
// unless the operator opted in) and PINS the socket to the validated IP (no DNS rebinding) — so the
// `OIDC_ALLOW_PRIVATE_ISSUER` flag now governs discovery AND jwks AND token uniformly (a self-hosted
// private IdP's key fetch works only under the same operator opt-in, not just its discovery).
//
// Unlike safeFetch (embed fetches, which STRIP credentials), this FORWARDS the caller's headers/body:
// openid-client's client-auth Authorization header + the token-exchange form body are credentials the
// client legitimately presents TO the IdP, not a leak to a third party. Redirects are NOT auto-followed
// (returned as-is for the caller's `redirect: 'manual'`); if the caller ever followed one it would
// re-enter this guard. The body is capped (no OOM from a hostile token/JWKS endpoint).
export function guardedFetch(
  guard: GuardOpts & { maxBytes?: number; timeoutMs?: number } = {},
): (url: string | URL, options?: { method?: string; headers?: Record<string, string>; body?: unknown; redirect?: string; signal?: AbortSignal | null }) => Promise<Response> {
  return async (rawUrl, options = {}) => {
    const { url, ips } = await resolveGuarded(String(rawUrl), guard) // https-only + SSRF + returns IPs to pin
    // The SSRF gate runs FIRST (above) so it can never be bypassed; only then honor an already-aborted
    // signal (openid-client's timeout) without opening a socket.
    if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'aborted' })
    const maxBytes = guard.maxBytes ?? 512 * 1024
    const timeoutMs = guard.timeoutMs ?? 8000
    const method = (options.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = { ...(options.headers ?? {}) }
    const body = normalizeBody(options.body)
    if (body != null) headers['content-length'] = String(Buffer.byteLength(body)) // node:https: set len (avoid chunked)
    return new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(url, { method, headers, lookup: pinnedLookup(ips) as never }, (res) => {
        readCapped(res, maxBytes).then(
          (text) => {
            const h = new Headers()
            for (const [k, v] of Object.entries(res.headers)) {
              if (Array.isArray(v)) for (const vv of v) h.append(k, vv)
              else if (v != null) h.set(k, String(v))
            }
            resolve(new Response(text, { status: res.statusCode ?? 502, statusText: res.statusMessage ?? '', headers: h }))
          },
          (e) => { res.destroy(); reject(e) },
        )
      })
      req.on('error', reject)
      req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { statusCode: 504, code: 'timeout' })))
      if (options.signal) options.signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('aborted'), { code: 'aborted' })), { once: true })
      if (body != null) req.write(body)
      req.end()
    })
  }
}
