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
  setCookiesFrom,
  firstAssetPath,
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
    const { allPass, skipped } = formatReport(items)
    expect(allPass).toBe(true)
    expect(items.map((i) => i.name)).toEqual(['security-headers', 'api-404-json', 'api-no-cache', 'assets-long-cache', 'cookie-host-only', 'public-page-noindex'])
    // ...but the three probe-dependent rows were NOT observed here, and say so rather than reading green.
    expect(skipped).toBe(3)
    expect(items.filter((i) => i.verdict.skipped).map((i) => i.name)).toEqual(['assets-long-cache', 'cookie-host-only', 'public-page-noindex'])
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

  // The three rows added when the pure verdicts were wired in (#148). Each was implemented and tested
  // as a function but never actually called by the run, so the deployment was never asked the question.
  const respond = (headers: Record<string, string | string[]>, body = 'ok', status = 200) =>
    ({ status, headers, text: async () => body })

  it('FAILS the cookie row on a Domain= cookie the operator captured at sign-in', async () => {
    const fetchImpl: FetchLike = async () => respond(okHeaders)
    const items = await runHttpPreflight('https://t1.example', fetchImpl, {
      setCookies: ['wks_session=abc; Domain=.wikistead.example; Path=/; Secure'],
    })
    const row = items.find((i) => i.name === 'cookie-host-only')!
    expect(row.verdict.skipped).toBeFalsy()
    expect(row.verdict.pass).toBe(false)
    expect(row.verdict.detail).toContain('wks_session')
    expect(formatReport(items).allPass).toBe(false)
  })

  it('catches a Domain= cookie set on an UNAUTHENTICATED response, with no operator input', async () => {
    const fetchImpl: FetchLike = async () => respond({ ...okHeaders, 'set-cookie': ['aff=1; Domain=.wikistead.example; Path=/'] })
    const items = await runHttpPreflight('https://t1.example', fetchImpl)
    const row = items.find((i) => i.name === 'cookie-host-only')!
    // `skipped` first: a skipped row also carries pass:false, so asserting only `pass` would stay green
    // if the run stopped collecting cookies altogether (verified by breaking the collector).
    expect(row.verdict.skipped).toBeFalsy()
    expect(row.verdict.pass).toBe(false)
    expect(row.verdict.detail).toContain('aff')
  })

  it('probes a hashed asset learned from the served HTML, and fails a short max-age', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith('/assets/app-9f2c1.js')) return respond({ ...okHeaders, 'cache-control': 'max-age=60' })
      if (url === 'https://t1.example/') return respond(okHeaders, '<html><script src="/assets/app-9f2c1.js"></script></html>')
      return respond(okHeaders)
    }
    const items = await runHttpPreflight('https://t1.example', fetchImpl)
    const row = items.find((i) => i.name === 'assets-long-cache')!
    expect(row.verdict.skipped).toBeFalsy()
    expect(row.verdict.pass).toBe(false)
    expect(row.verdict.detail).toContain('not long-cached')
  })

  it('FAILS the noindex row when the named public page carries no noindex signal', async () => {
    const fetchImpl: FetchLike = async (url) =>
      url.includes('/p/') ? respond(okHeaders, '<html><head><title>public</title></head></html>') : respond(okHeaders)
    const items = await runHttpPreflight('https://t1.example', fetchImpl, { publicPageUrl: 'https://t1.example/p/abc' })
    const row = items.find((i) => i.name === 'public-page-noindex')!
    expect(row.verdict.skipped).toBeFalsy()
    expect(row.verdict.pass).toBe(false)
  })

  it('PASSES the noindex row on the X-Robots-Tag header', async () => {
    const fetchImpl: FetchLike = async (url) =>
      url.includes('/p/') ? respond({ ...okHeaders, 'X-Robots-Tag': 'noindex' }, '<html></html>') : respond(okHeaders)
    const items = await runHttpPreflight('https://t1.example', fetchImpl, { publicPageUrl: 'https://t1.example/p/abc' })
    expect(items.find((i) => i.name === 'public-page-noindex')!.verdict.pass).toBe(true)
  })
})

describe('formatReport (a skipped row is not a pass)', () => {
  it('keeps allPass true but counts the skip, and prints SKIP', () => {
    const r = formatReport([
      { name: 'a', verdict: { pass: true, detail: 'ok' } },
      { name: 'b', verdict: { pass: false, skipped: true, detail: 'not observed' } },
    ])
    expect(r.allPass).toBe(true)
    expect(r.skipped).toBe(1)
    expect(r.text).toContain('SKIP')
    expect(r.text).not.toContain('FAIL')
  })
  it('reports a real failure as FAIL', () => {
    const r = formatReport([{ name: 'a', verdict: { pass: false, detail: 'bad' } }])
    expect(r.allPass).toBe(false)
    expect(r.skipped).toBe(0)
  })
})

describe('setCookiesFrom / firstAssetPath', () => {
  it('reads repeated Set-Cookie as a list (a joined pair would misattribute Domain=)', () => {
    expect(setCookiesFrom({ 'Set-Cookie': ['a=1; Path=/', 'b=2; Domain=.x.example'] })).toHaveLength(2)
    expect(cookieHostOnlyVerdict(setCookiesFrom({ 'set-cookie': ['a=1; Path=/', 'b=2; Domain=.x.example'] })).detail).toContain('b')
    expect(setCookiesFrom({ 'content-type': 'text/html' })).toEqual([])
  })
  it('finds the first hashed asset in the document', () => {
    expect(firstAssetPath('<link rel="stylesheet" href="/assets/index-a1b2.css"><script src="/assets/x.js">')).toBe('/assets/index-a1b2.css')
    expect(firstAssetPath('<html>no assets</html>')).toBeUndefined()
  })
})
