// #281 / ADR-121: social-login plumbing — the pure pieces. The auth-critical §3.5 fortress
// (email_verified gating domain auto-enroll) is tested in enroll-policy.test.ts (pure) and
// auto-enroll.test.ts (real DB/FGA); this file pins the claim coercion tri-state and the
// env-driven social button config (CE: no platform issuer → NO social, always).
import { describe, it, expect, afterEach } from 'vitest'
import { coerceEmailVerified } from '../auth/oidc.js'

const ENV_KEYS = ['PLATFORM_OIDC_ISSUER', 'PLATFORM_SOCIAL_PROVIDERS', 'PLATFORM_SOCIAL_HINT_PARAM'] as const
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]] as const))
afterEach(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })

describe('#281 coerceEmailVerified (tri-state, fail-safe)', () => {
  it('true only for boolean true / string "true"', () => {
    expect(coerceEmailVerified(true)).toBe(true)
    expect(coerceEmailVerified('true')).toBe(true)
  })
  it('false for boolean false / string "false"', () => {
    expect(coerceEmailVerified(false)).toBe(false)
    expect(coerceEmailVerified('false')).toBe(false)
  })
  it('null (UNKNOWN — never admits) for anything else', () => {
    for (const junk of [undefined, null, 1, 0, 'yes', 'TRUE ', '', {}, []]) {
      expect(coerceEmailVerified(junk)).toBe(null)
    }
  })
})

// RETIRED by #602 / ADR-206 §3 (user ruling): the social login path is gone — a provider is a preset
// CONNECTION now, and `loadSocialLogin` / PLATFORM_SOCIAL_PROVIDERS went with it. What this block
// measured (which slugs may become the broker's source hint) has no subject left. The neighbouring
// `coerceEmailVerified` tests stay: that claim handling is about OIDC identities generally, not about
// the retired route.
