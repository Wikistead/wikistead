// Host-mediated macro permission gate (#93 / ADR-073). first-party always runs; user/third-party
// require BOTH the userMacros entitlement AND the tenant-admin allowlist (either false → denied);
// macros never self-authorize. CE (UNLIMITED) still requires the admin opt-in.
import { describe, it, expect, afterEach } from 'vitest'
import { canRunMacro } from '../macro-permission.js'
import { UNLIMITED, registerEntitlementsResolver, resetEntitlementsResolver } from '@wikistead/entitlements'

afterEach(() => resetEntitlementsResolver())

describe('canRunMacro (#93 / ADR-073)', () => {
  it('first-party always runs (regardless of entitlement/allowlist)', () => {
    registerEntitlementsResolver(() => ({ ...UNLIMITED, userMacros: false }))
    expect(canRunMacro('any', 'first-party', false)).toBe(true)
  })

  it('user/third-party need BOTH userMacros entitlement AND the admin allowlist', () => {
    registerEntitlementsResolver(() => ({ ...UNLIMITED, userMacros: true }))
    expect(canRunMacro('p', 'user', true)).toBe(true) // entitled + allowed
    expect(canRunMacro('p', 'user', false)).toBe(false) // entitled but not allowlisted
    expect(canRunMacro('p', 'third-party', true)).toBe(true)

    registerEntitlementsResolver(() => ({ ...UNLIMITED, userMacros: false }))
    expect(canRunMacro('p', 'user', true)).toBe(false) // allowlisted but not entitled
  })

  it('default resolver is UNLIMITED (userMacros true) — CE still needs the admin allowlist', () => {
    expect(canRunMacro('selfhost', 'user', true)).toBe(true)
    expect(canRunMacro('selfhost', 'user', false)).toBe(false) // not opted in by the admin
  })
})
