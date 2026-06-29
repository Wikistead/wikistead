import { lookup } from 'node:dns/promises'

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

// Validate a URL for server-side fetch: https only, and EVERY resolved IP must be public (an
// attacker can point a domain at a private IP). Throws on violation; returns the parsed URL.
export async function assertSafeUrl(raw: string, opts: { resolve?: Resolver } = {}): Promise<URL> {
  let u: URL
  try { u = new URL(raw) } catch { throw Object.assign(new Error('invalid URL'), { statusCode: 400, code: 'invalid_url' }) }
  if (u.protocol !== 'https:') throw Object.assign(new Error('only https is allowed'), { statusCode: 400, code: 'scheme_blocked' })
  const ips = await (opts.resolve ?? defaultResolve)(u.hostname)
  if (ips.length === 0) throw Object.assign(new Error('host did not resolve'), { statusCode: 400, code: 'dns_unresolved' })
  for (const ip of ips) {
    if (isBlockedIp(ip)) throw Object.assign(new Error('host resolves to a blocked address'), { statusCode: 400, code: 'ssrf_blocked' })
  }
  return u
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
