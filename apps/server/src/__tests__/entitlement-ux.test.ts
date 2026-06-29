// #109 / ADR-072: the two access-loss disclosure shapes must stay OPPOSITE — authz loss hides
// existence (404, no upgrade hint); entitlement loss is non-destructive (403 + upgrade affordance,
// never 404). This pins the contract so the two can't drift into the harmful conflation.
import { describe, it, expect } from 'vitest'
import { notFound, entitlementDenied } from '../entitlement-ux.js'

describe('access-loss disclosure shapes (#109 / ADR-072)', () => {
  it('authz loss is an existence-hiding 404 with NO upgrade hint (no existence leak)', () => {
    const e = notFound()
    expect(e.statusCode).toBe(404)
    expect(e.upgrade).toBeUndefined()    // never hint that restricted content exists / is upgradable
    expect(e.code).toBeUndefined()
  })

  it('entitlement loss is a non-destructive 403 with a stable code + upgrade affordance (never 404)', () => {
    const e = entitlementDenied('api', 'API keys are not available on this plan')
    expect(e.statusCode).toBe(403)       // NOT 404 — implies neither deletion nor non-existence
    expect(e.code).toBe('api_not_entitled')
    expect(e.upgrade).toBe(true)         // owner-actionable: upgrade to restore (data preserved)
  })

  it('derives the per-feature code consistently', () => {
    expect(entitlementDenied('custom_domain').code).toBe('custom_domain_not_entitled')
    expect(entitlementDenied('saml').code).toBe('saml_not_entitled')
  })
})
