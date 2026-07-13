// #311 / ADR-131 slice 3b: the consume-once Valkey stores + the redirect-URL builder for the authorization-code
// flow. redirectWithParams is pure; the stores use a real Valkey (the auth-session.test pattern — own IORedis,
// quit in teardown, no full app so no hang).
import { describe, it, expect, afterAll } from 'vitest'
import IORedis from 'ioredis'
import {
  savePendingAuthorize, consumePendingAuthorize, saveAuthCode, consumeAuthCode, redirectWithParams,
} from '../auth/mcp-oauth-store.js'

const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
afterAll(async () => { await valkey.quit() })

describe('redirectWithParams (#311 / ADR-131 slice 3b)', () => {
  it('appends code+state, preserves existing query, encodes values', () => {
    expect(redirectWithParams('https://claude.ai/cb', { code: 'abc', state: 's 1' }))
      .toBe('https://claude.ai/cb?code=abc&state=s+1')
    expect(redirectWithParams('https://claude.ai/cb?x=1', { code: 'abc' }))
      .toBe('https://claude.ai/cb?x=1&code=abc')
    // undefined values are skipped (no `state=undefined`).
    expect(redirectWithParams('https://claude.ai/cb', { error: 'invalid_request', state: undefined }))
      .toBe('https://claude.ai/cb?error=invalid_request')
  })
})

describe('pending-authorize store — consume-once (#311 / ADR-131 slice 3b)', () => {
  it('save → consume returns the request; a second consume returns null (GETDEL, no replay)', async () => {
    const id = `t_${Date.now()}_p`
    await savePendingAuthorize(valkey, id, { clientId: 'mcp_x', redirectUri: 'https://c/cb', codeChallenge: 'ch', scopes: ['read'], state: 's', tenantId: 'tenant_dev', flowNonce: 'nonce1' })
    const first = await consumePendingAuthorize(valkey, id)
    expect(first).toMatchObject({ clientId: 'mcp_x', redirectUri: 'https://c/cb', tenantId: 'tenant_dev', flowNonce: 'nonce1' })
    expect(await consumePendingAuthorize(valkey, id)).toBeNull() // consumed
    expect(await consumePendingAuthorize(valkey, '')).toBeNull()
  })
})

describe('auth-code store — consume-once (#311 / ADR-131 slice 3b)', () => {
  it('save → consume returns the code binding; a second consume returns null', async () => {
    const code = `t_${Date.now()}_c`
    await saveAuthCode(valkey, code, { sub: 'u1', tenantId: 'tenant_dev', clientId: 'mcp_x', redirectUri: 'https://c/cb', codeChallenge: 'ch', scopes: ['read', 'write'] })
    const first = await consumeAuthCode(valkey, code)
    expect(first).toMatchObject({ sub: 'u1', clientId: 'mcp_x', codeChallenge: 'ch', scopes: ['read', 'write'] })
    expect(await consumeAuthCode(valkey, code)).toBeNull() // one-time
  })
})
