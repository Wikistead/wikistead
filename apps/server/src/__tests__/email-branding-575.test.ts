// #575 / ADR-200 slice B: notification mail wears the tenant's brand, and the digest can be
// unsubscribed from without stopping mentions.
//
// Mail was the only surface with no branding at all — a tenant that had set its name and logo still
// got messages from an unnamed product. The tenant layer already existed; mail had nowhere to put it.
//
// Four things the ADR called out, each of which had already bitten something:
//   - the display name is ESCAPED. It is stored with a trim and a length cap and nothing else, and the
//     unsubscribe page is a raw HTML template on the same origin as the session cookie (ADR-016), so an
//     unescaped name there is stored XSS against the session surface.
//   - the tenant logo URL carries `/api`. Without it the path hits the SPA's index.html and every mail
//     shows a broken image. The BUNDLED mark is an SPA asset and takes no prefix — two different shapes.
//   - an unentitled tenant falls back to the bundled mark, not to nothing.
//   - the digest's unsubscribe token says `digest`. An `immediate` one — what copying the mention
//     builder produces — makes "stop the digest" silently stop MENTIONS. That is the only realistic
//     bug here, so it is the one pinned hardest.
import { describe, it, expect } from 'vitest'
import { renderBrandedHtml, renderBrandedText, brandName, brandLogoUrl, esc } from '../email/layout.js'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const base = { productName: 'Wikistead', displayName: null, logoUrl: null, whitelabel: false }

describe('#575: what a mail is branded with', () => {
  it('the tenant name wins over the product name', () => {
    expect(brandName({ ...base, displayName: 'Acme Wiki' })).toBe('Acme Wiki')
    expect(brandName(base), 'and the deployment name is the fallback (#143 order)').toBe('Wikistead')
    expect(brandName({ ...base, displayName: '   ' }), 'blank is not a name').toBe('Wikistead')
  })

  it('the tenant logo is fetched through /api; the bundled mark is not', () => {
    expect(brandLogoUrl({ ...base, logoUrl: '/branding/logo' }, 'https://x.test')).toBe('https://x.test/api/branding/logo')
    expect(brandLogoUrl(base, 'https://x.test'), 'the bundled mark is an SPA asset').toBe('https://x.test/icon-email.png')
  })

  it('an unentitled tenant gets the bundled mark rather than no mark', () => {
    // getTenantBranding strips logoUrl when the plan is not entitled; the fallback must not be "nothing"
    const html = renderBrandedHtml({ branding: { ...base, displayName: 'Acme', logoUrl: null }, baseUrl: 'https://x.test', body: '<p>b</p>', footer: 'f' })
    expect(html).toContain('icon-email.png')
  })
})

describe('#575: the bundled fallback mark is something a mail client will actually draw', () => {
  // The ADR fixed this constraint in its own Dark-mode section — "Gmail does not support SVG" — and the
  // first cut of the fallback pointed at `icon-solid.svg` anyway. The rule outlived the code by one
  // slice, so it is pinned here: every deployment that has not uploaded a logo (CE's default, dev, and
  // every unentitled tenant) is the case this fallback serves, and an SVG serves none of them.
  const url = brandLogoUrl(base, 'https://x.test')

  it('is not an SVG', () => {
    expect(url, 'Gmail draws nothing for an SVG <img>').not.toMatch(/\.svg$/)
    expect(url).toMatch(/\.png$/)
  })

  it('and the asset it names exists in the SPA public root', () => {
    const file = url.slice('https://x.test/'.length)
    const onDisk = resolve(import.meta.dirname, '../../../web/public', file)
    expect(existsSync(onDisk), `${file} is served from apps/web/public and must be committed`).toBe(true)
  })

  it('with no transparency, so a dark-mode client cannot show the mark on its own dark background', () => {
    // The mark is a dark rounded square; left transparent, its corners take on whatever the client
    // paints behind them, which in dark mode is the thing the mark is supposed to sit against.
    const file = url.slice('https://x.test/'.length)
    const png = readFileSync(resolve(import.meta.dirname, '../../../web/public', file))
    // IHDR: width(4) height(4) bitDepth(1) colourType(1) — 6 = RGB, 2 = RGB, 0 = grey; +4 = alpha.
    const colourType = png[25]!
    expect(colourType & 4, 'the alpha bit must be off (bake the light background in)').toBe(0)
    expect(png.includes(Buffer.from('tRNS')), 'nor a palette transparency chunk').toBe(false)
  })
})

describe('#575: the display name is escaped everywhere it is rendered', () => {
  const hostile = '<script>alert(1)</script>'

  it('in the HTML shell', () => {
    const html = renderBrandedHtml({ branding: { ...base, displayName: hostile }, baseUrl: 'https://x.test', body: '<p>b</p>', footer: 'f' })
    expect(html, 'the name is text, not markup').not.toContain('<script>')
    expect(html).toContain(esc(hostile))
  })

  it('in the alt attribute, where a quote would break out', () => {
    const html = renderBrandedHtml({ branding: { ...base, displayName: 'a" onerror="x' }, baseUrl: 'https://x.test', body: '', footer: '' })
    expect(html).not.toContain('onerror="x"')
    expect(html).toContain('&quot;')
  })
})

describe('#575: the Powered by line follows #430, not a rule of its own', () => {
  it('a free tenant shows it', () => {
    expect(renderBrandedHtml({ branding: base, baseUrl: 'https://x.test', body: '', footer: '' })).toContain('Powered by Wikistead')
    expect(renderBrandedText({ branding: base, body: '', footer: '' })).toContain('Powered by Wikistead')
  })

  it('a white-label tenant does not', () => {
    const b = { ...base, whitelabel: true }
    expect(renderBrandedHtml({ branding: b, baseUrl: 'https://x.test', body: '', footer: '' })).not.toContain('Powered by')
    expect(renderBrandedText({ branding: b, body: '', footer: '' })).not.toContain('Powered by')
  })
})

describe('#575: the digest unsubscribes from the DIGEST', () => {
  const src = readFileSync(resolve(import.meta.dirname, '../email/digest.ts'), 'utf8')

  it("mints its token with action 'digest', not 'immediate'", () => {
    expect(src).toMatch(/action: 'digest'/)
    expect(src, "an 'immediate' token here stops mentions when someone stops the digest").not.toMatch(/action: 'immediate'/)
  })

  it('carries the one-click headers it never had', () => {
    expect(src).toMatch(/'List-Unsubscribe'/)
    expect(src).toMatch(/'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'/)
  })

  it('and the mention builder still mints its own action (non-regression)', () => {
    const mention = readFileSync(resolve(import.meta.dirname, '../email/mention-builder.ts'), 'utf8')
    expect(mention).toMatch(/action: 'immediate'/)
  })
})
