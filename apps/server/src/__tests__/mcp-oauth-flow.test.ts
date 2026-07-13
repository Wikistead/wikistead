// #311 / ADR-131 slice 3b: the flow-binding (login-CSRF / auth-code-injection) security branch of the
// authorize→complete handlers, tested at the route level. A MINIMAL Fastify app (cookie plugin + the flow
// plugin + a stub onRequest that injects tenant/db/user) is used instead of buildApp — the full app's background
// workers make its teardown hang, and this isolates exactly the handler cookie check.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import IORedis from 'ioredis'
import { mcpOAuthFlowPlugin } from '../routes/mcp-oauth-flow.js'

const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
// A fake tenant db whose resolveClient query returns one registered client.
const fakeDb = { sql: async () => [{ client_id: 'mcp_x', redirect_uris: ['https://claude.ai/cb'] }] }
let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(cookie)
  ;(app as unknown as { valkey: IORedis }).valkey = valkey
  app.addHook('onRequest', async (req) => {
    ;(req as unknown as { tenant: unknown }).tenant = { id: 'tenant_dev' }
    ;(req as unknown as { db: unknown }).db = fakeDb
    // /complete is a member route: the completing browser is authenticated (here, the "victim").
    if (req.url.startsWith('/mcp/oauth/complete')) (req as unknown as { user: unknown }).user = { sub: 'victim', groups: [] }
  })
  await app.register(mcpOAuthFlowPlugin)
  await app.ready()
})
afterAll(async () => { await app.close(); await valkey.quit() })

const AUTHORIZE = '/mcp/oauth/authorize?client_id=mcp_x&redirect_uri=' + encodeURIComponent('https://claude.ai/cb') +
  '&response_type=code&code_challenge=chal123&code_challenge_method=S256&scope=read&state=st'

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

describe('MCP authorize→complete flow-binding (#311 / ADR-131 slice 3b)', () => {
  it('a WELL-FORMED authorize redirects to login and sets an httpOnly SameSite=Lax flow cookie', async () => {
    const { reqId, nonce } = await startFlow()
    expect(reqId).toBeTruthy()
    expect(nonce).toBeTruthy()
  })

  it('SECURITY: /complete WITHOUT the flow cookie (the login-CSRF victim) → 400, no code issued', async () => {
    const { reqId } = await startFlow()
    const res = await app.inject({ method: 'GET', url: `/mcp/oauth/complete?req=${reqId}` }) // no cookie
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined() // never redirected to the client → no code minted
  })

  it('SECURITY: /complete with a MISMATCHED flow cookie → 400, no code', async () => {
    const { reqId } = await startFlow()
    const res = await app.inject({ method: 'GET', url: `/mcp/oauth/complete?req=${reqId}`, cookies: { mcp_flow: 'wrong-nonce' } })
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('the MATCHING flow cookie → 302 to the registered redirect_uri with ?code&state', async () => {
    const { reqId, nonce } = await startFlow()
    const res = await app.inject({ method: 'GET', url: `/mcp/oauth/complete?req=${reqId}`, cookies: { mcp_flow: nonce } })
    expect(res.statusCode).toBe(302)
    const loc = new URL(res.headers.location as string)
    expect(loc.origin + loc.pathname).toBe('https://claude.ai/cb')
    expect(loc.searchParams.get('code')).toBeTruthy()
    expect(loc.searchParams.get('state')).toBe('st')
  })

  it('an UNKNOWN redirect_uri is a DIRECT 400 (open-redirect defense) — never a redirect', async () => {
    const bad = '/mcp/oauth/authorize?client_id=mcp_x&redirect_uri=' + encodeURIComponent('https://evil.com/cb') +
      '&response_type=code&code_challenge=c&code_challenge_method=S256&scope=read'
    const res = await app.inject({ method: 'GET', url: bad })
    expect(res.statusCode).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })
})
