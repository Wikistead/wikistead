// #281 / ADR-121: social-login plumbing — the pure pieces. The auth-critical §3.5 fortress
// (email_verified gating domain auto-enroll) is tested in enroll-policy.test.ts (pure) and
// auto-enroll.test.ts (real DB/FGA); this file pins the claim coercion tri-state and the
// env-driven social button config (CE: no platform issuer → NO social, always).
import { describe, it, expect, afterEach } from 'vitest'
import { coerceEmailVerified, loadSocialLogin } from '../auth/oidc.js'

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

describe('#281 loadSocialLogin (env config; CE always empty)', () => {
  it('CE (no platform issuer): no social providers regardless of the provider list', () => {
    delete process.env.PLATFORM_OIDC_ISSUER
    process.env.PLATFORM_SOCIAL_PROVIDERS = 'google,github'
    expect(loadSocialLogin().providers).toEqual([])
  })
  it('Cloud: parses the CSV, lower-cases, and drops junk slugs', () => {
    process.env.PLATFORM_OIDC_ISSUER = 'https://id.example'
    process.env.PLATFORM_SOCIAL_PROVIDERS = ' Google , github, micro soft, <script>, microsoft '
    expect(loadSocialLogin().providers).toEqual(['google', 'github', 'microsoft'])
  })
  it('unset provider list → no buttons; hint param defaults to "source" and is overridable', () => {
    process.env.PLATFORM_OIDC_ISSUER = 'https://id.example'
    delete process.env.PLATFORM_SOCIAL_PROVIDERS
    expect(loadSocialLogin().providers).toEqual([])
    expect(loadSocialLogin().hintParam).toBe('source')
    process.env.PLATFORM_SOCIAL_HINT_PARAM = 'kc_idp_hint'
    expect(loadSocialLogin().hintParam).toBe('kc_idp_hint')
  })
})
