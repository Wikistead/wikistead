// #311 / ADR-131 slice 3b + #391 / ADR-148: the flow-binding (login-CSRF / auth-code-injection) security
// branch of the authorize→consent handlers, tested at the route level — now INCLUDING the consent step:
// GET /complete peeks (non-destructive) and renders the consent page (mints nothing), POST /consent re-runs
// every check, consumes once, and mints/denies. A MINIMAL Fastify app (cookie + formbody + the flow plugin +
// a stub onRequest that injects tenant/db/user) is used instead of buildApp — the full app's background
// workers make its teardown hang, and this isolates exactly the handler checks.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import formbody from '@fastify/formbody'
import IORedis from 'ioredis'
import { mcpOAuthFlowPlugin } from '../routes/mcp-oauth-flow.js'
import { peekPendingAuthorize, savePendingAuthorize } from '../auth/mcp-oauth-store.js'

const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
// A fake tenant db whose resolveClient query returns one registered client — with an XSS-attempt client_name
// (stored RAW by DCR, exactly what ADR-148 says the consent page must escape).
const XSS_NAME = '"><script>alert(1)</script>'
const fakeDb = { sql: async () => [{ client_id: 'mcp_x', redirect_uris: ['https://claude.ai/cb'], client_name: XSS_NAME }] }
let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(cookie)
  await app.register(formbody)
  ;(app as unknown as { valkey: IORedis }).valkey = valkey
  app.addHook('onRequest', async (req) => {
    ;(req as unknown as { tenant: unknown }).tenant = { id: 'tenant_dev' }
    ;(req as unknown as { db: unknown }).db = fakeDb
    // /complete and /consent are member routes: the browser is authenticated (here, the "victim").
    if (req.url.startsWith('/mcp/oauth/complete') || req.url.startsWith('/mcp/oauth/consent')) {
      ;(req as unknown as { user: unknown }).user = { sub: 'victim', groups: [] }
    }
  })
  await app.register(mcpOAuthFlowPlugin)
  await app.ready()
})
afterAll(async () => { await app.close(); await valkey.quit() })

const AUTHORIZE = '/mcp/oauth/authorize?client_id=mcp_x&redirect_uri=' + encodeURIComponent('https://claude.ai/cb') +
  '&response_type=code&code_challenge=chal123&code_challenge_method=S256&scope=read+write&state=st'

// Start a flow: returns the reqId (from the login returnTo) + the mcp_flow cookie value (the flow nonce).
async function startFlow() {
  const res = await app.inject({ method: 'GET', url: AUTHORIZE })
  expect(res.statusCode).toBe(302)
  const returnTo = decodeURIComponent(new URL('http://x' + res.headers.location).searchParams.get('returnTo')!)
  const reqId = new URL('http://x' + returnTo).searchParams.get('req')!
  const setCookie = String(res.headers['set-cookie'])
  expect(setCookie).toMatch(/mcp_flow=/)
  expect(setCookie).toMatch(/HttpOnly/i)
  expect(setCookie).toMatch(/SameSite=Lax/i)
  const nonce = /mcp_flow=([^;]+)/.exec(setCookie)![1]!
  return { reqId, nonce }
}

const postConsent = (fields: Record<string, string>, cookies?: Record<string, string>) =>
  app.inject({
    method: 'POST', url: '/mcp/oauth/consent',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
    ...(cookies ? { cookies } : {}),
  })

describe('MCP authorize→complete flow-binding (#311 / ADR-131 slice 3b)', () => {
  it('a WELL-FORMED authorize redirects to login and sets an httpOnly SameSite=Lax flow cookie', async () => {
    const { reqId, nonce } = await startFlow()
    expect(reqId).toBeTruthy()
    expect(nonce).toBeTruthy()
  })

  it('SECURITY: /complete WITHOUT the flow cookie (the login-CSRF victim) → 400, no consent page', async () => {
    const { reqId } = await startFlow()
    const res = await app.inject({ method: 'GET', url: `/mcp/oauth/complete?req=${reqId}` }) // no cookie
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined() // never redirected to the client → no code minted
  })

  it('SECURITY: /complete with a MISMATCHED flow cookie → 400, no consent page', async () => {
    const { reqId } = await startFlow()
    const res = await app.inject({ method: 'GET', url: `/mcp/oauth/complete?req=${reqId}`, cookies: { mcp_flow: 'wrong-nonce' } })
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('an UNKNOWN redirect_uri is a DIRECT 400 (open-redirect defense) — never a redirect', async () => {
    const bad = '/mcp/oauth/authorize?client_id=mcp_x&redirect_uri=' + encodeURIComponent('https://evil.com/cb') +
      '&response_type=code&code_challenge=c&code_challenge_method=S256&scope=read'
    const res = await app.inject({ method: 'GET', url: bad })
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })
})

describe('MCP consent page (#391 / ADR-148 — GET renders, mints nothing)', () => {
  it('the MATCHING flow cookie → 200 consent page; NO code redirect; the pending is STILL consumable (peek); the flow cookie survives', async () => {
    const { reqId, nonce } = await startFlow()
    const res = await app.inject({ method: 'GET', url: `/mcp/oauth/complete?req=${reqId}`, cookies: { mcp_flow: nonce } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.headers.location).toBeUndefined() // login is NOT implicit approval any more
    // non-destructive GET: the pending request survives the render
    expect(await peekPendingAuthorize(valkey, reqId)).not.toBeNull()
    // the flow cookie is NOT cleared by the GET (it must survive to the POST for the double-submit check)
    expect(String(res.headers['set-cookie'] ?? '')).not.toMatch(/mcp_flow=;/)
  })

  it('shows the requested scopes + the redirect HOST from the STORED request (not query params)', async () => {
    const { reqId, nonce } = await startFlow()
    const res = await app.inject({ method: 'GET', url: `/mcp/oauth/complete?req=${reqId}&scope=admin`, cookies: { mcp_flow: nonce } })
    expect(res.body).toContain('Read your pages (read)')
    expect(res.body).toContain('Create and edit pages (write)')
    expect(res.body).toContain('claude.ai')
    expect(res.body).not.toContain('admin') // tampered current-query scope is ignored
  })

  it('ANTI-TEST (XSS, critical): a <script> client_name renders ESCAPED — never as live markup', async () => {
    const { reqId, nonce } = await startFlow()
    const res = await app.inject({ method: 'GET', url: `/mcp/oauth/complete?req=${reqId}`, cookies: { mcp_flow: nonce } })
    expect(res.body).not.toContain(XSS_NAME) // the raw string must not appear un-escaped
    expect(res.body).not.toContain('<script>alert(1)</script>')
    expect(res.body).toContain('&lt;script&gt;') // escaped text instead
  })

  it('ANTI-TEST (clickjacking): the consent response refuses framing (XFO DENY + CSP frame-ancestors none)', async () => {
    const { reqId, nonce } = await startFlow()
    const res = await app.inject({ method: 'GET', url: `/mcp/oauth/complete?req=${reqId}`, cookies: { mcp_flow: nonce } })
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'")
  })
})

describe('MCP consent approval (#391 / ADR-148 — POST consumes once, mints/denies)', () => {
  it('Approve consumes the pending, mints exactly one code for the victim sub, and redirects with code+state', async () => {
    const { reqId, nonce } = await startFlow()
    const res = await postConsent({ req: reqId, nonce, decision: 'approve' }, { mcp_flow: nonce })
    expect(res.statusCode).toBe(302)
    const loc = new URL(res.headers.location as string)
    expect(loc.origin + loc.pathname).toBe('https://claude.ai/cb')
    expect(loc.searchParams.get('code')).toBeTruthy()
    expect(loc.searchParams.get('state')).toBe('st')
    // consumed: the pending is gone (a replayed approve below asserts the 400)
    expect(await peekPendingAuthorize(valkey, reqId)).toBeNull()
  })

  it('Deny redirects with error=access_denied + the original state and mints NO code', async () => {
    const { reqId, nonce } = await startFlow()
    const res = await postConsent({ req: reqId, nonce, decision: 'deny' }, { mcp_flow: nonce })
    expect(res.statusCode).toBe(302)
    const loc = new URL(res.headers.location as string)
    expect(loc.origin + loc.pathname).toBe('https://claude.ai/cb')
    expect(loc.searchParams.get('error')).toBe('access_denied')
    expect(loc.searchParams.get('state')).toBe('st')
    expect(loc.searchParams.get('code')).toBeNull()
  })

  it('ANTI-TEST (CSRF): a POST WITHOUT the flow cookie (cross-site auto-submit) → 400, no code', async () => {
    const { reqId, nonce } = await startFlow()
    const res = await postConsent({ req: reqId, nonce, decision: 'approve' }) // no cookie
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('ANTI-TEST (CSRF): a POST whose FORM nonce mismatches the stored nonce → 400, no code', async () => {
    const { reqId, nonce } = await startFlow()
    const res = await postConsent({ req: reqId, nonce: 'forged', decision: 'approve' }, { mcp_flow: nonce })
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('ANTI-TEST (replay): a DOUBLE approve finds no pending on the 2nd POST → 400 (consume-once)', async () => {
    const { reqId, nonce } = await startFlow()
    const first = await postConsent({ req: reqId, nonce, decision: 'approve' }, { mcp_flow: nonce })
    expect(first.statusCode).toBe(302)
    const second = await postConsent({ req: reqId, nonce, decision: 'approve' }, { mcp_flow: nonce })
    expect(second.statusCode).toBe(400)
    expect(second.headers.location).toBeUndefined()
  })

  it('ANTI-TEST (tenant): a pending started under ANOTHER tenant → 400 on the POST (no cross-tenant code)', async () => {
    // Save a pending directly, as if the flow started on another tenant's host.
    const reqId = 'test-cross-tenant-req'
    const nonce = 'test-cross-tenant-nonce'
    await savePendingAuthorize(valkey, reqId, {
      clientId: 'mcp_x', redirectUri: 'https://claude.ai/cb', codeChallenge: 'c',
      scopes: ['read'], state: 'st', tenantId: 'tenant_OTHER', flowNonce: nonce,
    })
    const res = await postConsent({ req: reqId, nonce, decision: 'approve' }, { mcp_flow: nonce })
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('an unknown decision value → 400, the pending is consumed (fail closed), no redirect', async () => {
    const { reqId, nonce } = await startFlow()
    const res = await postConsent({ req: reqId, nonce, decision: 'maybe' }, { mcp_flow: nonce })
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
    expect(await peekPendingAuthorize(valkey, reqId)).toBeNull()
  })
})
