// Unit/integration tests for the C3a primitives: secret encryption + boot
// assert, OIDC state store (consume-once), and the returnTo open-redirect guard.
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import IORedis from 'ioredis'
import { assertSecretKey, encryptSecret, decryptSecret } from '../auth/secret-crypto.js'
import { saveState, consumeState } from '../auth/oidc-state.js'
import { safeReturnTo } from '../auth/return-to.js'

const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
afterAll(() => valkey.quit())

describe('secret-crypto (AES-256-GCM, fail-closed key)', () => {
  const saved = process.env.OIDC_SECRET_ENC_KEY
  afterEach(() => { process.env.OIDC_SECRET_ENC_KEY = saved }) // restore the real key

  it('round-trips a secret', () => {
    const enc = encryptSecret('s3cr3t-client-secret')
    expect(enc).not.toContain('s3cr3t') // not plaintext
    expect(decryptSecret(enc)).toBe('s3cr3t-client-secret')
  })

  it('produces a different ciphertext each time (random IV)', () => {
    expect(encryptSecret('x')).not.toBe(encryptSecret('x'))
  })

  it('boot assert FAILS CLOSED when the key is missing', () => {
    delete process.env.OIDC_SECRET_ENC_KEY
    expect(() => assertSecretKey()).toThrow(/not set/i)
  })

  it('boot assert FAILS CLOSED when the key is the wrong length', () => {
    process.env.OIDC_SECRET_ENC_KEY = Buffer.from('too-short').toString('base64')
    expect(() => assertSecretKey()).toThrow(/32 bytes/i)
  })
})

describe('oidc-state (short-lived, consume-once)', () => {
  it('a state can be consumed exactly once (GETDEL)', async () => {
    const state = 'st-' + Math.random().toString(36).slice(2)
    await saveState(valkey, state, { nonce: 'n', codeVerifier: 'v', tenantId: 'tenant_dev', returnTo: '/' })
    const first = await consumeState(valkey, state)
    expect(first).toMatchObject({ nonce: 'n', tenantId: 'tenant_dev' })
    const second = await consumeState(valkey, state) // reuse → null
    expect(second).toBeNull()
  })

  it('an unknown state returns null', async () => {
    expect(await consumeState(valkey, 'never-existed')).toBeNull()
    expect(await consumeState(valkey, '')).toBeNull()
  })
})

describe('safeReturnTo (open-redirect guard)', () => {
  it('keeps same-origin relative paths', () => {
    expect(safeReturnTo('/p/demo')).toBe('/p/demo')
    expect(safeReturnTo('/spaces?x=1')).toBe('/spaces?x=1')
  })
  it('rejects anything that could leave the origin', () => {
    for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', 'evil.com', 'javascript:alert(1)', '', '/out\nback']) {
      expect(safeReturnTo(bad)).toBe('/')
    }
    expect(safeReturnTo(undefined)).toBe('/')
    expect(safeReturnTo(123)).toBe('/')
  })
})
