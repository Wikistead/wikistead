// Pre-launch deploy gate HTTP smoke — pure verdict logic (#148 / ADR-066). Each check is verified with
// DISTINCT passing AND failing inputs (not just "green"): the point of auto-smoke is to catch a real
// misconfig, so a check that can't fail is worthless.
import { describe, it, expect } from 'vitest'
import {
  lowerHeaders,
  securityHeadersVerdict,
  cookieHostOnlyVerdict,
  cookieAttributesVerdict,
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
  // The values the product actually ships (app.ts / deploy/caddy/Caddyfile), not synthetic stand-ins:
  // #879 judges the VALUE, so a fixture that only had to be present no longer stands for a real one.
  const good = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'strict-transport-security': 'max-age=31536000; includeSubDomains' }
  it('PASSES a compliant https response', () => {
    expect(securityHeadersVerdict(good, true).pass).toBe(true)
  })
  it('PASSES http WITHOUT hsts and FAILS http WITH hsts (misleading)', () => {
    const { ['strict-transport-security']: _omit, ...noHsts } = good
    expect(securityHeadersVerdict(noHsts, false).pass).toBe(true)
    expect(securityHeadersVerdict(good, false).pass).toBe(false)
  })
  // #879: the two settings that switch the protection OFF while still reading as configured. A
  // presence check passed both, so the gate certified the misconfiguration it exists to name.
  it('FAILS HSTS values that disable or under-serve the pin', () => {
    const withHsts = (v: string) => securityHeadersVerdict({ ...good, 'strict-transport-security': v }, true)
    expect(withHsts('max-age=0').pass, 'max-age=0 REVOKES the pin').toBe(false)
    expect(withHsts('max-age=0').detail).toContain('DISABLES')
    expect(withHsts('max-age=60; includeSubDomains').pass, 'expires between two visits').toBe(false)
    expect(withHsts('includeSubDomains').pass, 'no max-age at all').toBe(false)
    expect(withHsts('max-age=31536000').pass, 'apex-only pin leaves the tenant subdomains open').toBe(false)
    expect(withHsts('max-age=31536000').detail).toContain('includeSubDomains')
    // ...and the shipped value is still accepted, so the check is not merely strict.
    expect(withHsts('max-age=31536000; includeSubDomains').pass).toBe(true)
    expect(withHsts('max-age=86400; includeSubDomains').pass, 'exactly the floor').toBe(true)
  })
  it('FAILS Referrer-Policy values that hand the full URL to a third party', () => {
    const withRp = (v: string) => securityHeadersVerdict({ ...good, 'referrer-policy': v }, true)
    expect(withRp('unsafe-url').pass).toBe(false)
    expect(withRp('unsafe-url').detail).toContain('FULL URL')
    expect(withRp('no-referrer-when-downgrade').pass, 'full URL cross-origin whenever it is not a downgrade').toBe(false)
    expect(withRp('bogus-policy').pass, 'unrecognised: the browser silently uses its own default').toBe(false)
    // A list is legal and the LAST recognised token wins — so a safe head does not rescue a leaky tail,
    // and a leaky head does not condemn a safe tail.
    expect(withRp('strict-origin, unsafe-url').pass).toBe(false)
    expect(withRp('unsafe-url, strict-origin-when-cross-origin').pass).toBe(true)
    // ...and the values that stop at the origin (or below) are still accepted.
    for (const ok of ['no-referrer', 'same-origin', 'strict-origin', 'origin', 'origin-when-cross-origin', 'strict-origin-when-cross-origin']) {
      expect(withRp(ok).pass, ok).toBe(true)
    }
  })
  it('FAILS when nosniff / Referrer-Policy missing, or https lacks HSTS', () => {
    const { ['x-content-type-options']: _n, ...noSniff } = good
    const { ['referrer-policy']: _r, ...noRp } = good
    const { ['strict-transport-security']: _h, ...noHsts } = good
    expect(securityHeadersVerdict(noSniff, true).pass).toBe(false)
    expect(securityHeadersVerdict(noRp, true).pass).toBe(false)
    expect(securityHeadersVerdict(noHsts, true).pass).toBe(false)
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

describe('cookieAttributesVerdict (#884: who may READ the session, and over what)', () => {
  const sess = (attrs: string) => `wks_sess=abc; Path=/${attrs}`

  it('PASSES the posture the product actually sets', () => {
    expect(cookieAttributesVerdict([sess('; HttpOnly; Secure; SameSite=Lax')], true).pass).toBe(true)
  })

  it('FAILS a session cookie any script on the page can read', () => {
    const v = cookieAttributesVerdict([sess('; Secure')], true)
    expect(v.pass).toBe(false)
    expect(v.detail).toContain('HttpOnly')
  })

  it('FAILS an https deployment whose session cookie is not Secure', () => {
    const v = cookieAttributesVerdict([sess('; HttpOnly')], true)
    expect(v.pass).toBe(false)
    expect(v.detail).toContain('Secure')
  })

  it('does NOT demand Secure over http — a gate an operator skips protects nothing', () => {
    expect(cookieAttributesVerdict([sess('; HttpOnly')], false).pass).toBe(true)
  })

  it('judges every cookie this product issues, not just the session', () => {
    // The rule is the `wks_` prefix, so a fourth one is judged the day it is written.
    for (const name of ['wks_factor', 'wks_signup', 'wks_something_new']) {
      const v = cookieAttributesVerdict([`${name}=x; Path=/; Secure`], true)
      expect(v.pass, `${name} was not judged`).toBe(false)
      expect(v.detail).toContain(name)
    }
  })

  it('leaves cookies the product did not set alone', () => {
    // The load balancer's affinity cookie is a routing hint, not a credential. Failing a deployment
    // over it would teach the operator to ignore this row — and then it guards nothing at all.
    const v = cookieAttributesVerdict([`INGRESSCOOKIE=abc; Path=/`, sess('; HttpOnly; Secure')], true)
    expect(v.pass).toBe(true)
  })

  it('SKIPS rather than passes when it saw no cookie of ours', () => {
    // "I did not look" must not print like "I looked and it was fine" — this gate blocks a release.
    const v = cookieAttributesVerdict([`INGRESSCOOKIE=abc; Path=/`], true)
    expect(v.pass).toBe(false)
    expect(v.skipped).toBe(true)
    expect(cookieAttributesVerdict([], true).skipped).toBe(true)
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
  const okHeaders = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'strict-transport-security': 'max-age=31536000; includeSubDomains', 'cache-control': 'no-store' }
  it('reports PASS for a compliant https deployment', async () => {
    const fetchImpl: FetchLike = async (url) => url.includes('_missing_')
      ? { status: 404, headers: { 'content-type': 'application/json' }, text: async () => '{}' }
      : { status: 200, headers: okHeaders, text: async () => 'ok' }
    const items = await runHttpPreflight('https://t1.example', fetchImpl)
    const { allPass, skipped } = formatReport(items)
    expect(allPass).toBe(true)
    expect(items.map((i) => i.name)).toEqual(['security-headers', 'document-security-headers', 'api-reachable', 'api-404-json', 'api-no-cache', 'assets-long-cache', 'cookie-host-only', 'session-cookie-attributes', 'public-page-noindex'])
    // ...but the three probe-dependent rows were NOT observed here, and say so rather than reading green.
    expect(skipped).toBe(4)
    expect(items.filter((i) => i.verdict.skipped).map((i) => i.name)).toEqual(['assets-long-cache', 'cookie-host-only', 'session-cookie-attributes', 'public-page-noindex'])
  })
  // #724: the row that would have caught the /api prefix break. Every other /api row answers a
  // question about a response's SHAPE, and a stack where nothing routes to the server satisfies
  // them all — a JSON 404 is exactly what a missing route produces.
  it('FAILS api-reachable on the shape of a broken edge (JSON 404 everywhere), which the other /api rows call compliant', async () => {
    const brokenEdge: FetchLike = async () => ({ status: 404, headers: { ...okHeaders, 'content-type': 'application/json' }, text: async () => '{"message":"Route GET:/api/healthz not found"}' })
    const items = await runHttpPreflight('https://t1.example', brokenEdge)
    expect(items.find((i) => i.name === 'api-404-json')!.verdict.pass, 'the old row calls total breakage compliant').toBe(true)
    expect(items.find((i) => i.name === 'api-reachable')!.verdict.pass, 'the new row is the one that notices').toBe(false)
  })
  it('FAILS api-reachable when the SPA answers /api (the edge has no rule for it)', async () => {
    const spaEverywhere: FetchLike = async () => ({ status: 200, headers: { ...okHeaders, 'content-type': 'text/html' }, text: async () => '<!doctype html><div id="root"></div>' })
    const items = await runHttpPreflight('https://t1.example', spaEverywhere)
    const row = items.find((i) => i.name === 'api-reachable')!
    expect(row.verdict.pass).toBe(false)
    expect(row.verdict.detail).toContain('SPA')
  })

  // #879: the app sets these headers itself, so a stack whose EDGE sets none still answers /api/healthz
  // with a full set. The document the browser loads comes from a different container, and that is the
  // response whose headers actually govern the browsing session.
  it('FAILS document-security-headers when only the API carries them, while the API row stays green', async () => {
    const edgeSetsNothing: FetchLike = async (url) => url.includes('/api/')
      ? { status: 200, headers: okHeaders, text: async () => 'ok' }
      : { status: 200, headers: { 'content-type': 'text/html' }, text: async () => '<!doctype html><div id="root"></div>' }
    const items = await runHttpPreflight('https://t1.example', edgeSetsNothing)
    expect(items.find((i) => i.name === 'security-headers')!.verdict.pass, 'the API answers for itself').toBe(true)
    const doc = items.find((i) => i.name === 'document-security-headers')!
    expect(doc.verdict.pass, 'the document the browser reads carries none').toBe(false)
    expect(doc.verdict.detail).toContain('Strict-Transport-Security')
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
