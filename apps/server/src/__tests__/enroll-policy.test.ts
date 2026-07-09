import { describe, it, expect } from 'vitest'
import { enrollEligible, emailDomain, isEnrollPolicy, type EnrollInput } from '../auth/enroll-policy.js'

// #101 / ADR-034 (approved comment 712): the "WHO may auto-enrol" trust boundary — the two holes the ADR
// was bounced for (comment 340/406): domain enrol must require PROVEN ownership (a spoofed victim.com is
// rejected), and groups enrol must run on the NORMALISED claim (never the raw one). This locks the pure
// decision; the seat cap + login-path wiring are a later slice.
const base = (o: Partial<EnrollInput>): EnrollInput => ({ policy: 'open', groups: [], verifiedDomains: [], allowedGroups: [], ...o })

describe('enrollEligible — policy semantics (#101/ADR-034)', () => {
  it('open: any successful login enrols (the seat cap bounds how many, not who)', () => {
    expect(enrollEligible(base({ policy: 'open', email: 'anyone@wherever.test' }))).toBe(true)
    expect(enrollEligible(base({ policy: 'open' }))).toBe(true)
  })

  it('invite_only: never auto-enrols (only an invite accept does)', () => {
    expect(enrollEligible(base({ policy: 'invite_only', email: 'a@b.test', groups: ['admins'], allowedGroups: ['admins'], verifiedDomains: ['b.test'] }))).toBe(false)
  })
})

describe('enrollEligible — domain trust boundary (hole #1: proven ownership)', () => {
  it('enrols when the email domain is VERIFIED', () => {
    expect(enrollEligible(base({ policy: 'domain', email: 'alice@corp.test', emailVerified: true, verifiedDomains: ['corp.test'] }))).toBe(true)
  })

  it('does NOT enrol an UN-verified domain even if it is the login domain', () => {
    // domain in nobody's verified set → inert (the allow-list entry isn't proven)
    expect(enrollEligible(base({ policy: 'domain', email: 'alice@corp.test', verifiedDomains: [] }))).toBe(false)
  })

  it('rejects a victim.com spoof — an attacker tenant that has NOT proven victim.com never admits it', () => {
    // the attacker set domain=victim.com but only proved ownership of attacker.test
    expect(enrollEligible(base({ policy: 'domain', email: 'bob@victim.com', verifiedDomains: ['attacker.test'] }))).toBe(false)
  })

  it('is case-insensitive and rejects malformed / multi-@ emails', () => {
    expect(enrollEligible(base({ policy: 'domain', email: 'A@Corp.TEST', emailVerified: true, verifiedDomains: ['corp.test'] }))).toBe(true)
    expect(enrollEligible(base({ policy: 'domain', email: 'weird@a@corp.test', verifiedDomains: ['corp.test'] }))).toBe(false)
    expect(enrollEligible(base({ policy: 'domain', email: 'nodomain', verifiedDomains: ['corp.test'] }))).toBe(false)
    expect(enrollEligible(base({ policy: 'domain', email: undefined, verifiedDomains: ['corp.test'] }))).toBe(false)
  })
})

describe('enrollEligible — domain trust boundary (hole #3, #281/ADR-121 §3.5: IdP-verified email only)', () => {
  it('an UNVERIFIED email never domain-enrols, even on a fully verified domain (takeover-into-tenant closed)', () => {
    // The GitHub-style brokered case: alice@corp.test is asserted but NOT verified by the IdP, while
    // corp.test IS the victim tenant's DNS-verified domain. The server must reject regardless of what
    // the broker (Authentik source) passed through — the server is the fortress, not the source config.
    expect(enrollEligible(base({ policy: 'domain', email: 'alice@corp.test', emailVerified: false, verifiedDomains: ['corp.test'] }))).toBe(false)
  })

  it('a MISSING/unknown email_verified claim fails safe (invite path), never admits', () => {
    expect(enrollEligible(base({ policy: 'domain', email: 'alice@corp.test', emailVerified: null, verifiedDomains: ['corp.test'] }))).toBe(false)
    expect(enrollEligible(base({ policy: 'domain', email: 'alice@corp.test', verifiedDomains: ['corp.test'] }))).toBe(false) // omitted entirely
  })

  it('email_verified does not leak into other policies (open still admits, groups unaffected)', () => {
    expect(enrollEligible(base({ policy: 'open', emailVerified: false }))).toBe(true)
    expect(enrollEligible(base({ policy: 'groups', emailVerified: false, groups: ['eng'], allowedGroups: ['eng'] }))).toBe(true)
  })
})

describe('enrollEligible — groups trust boundary (hole #2: normalised claim only)', () => {
  it('enrols when a NORMALISED group intersects the allow-list (case-insensitive)', () => {
    expect(enrollEligible(base({ policy: 'groups', groups: ['Engineering', 'people'], allowedGroups: ['engineering'] }))).toBe(true)
  })

  it('does NOT enrol when no group intersects', () => {
    expect(enrollEligible(base({ policy: 'groups', groups: ['contractors'], allowedGroups: ['engineering', 'admins'] }))).toBe(false)
  })

  it('an empty (or coerced-away) groups claim never enrols', () => {
    // coerceGroups turns a non-array / junk claim into [] upstream; [] must not admit.
    expect(enrollEligible(base({ policy: 'groups', groups: [], allowedGroups: ['engineering'] }))).toBe(false)
  })

  it('an empty allow-list never enrols even with groups present', () => {
    expect(enrollEligible(base({ policy: 'groups', groups: ['engineering'], allowedGroups: [] }))).toBe(false)
  })
})

describe('helpers', () => {
  it('emailDomain extracts the lower-cased domain of a single clean address', () => {
    expect(emailDomain('a@b.test')).toBe('b.test')
    expect(emailDomain('A@B.TEST')).toBe('b.test')
    expect(emailDomain('a@a@b.test')).toBeNull()
    expect(emailDomain('nope')).toBeNull()
    expect(emailDomain('')).toBeNull()
    expect(emailDomain(undefined)).toBeNull()
  })

  it('isEnrollPolicy guards the 4 values', () => {
    expect(isEnrollPolicy('open')).toBe(true)
    expect(isEnrollPolicy('domain')).toBe(true)
    expect(isEnrollPolicy('groups')).toBe(true)
    expect(isEnrollPolicy('invite_only')).toBe(true)
    expect(isEnrollPolicy('OPEN')).toBe(false)
    expect(isEnrollPolicy('anything')).toBe(false)
    expect(isEnrollPolicy(undefined)).toBe(false)
  })
})
