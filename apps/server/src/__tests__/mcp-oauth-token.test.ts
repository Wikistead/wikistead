// #311 / ADR-131 slice 4: the token endpoint. Tests verifyPkceS256 (pure) and the full code→token exchange with
// every binding (PKCE / client_id / redirect_uri / tenant / single-use) via a minimal Fastify app (formbody +
// the token plugin + a stub onRequest injecting req.tenant) — buildApp hangs on teardown, this isolates the
// exchange. The minted token is verified with verifyMcpAccessToken.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import formbody from '@fastify/formbody'
import IORedis from 'ioredis'
import { createHash } from 'node:crypto'
import { verifyMcpAccessToken } from '@wikistead/auth'
import { saveAuthCode, type AuthCode } from '../auth/mcp-oauth-store.js'
import { verifyPkceS256, mcpOAuthTokenPlugin } from '../routes/mcp-oauth-token.js'

const SECRET = process.env.GUEST_TOKEN_SECRET!
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const VERIFIER = 'the-code-verifier-0123456789-abcdefghijklmnop'
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')
let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(formbody)
  ;(app as unknown as { valkey: IORedis }).valkey = valkey
  app.addHook('onRequest', async (req) => { (req as unknown as { tenant: unknown }).tenant = { id: 'tenant_dev' } })
  await app.register(mcpOAuthTokenPlugin)
  await app.ready()
})
afterAll(async () => { await app.close(); await valkey.quit() })

const CODE_BINDING: AuthCode = {
  sub: 'user-1', tenantId: 'tenant_dev', clientId: 'mcp_x', redirectUri: 'https://claude.ai/cb',
  codeChallenge: CHALLENGE, scopes: ['read', 'write'],
}
async function issueCode(code: string, over: Partial<AuthCode> = {}) {
  await saveAuthCode(valkey, code, { ...CODE_BINDING, ...over })
}
const post = (body: Record<string, string>) => app.inject({ method: 'POST', url: '/mcp/oauth/token', payload: new URLSearchParams(body).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
const goodBody = (code: string) => ({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'mcp_x', redirect_uri: 'https://claude.ai/cb' })

describe('verifyPkceS256 (#311 / ADR-131 slice 4)', () => {
  it('accepts the matching verifier, rejects a wrong/empty one', () => {
    expect(verifyPkceS256(VERIFIER, CHALLENGE)).toBe(true)
    expect(verifyPkceS256('wrong', CHALLENGE)).toBe(false)
    expect(verifyPkceS256('', CHALLENGE)).toBe(false)
    expect(verifyPkceS256(VERIFIER, '')).toBe(false)
  })
})

describe('POST /mcp/oauth/token — code → tenant-bound access token (#311 / ADR-131 slice 4)', () => {
  it('exchanges a valid code for a tenant-bound access token (verifiable, correct sub/scopes)', async () => {
    const c = `tk_ok_${Date.now()}`
    await issueCode(c)
    const res = await post(goodBody(c))
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.token_type).toBe('Bearer')
    expect(body.scope).toBe('read write')
    const claims = await verifyMcpAccessToken({ secret: SECRET, ttlSeconds: 3600 }, body.access_token)
    expect(claims).toMatchObject({ sub: 'user-1', tenantId: 'tenant_dev', scopes: ['read', 'write'] })
  })

  it('rejects a WRONG PKCE verifier (invalid_grant) — the code was already consumed (single-use)', async () => {
    const c = `tk_pkce_${Date.now()}`
    await issueCode(c)
    const res = await post({ ...goodBody(c), code_verifier: 'not-the-verifier' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_grant')
    // and the code is now consumed (GETDEL) → a retry with the right verifier also fails.
    expect((await post(goodBody(c))).statusCode).toBe(400)
  })

  it('rejects a mismatched client_id / redirect_uri, and a cross-tenant code', async () => {
    const c1 = `tk_cid_${Date.now()}`; await issueCode(c1)
    expect((await post({ ...goodBody(c1), client_id: 'mcp_other' })).json().error).toBe('invalid_grant')
    const c2 = `tk_ru_${Date.now()}`; await issueCode(c2)
    expect((await post({ ...goodBody(c2), redirect_uri: 'https://claude.ai/other' })).json().error).toBe('invalid_grant')
    const c3 = `tk_tn_${Date.now()}`; await issueCode(c3, { tenantId: 'tenant_other' }) // code for another tenant
    expect((await post(goodBody(c3))).json().error).toBe('invalid_grant') // req.tenant is tenant_dev
  })

  it('rejects an unknown/consumed code and a wrong grant_type', async () => {
    expect((await post(goodBody('no-such-code'))).json().error).toBe('invalid_grant')
    expect((await post({ ...goodBody('x'), grant_type: 'password' })).json().error).toBe('unsupported_grant_type')
  })
})
