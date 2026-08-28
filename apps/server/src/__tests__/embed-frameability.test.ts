// #970 / ADR-267: a header-only per-URL frameability probe, same page-view + allowlist gates as
// resolveEmbed (embed-resolve.ts), never reading a body.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  checkFrameability, EmbedFrameabilityDeniedError, clearFrameabilityCache,
  isHostAllowlisted, parseFrameAncestorsRefuses, xFrameOptionsRefuses,
  PROBE_UNREACHABLE, KNOWN_MECHANISMS,
} from '../embed-frameability.js'

const fga = (viewable: boolean) => ({ check: async () => ({ allowed: viewable }) }) as never

function stubFetcher(headers: Record<string, string> = {}) {
  const calls: string[] = []
  const fetcher = async (url: string) => {
    calls.push(url)
    return new Response(null, { headers })
  }
  return { fetcher, calls }
}

const ALLOW = ['embed.example.com']
const base = { principal: 'user:u', pageId: 'ok', url: 'https://embed.example.com/x', allowlist: ALLOW }

beforeEach(clearFrameabilityCache)

describe('checkFrameability (#970 / ADR-267 §3.1)', () => {
  it('X-Frame-Options DENY refuses; SAMEORIGIN refuses; neither header → embeddable', async () => {
    const deny = stubFetcher({ 'x-frame-options': 'DENY' })
    expect((await checkFrameability({ fga: fga(true), fetcher: deny.fetcher }, base)).verdict).toBe('refused')
    const same = stubFetcher({ 'x-frame-options': 'SAMEORIGIN' })
    expect((await checkFrameability({ fga: fga(true), fetcher: same.fetcher }, { ...base, url: 'https://embed.example.com/y' })).verdict).toBe('refused')
    const clean = stubFetcher({})
    expect((await checkFrameability({ fga: fga(true), fetcher: clean.fetcher }, { ...base, url: 'https://embed.example.com/z' })).verdict).toBe('embeddable')
  })

  it("a frame-ancestors CSP refuses even with no X-Frame-Options, and a wildcard does not", async () => {
    const closed = stubFetcher({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" })
    expect((await checkFrameability({ fga: fga(true), fetcher: closed.fetcher }, base)).verdict).toBe('refused')
    const open = stubFetcher({ 'content-security-policy': 'frame-ancestors *' })
    expect((await checkFrameability({ fga: fga(true), fetcher: open.fetcher }, { ...base, url: 'https://embed.example.com/open' })).verdict).toBe('embeddable')
  })

  it('⚠️ break-check: not reading the CSP header renders the frame-ancestors case embeddable', () => {
    // Simulates dropping the parseFrameAncestorsRefuses call inside checkFrameability.
    const xfoOnlyVerdict = (headers: Record<string, string>) => (xFrameOptionsRefuses(headers['x-frame-options'] ?? null) ? 'refused' : 'embeddable')
    expect(xfoOnlyVerdict({ 'content-security-policy': "frame-ancestors 'none'" }), 'without the CSP read this case is wrongly embeddable').toBe('embeddable')
    // The real function reads both:
    expect(parseFrameAncestorsRefuses("frame-ancestors 'none'")).toBe(true)
  })

  it('a non-allowlisted host is refused with NO fetch made (existence of the probe is not a signal)', async () => {
    const { fetcher, calls } = stubFetcher({})
    await expect(checkFrameability({ fga: fga(true), fetcher }, { ...base, allowlist: [] })).rejects.toBeInstanceOf(EmbedFrameabilityDeniedError)
    expect(calls).toHaveLength(0)
  })

  it('a non-viewer of the page is denied (404-shaped upstream) and NO fetch happens — page-view gate first', async () => {
    const { fetcher, calls } = stubFetcher({})
    await expect(checkFrameability({ fga: fga(false), fetcher }, base)).rejects.toMatchObject({ statusCode: 404 })
    expect(calls).toHaveLength(0)
  })

  it('§3.3 fails OPEN: a fetch error (timeout/DNS/connection) verdicts embeddable, never refused', async () => {
    const throwing = async () => { throw new Error('timeout') }
    const r = await checkFrameability({ fga: fga(true), fetcher: throwing }, base)
    expect(r.verdict).toBe('embeddable')
  })

  it('§3.4 caches per FULL URL: two checks of the SAME url make ONE fetch; a different path is independent', async () => {
    const { fetcher, calls } = stubFetcher({ 'x-frame-options': 'DENY' })
    await checkFrameability({ fga: fga(true), fetcher }, base)
    await checkFrameability({ fga: fga(true), fetcher }, base)
    expect(calls).toHaveLength(1) // second call served from cache
    await checkFrameability({ fga: fga(true), fetcher }, { ...base, url: 'https://embed.example.com/other-path' })
    expect(calls).toHaveLength(2) // a DIFFERENT url on the SAME host is not the same cache entry
  })

  it('the shortener case is answered from the table (verdict refused), with NO fetch — the probe cannot see through redirect: "error"', async () => {
    const { fetcher, calls } = stubFetcher({}) // would answer embeddable if reached — must not be reached
    const r = await checkFrameability({ fga: fga(true), fetcher }, { ...base, url: 'https://maps.app.goo.gl/abc123', allowlist: ['maps.app.goo.gl'] })
    expect(r.verdict).toBe('refused')
    expect(calls).toHaveLength(0)
  })
})

describe('isHostAllowlisted (mirrors embed.ts client-side isAllowlistedEmbed)', () => {
  it('exact and subdomain match; look-alikes refused', () => {
    expect(isHostAllowlisted('embed.example.com', ['embed.example.com'])).toBe(true)
    expect(isHostAllowlisted('www.embed.example.com', ['embed.example.com'])).toBe(true)
    expect(isHostAllowlisted('evilembed.example.com', ['embed.example.com'])).toBe(false)
  })
})

describe('#3.2 / §5: every probe-unreachable entry names a MECHANISM, never a vendor', () => {
  it('every declared entry\'s reason is in the closed KNOWN_MECHANISMS set', () => {
    expect(PROBE_UNREACHABLE.length, 'the table is non-empty — otherwise this pin is vacuous').toBeGreaterThan(0)
    for (const e of PROBE_UNREACHABLE) expect((KNOWN_MECHANISMS as readonly string[])).toContain(e.reason)
  })

  it('⚠️ break-check: a vendor-named reason (bypassing the type system) fails the same membership check', () => {
    const bypassed = { ...PROBE_UNREACHABLE[0]!, reason: 'Google' } as unknown as { reason: string }
    expect((KNOWN_MECHANISMS as readonly string[]).includes(bypassed.reason), 'a vendor name must not be a known mechanism').toBe(false)
  })
})
