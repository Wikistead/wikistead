// #828 / ADR-254 Decision 5: a deployment that cannot address its mail says WHICH step ran out, and
// says it when it happens.
//
// The old answer was a bare `string | null`, so the only thing the drain could report was the name
// of a variable. An operator who set `WKS_PUBLIC_BASE_URL` to something unparseable and one who
// never set it got the SAME sentence, and their next actions are different. Naming a variable is
// not naming a step.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tenantBaseUrl, noAddressReason, composeTenantUrl } from '../email/base-url.js'

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
