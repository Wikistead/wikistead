// #828 / ADR-254 Decision 5: a deployment that cannot address its mail says WHICH step ran out, and
// says it when it happens.
//
// The old answer was a bare `string | null`, so the only thing the drain could report was the name
// of a variable. An operator who set `WKS_PUBLIC_BASE_URL` to something unparseable and one who
// never set it got the SAME sentence, and their next actions are different. Naming a variable is
// not naming a step.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tenantBaseUrl, noAddressReason, composeTenantUrl } from '../email/base-url.js'
// @ts-expect-error — repo-root script module, no types (#621 convention)
import { ENV_DOCS } from '../../../../scripts/env-catalog.mjs'

// The custom-domain step is a query; everything else is env. A stub that returns rows or none is the
// whole surface — the LIVE ordering (a verified domain wins, a demoted one stops winning) is #576's
// integration file and is not re-measured here.
const noDomain = (async () => []) as never
const oneDomain = (async () => [{ domain: 'kb.example.com' }]) as never
const T = { id: 't1', slug: 'acme' }

let saved: string | undefined
beforeEach(() => { saved = process.env.WKS_PUBLIC_BASE_URL })
afterEach(() => { if (saved === undefined) delete process.env.WKS_PUBLIC_BASE_URL; else process.env.WKS_PUBLIC_BASE_URL = saved })

describe('#828 the address says which step ran out', () => {
  it('a verified custom domain wins and nothing ran out', async () => {
    delete process.env.WKS_PUBLIC_BASE_URL
    const a = await tenantBaseUrl(oneDomain, T)
    expect(a.url).toBe('https://kb.example.com')
    expect(a.ranOut, 'a step was reported as exhausted while an address was found').toEqual([])
  })

  it('the declared zone composes the workspace address, and nothing ran out', async () => {
    process.env.WKS_PUBLIC_BASE_URL = 'https://wikistead.example.com'
    const a = await tenantBaseUrl(noDomain, T)
    expect(a.url).toBe('https://acme.wikistead.example.com')
    expect(a.ranOut).toEqual([])
  })

  it('unset and unparseable are DIFFERENT sentences — the point of the slice', async () => {
    delete process.env.WKS_PUBLIC_BASE_URL
    const unset = await tenantBaseUrl(noDomain, T)
    process.env.WKS_PUBLIC_BASE_URL = 'wikistead.example.com' // no scheme: `new URL` refuses it
    const malformed = await tenantBaseUrl(noDomain, T)

    expect(unset.url).toBeNull()
    expect(malformed.url, 'a value `new URL` cannot parse produced an address').toBeNull()
    expect(noAddressReason(unset)).toBe('no verified custom domain, no WKS_PUBLIC_BASE_URL, so no link')
    expect(noAddressReason(malformed)).toBe('no verified custom domain, WKS_PUBLIC_BASE_URL is not a URL, so no link')
    expect(noAddressReason(unset), 'the two failures collapsed back into one sentence')
      .not.toBe(noAddressReason(malformed))
  })

  it('⚠️ counts the steps: three clauses today, four when slice 3 lands', async () => {
    // ADR-254 § Slices states the wording explicitly — "no verified custom domain, no
    // WKS_PUBLIC_BASE_URL, so no link" — and slice 3 (the ADR-249 template, held until #123 by the
    // ruling of 2026-08-22) inserts ONE more step. Counting rather than string-matching is what
    // makes that an array entry instead of a prose rewrite, and it is why `ranOut` is a list.
    delete process.env.WKS_PUBLIC_BASE_URL
    const a = await tenantBaseUrl(noDomain, T)
    expect(a.ranOut.length, 'a step was added or removed without the wording following').toBe(2)
    expect(noAddressReason(a).split(', ').length).toBe(3)
  })

  it('the bare composer still answers for the callers that only want the address', () => {
    // ⚠️ `composeTenantUrl` reads "" exactly as it reads unset — which is what the compose profile
    // relies on (#828 slice 1 blanks the value rather than deleting the line, because `env_file:`
    // would otherwise let the operator's own `.env` show through).
    expect(composeTenantUrl('acme', undefined)).toBeNull()
    expect(composeTenantUrl('acme', ''), 'a blank value composed an address').toBeNull()
    expect(composeTenantUrl('acme', 'https://wikistead.example.com:8443'), 'the port was dropped')
      .toBe('https://acme.wikistead.example.com:8443')
  })
})

describe('#828 the catalog entry has one reading', () => {
  it('the example it prints is the composition the code performs', () => {
    // ADR-254 Decision 1. The ambiguity was never in the code — `.env.example` has always said the
    // zone — but in this sentence, which described the APPLICATION's own origin while the only
    // consumer prefixed a slug onto it. Making the example executable is what stops it drifting
    // back: a prose fix nothing runs is one edit from being wrong again.
    const what = String((ENV_DOCS as Record<string, { what: string }>).WKS_PUBLIC_BASE_URL.what)
    const example = what.match(/`(https?:\/\/[^`]+)` produces `(https?:\/\/<slug>\.[^`]+)`/)
    expect(example, `the catalog stopped showing a composition example:\n${what}`).not.toBeNull()
    const [, zone, claimed] = example!
    expect(composeTenantUrl('acme', zone!), 'the catalog promises a composition the code does not perform')
      .toBe(claimed!.replace('<slug>', 'acme'))
  })

  it('it names the zone rather than the application origin', () => {
    const what = String((ENV_DOCS as Record<string, { what: string }>).WKS_PUBLIC_BASE_URL.what)
    expect(what, 'the entry no longer says the slug is prefixed — the reading that broke mail is back')
      .toMatch(/slug is prefixed/)
  })
})
