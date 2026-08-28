import type { OpenFgaClient } from '@openfga/sdk'
import type { CheckContext } from '@wikistead/authz'
import { assertPageViewable } from './page-view-gate.js'
import { safeFetch } from './safe-fetch.js'

// #970 / ADR-267: is a specific, already-allowlisted URL actually frameable? The old rule (embed.ts's
// UNEMBEDDABLE_RULES) answered a HOST question with a client-side table — but the one case anybody has
// measured (Google Maps) refuses on every path except its own share-link's `/maps/embed` — so a HOST
// probe answers a PATH question wrongly for exactly the hosts worth allowlisting (§1.2). The verdict
// lives in two response headers, so only the server can ask it (§2).

export type FrameabilityVerdict = 'embeddable' | 'refused'

export class EmbedFrameabilityDeniedError extends Error {
  statusCode = 403
  constructor(message = 'forbidden') {
    super(message)
  }
}

// #3.2: cases a header probe cannot reach at all — each entry names the MECHANISM that defeats it,
// never a vendor. `reason` is a closed literal union rather than a free string specifically so this
// cannot silently regrow into the "known-bad vendor list" this ticket was filed to remove (§3.2's own
// complaint) — a new entry for a NEW mechanism widens the union (a deliberate, reviewable edit); a
// vendor name does not typecheck. embed-frameability.test.ts's break-check bypasses the type system
// (`as unknown as`) to prove the runtime membership check would also refuse it, not just the compiler.
export const KNOWN_MECHANISMS = ['redirect'] as const
export type ProbeUnreachableMechanism = (typeof KNOWN_MECHANISMS)[number]

interface ProbeUnreachableEntry {
  readonly test: (u: URL) => boolean
  readonly verdict: FrameabilityVerdict
  readonly reason: ProbeUnreachableMechanism
}

export const PROBE_UNREACHABLE: readonly ProbeUnreachableEntry[] = [
  {
    // safeFetch uses redirect: 'error' — a DELIBERATE security property (a validated destination must
    // not be bounced past by a 30x) — so a probe of a URL that redirects elsewhere never sees the
    // destination's headers at all. Google's Maps share-link shortener is the one live example: it
    // redirects to an ordinary Maps page, which refuses framing exactly like the rest of the site.
    test: (u) => u.hostname === 'maps.app.goo.gl' || (/^(?:www\.)?goo\.gl$/i.test(u.hostname) && u.pathname.startsWith('/maps')),
    verdict: 'refused',
    reason: 'redirect',
  },
]

// Mirrors apps/web/src/editor/macros/embed.ts's `isAllowlistedEmbed` exactly (subdomain-inclusive,
// case-insensitive, trailing-dot-stripped) — ADR-267 §3.1: "the SSRF population is therefore identical
// to resolveEmbed's", which only holds if this reads the SAME URLs the client would have iframed.
// Duplicated rather than shared because the two run in different runtimes (browser vs. server); the
// two files' tests cover the same cases so a divergence shows up as one file passing and the other not.
export function isHostAllowlisted(host: string, allowlist: readonly string[]): boolean {
  const h = host.toLowerCase()
  return allowlist.some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/^\.+/, '')
    return entry !== '' && (h === entry || h.endsWith('.' + entry))
  })
}

// `frame-ancestors` refuses embedding from THIS product's origin unless the directive is a wildcard.
// We do not compare against our own origin: no third-party site allowlists a specific SaaS's origin by
// name, so an explicit-but-closed list is, for our purposes, the same as `'none'`. Headers only — the
// body is never read (§3.1).
export function parseFrameAncestorsRefuses(csp: string | null): boolean {
  if (!csp) return false
  const directive = csp.split(';').map((s) => s.trim()).find((s) => s.toLowerCase().startsWith('frame-ancestors'))
  if (!directive) return false
  const value = directive.slice('frame-ancestors'.length).trim().toLowerCase()
  if (value === '' || value === "'none'") return true
  if (value.includes('*')) return false
  return true // a closed allow-list that (by construction) never names our origin
}

export function xFrameOptionsRefuses(xfo: string | null): boolean {
  const v = (xfo ?? '').trim().toLowerCase()
  return v === 'deny' || v === 'sameorigin'
}

// §3.4: cached per FULL URL (never per host — §1.2 is the whole point: two paths on one host must be
// able to disagree). Global, not per-tenant (§6.1 ruling): a verdict is a fact about a public URL, and
// per-tenant caching would leak one tenant's request TIMING to another via cache warmth. An in-process
// Map, the same shape as title-dict-cache.ts — a positive verdict outlives a negative one (§6.1
// starting point: a provider that starts refusing shouldn't render blank frames for a week; a provider
// that fixes its headers shouldn't stay guidance-only for a week either).
const POSITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const NEGATIVE_TTL_MS = 60 * 60 * 1000
const MAX_ENTRIES = 5000
interface CacheEntry { verdict: FrameabilityVerdict; expires: number }
const cache = new Map<string, CacheEntry>()

function cacheGet(url: string, now: number): FrameabilityVerdict | undefined {
  const hit = cache.get(url)
  if (!hit) return undefined
  if (hit.expires <= now) { cache.delete(url); return undefined }
  return hit.verdict
}
function cacheSet(url: string, verdict: FrameabilityVerdict, now: number): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(url, { verdict, expires: now + (verdict === 'embeddable' ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) })
}
/** Test-only: cache state must not leak between fixtures. */
export function clearFrameabilityCache(): void {
  cache.clear()
}

type Fetcher = (url: string) => Promise<Response>

// (1) page-view gate, (2) provider allowlist, (3) SSRF-guarded fetch — the SAME order as resolveEmbed
// (embed-resolve.ts), because this reasons about the same population (§3.1). Unlike resolveEmbed this
// reads headers only, never the body (§3.1 — the content-type allowlist and byte cap exist to bound a
// document this route never parses).
export async function checkFrameability(
  deps: { fga: OpenFgaClient; fetcher?: Fetcher },
  args: { principal: string; pageId: string; url: string; allowlist: readonly string[]; context?: CheckContext },
  now = Date.now(),
): Promise<{ verdict: FrameabilityVerdict }> {
  await assertPageViewable(deps.fga, args.principal, args.pageId, args.context)

  let u: URL
  try {
    u = new URL(args.url)
  } catch {
    throw new EmbedFrameabilityDeniedError('invalid url')
  }
  if (!isHostAllowlisted(u.hostname, args.allowlist)) throw new EmbedFrameabilityDeniedError('provider not allowlisted')

  const cached = cacheGet(args.url, now)
  if (cached) return { verdict: cached }

  const known = PROBE_UNREACHABLE.find((e) => e.test(u))
  if (known) {
    cacheSet(args.url, known.verdict, now)
    return { verdict: known.verdict }
  }

  // §3.3: a probe that cannot answer — timeout, DNS failure, a host that refuses the request itself,
  // the redirect guard tripping on a case not in the table above — fails OPEN. A missed refusal shows
  // what ships today (a blank frame the reader may report); a false refusal replaces a working embed
  // with a sentence (#207's content-loss shape), which is the worse of the two failures.
  let verdict: FrameabilityVerdict = 'embeddable'
  try {
    const res = await (deps.fetcher ?? safeFetch)(args.url)
    void res.body?.cancel().catch(() => {}) // headers only — never buffer or parse the body
    if (xFrameOptionsRefuses(res.headers.get('x-frame-options')) || parseFrameAncestorsRefuses(res.headers.get('content-security-policy'))) {
      verdict = 'refused'
    }
  } catch {
    // stays 'embeddable' — fail open
  }
  cacheSet(args.url, verdict, now)
  return { verdict }
}
