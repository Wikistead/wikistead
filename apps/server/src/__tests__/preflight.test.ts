// Pre-launch deploy gate HTTP smoke — pure verdict logic (#148 / ADR-066). Each check is verified with
// DISTINCT passing AND failing inputs (not just "green"): the point of auto-smoke is to catch a real
// misconfig, so a check that can't fail is worthless.
import { describe, it, expect } from 'vitest'
import {
  lowerHeaders,
  securityHeadersVerdict,
  cookieHostOnlyVerdict,
  notFoundIsJsonVerdict,
  cacheControlVerdict,
  noindexVerdict,
  runHttpPreflight,
  formatReport,
  type FetchLike,
} from '../deploy/preflight.js'

describe('lowerHeaders', () => {
  it('lowercases keys and joins array values (plain object)', () => {
    expect(lowerHeaders({ 'X-Content-Type-Options': 'nosniff', 'Set-Cookie': ['a=1', 'b=2'] })).toEqual({
      'x-content-type-options': 'nosniff',
      'set-cookie': 'a=1, b=2',
    })
  })
  it('reads a real Headers instance', () => {
    const h = new Headers({ 'Referrer-Policy': 'no-referrer' })
    expect(lowerHeaders(h)['referrer-policy']).toBe('no-referrer')
  })
})

describe('securityHeadersVerdict (ADR-039/#187)', () => {
  const good = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'strict-transport-security': 'max-age=63072000' }
  it('PASSES a compliant https response', () => {
    expect(securityHeadersVerdict(good, true).pass).toBe(true)
  })
  it('PASSES http WITHOUT hsts and FAILS http WITH hsts (misleading)', () => {
    const { ['strict-transport-security']: _omit, ...noHsts } = good
    expect(securityHeadersVerdict(noHsts, false).pass).toBe(true)
    expect(securityHeadersVerdict(good, false).pass).toBe(false)
  })
  it('FAILS when nosniff / Referrer-Policy missing, or https lacks HSTS', () => {
    expect(securityHeadersVerdict({ 'referrer-policy': 'x', 'strict-transport-security': 'y' }, true).pass).toBe(false)
    expect(securityHeadersVerdict({ 'x-content-type-options': 'nosniff', 'strict-transport-security': 'y' }, true).pass).toBe(false)
    expect(securityHeadersVerdict({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'x' }, true).pass).toBe(false)
  })
})

describe('cookieHostOnlyVerdict (ADR-039 cross-subdomain leak)', () => {
  it('PASSES host-only cookies (no Domain=)', () => {
    expect(cookieHostOnlyVerdict(['sid=abc; Path=/; HttpOnly; Secure']).pass).toBe(true)
  })
  it('FAILS a cookie that sets a Domain (would leak t1→t2)', () => {
    const v = cookieHostOnlyVerdict(['sid=abc; Domain=.wikistead.com; Path=/'])
    expect(v.pass).toBe(false)
    expect(v.detail).toContain('sid')
  })
  it('PASSES when there are no cookies at all', () => {
    expect(cookieHostOnlyVerdict([]).pass).toBe(true)
  })
})

describe('notFoundIsJsonVerdict (uniform 404, no SPA catch-all in /api)', () => {
  it('PASSES a JSON 404', () => {
    expect(notFoundIsJsonVerdict(404, 'application/json; charset=utf-8').pass).toBe(true)
  })
  it('FAILS an HTML 404 (SPA index.html leaked into /api)', () => {
    expect(notFoundIsJsonVerdict(404, 'text/html').pass).toBe(false)
  })
  it('FAILS a non-404 status', () => {
    expect(notFoundIsJsonVerdict(200, 'application/json').pass).toBe(false)
  })
})

describe('cacheControlVerdict', () => {
  it('dynamic route PASSES when non-cacheable, FAILS when cacheable', () => {
    expect(cacheControlVerdict('dynamic', 'no-store').pass).toBe(true)
    expect(cacheControlVerdict('dynamic', 'private, no-cache').pass).toBe(true)
    expect(cacheControlVerdict('dynamic', 'public, max-age=3600').pass).toBe(false)
    expect(cacheControlVerdict('dynamic', '').pass).toBe(false)
  })
  it('assets PASS when long-lived/immutable, FAIL when short/none', () => {
    expect(cacheControlVerdict('assets', 'public, max-age=31536000, immutable').pass).toBe(true)
    expect(cacheControlVerdict('assets', 'max-age=60').pass).toBe(false)
    expect(cacheControlVerdict('assets', 'no-store').pass).toBe(false)
  })
})

describe('noindexVerdict (#124 public-page noindex)', () => {
  it('PASSES via X-Robots-Tag header', () => {
    expect(noindexVerdict({ xRobotsTag: 'noindex, nofollow' }).pass).toBe(true)
  })
  it('PASSES via a robots meta in the initial HTML', () => {
    expect(noindexVerdict({ html: '<head><meta name="robots" content="noindex"></head>' }).pass).toBe(true)
  })
  it('FAILS when neither header nor HTML carries noindex', () => {
    expect(noindexVerdict({ html: '<head><title>public</title></head>' }).pass).toBe(false)
    expect(noindexVerdict({}).pass).toBe(false)
  })
})

describe('runHttpPreflight (orchestration, injected fetch — no network)', () => {
  const okHeaders = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'strict-transport-security': 'max-age=1', 'cache-control': 'no-store' }
  it('reports PASS for a compliant https deployment', async () => {
    const fetchImpl: FetchLike = async (url) => url.includes('_missing_')
      ? { status: 404, headers: { 'content-type': 'application/json' }, text: async () => '{}' }
      : { status: 200, headers: okHeaders, text: async () => 'ok' }
    const items = await runHttpPreflight('https://t1.example', fetchImpl)
    const { allPass } = formatReport(items)
    expect(allPass).toBe(true)
    expect(items.map((i) => i.name)).toEqual(['security-headers', 'api-404-json', 'api-no-cache'])
  })
  it('records a FAIL (not a crash) when a row errors, and when a header is wrong', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('_missing_')) return { status: 200, headers: { 'content-type': 'text/html' }, text: async () => '<html>' } // wrong: 200 + html
      throw new Error('connection refused')
    }
    const items = await runHttpPreflight('https://t1.example', fetchImpl)
    const { allPass } = formatReport(items)
    expect(allPass).toBe(false)
    expect(items.find((i) => i.name === 'security-headers')!.verdict.detail).toContain('errored')
    expect(items.find((i) => i.name === 'api-404-json')!.verdict.pass).toBe(false)
  })
})
