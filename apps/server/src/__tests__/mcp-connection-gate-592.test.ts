// #592 / ADR-204: the MCP entry asks WHO asserted the subject, and a connection may withhold MCP.
//
// Two faces, and they have to be pinned together or the repair reads as a hole.
//
// The face that was BROKEN: since #570 every connection created through the admin surface stamps
// `wc<conn8>_` on the subs it mints, so a member of such a connection could complete the whole OAuth
// dance — login, consent, token — and then be 401'd by every tool call, because the entry ran the
// EXTERNAL gate on a sub our own code had minted and signed. This file drives that whole chain rather
// than hand-minting a token: minting a token directly and asserting 200 would satisfy the letter of the
// repair while testing none of the path that was broken.
//
// The face that must NOT move: membership is what admits. A reserved-prefix sub with no membership is
// still refused (reserved-subs-554 holds that one), a foreign-tenant or wrongly-signed token is still
// refused, and the external seams keep refusing reserved subs outright.
//
// And the new control (OQ3): MCP per connection, default on. Default on is the point — anything else
// would take a working integration away from someone the moment the migration ran.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { randomUUID, createHash } from 'node:crypto'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { provisionTenant } from '../auth/provisioning.js'
import { SESSION_COOKIE } from '../auth/session.js'
import { subjectPrefixFor } from '../routes/admin-connections.js'
import { startTestIssuer, type TestIssuer } from './helpers/oidc-issuer.js'
import { mintMcpAccessToken } from './helpers/reserved-subs-helper.js'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SLUG = `mcpg-${STAMP}`
const HOST = `${SLUG}.localhost`
const ADMIN_SUB = `mcpg-admin-${STAMP}`
const CLIENT_ID = 'wikistead-mcpg'
const EXT = `mcpg-ext-${STAMP}`

let app: FastifyInstance
let issuer: TestIssuer
let valkey: IORedis
let tenantId = ''
let mintingId = ''
let prefix = ''
let namespacedSub = ''
let clientId = ''

beforeAll(async () => {
  issuer = await startTestIssuer({ clientId: CLIENT_ID })
  tenantId = (await provisionTenant(fgaClient, { slug: SLUG, admin: { sub: ADMIN_SUB } })).tenantId
  // A MINTING connection — the #570 shape, which is the shape that was broken.
  mintingId = randomUUID()
  prefix = subjectPrefixFor(mintingId)
  namespacedSub = prefix + EXT
  await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, scopes, redirect_uri, enabled, sort, subject_prefix)
    VALUES (${mintingId}, ${tenantId}, ${issuer.url}, ${CLIENT_ID}, 'openid email profile', ${`http://${HOST}/auth/callback`}, true, 0, ${prefix})`
  app = await buildApp()
  await app.ready()
  valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
  issuer.setSubject(EXT, { email: 'ext@mcpg.test' })
  await writeTuples(fgaClient, [{ user: `user:${namespacedSub}`, relation: 'member', object: `tenant:${tenantId}` }])
  // The client registers itself the way a real MCP client does (RFC 7591 DCR) — authorize refuses an
  // unknown client outright, so a hand-written client_id would fail before reaching the seam under test.
  const reg = await app.inject({
    method: 'POST', url: '/mcp/oauth/register', headers: { host: HOST, 'content-type': 'application/json' },
    payload: { redirect_uris: ['https://claude.ai/cb'], client_name: 'mcpg probe', token_endpoint_auth_method: 'none' },
  })
  expect(reg.statusCode, reg.body).toBe(201)
  clientId = (reg.json() as { client_id: string }).client_id
}, 90_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [{ user: `user:${namespacedSub}`, relation: 'member', object: `tenant:${tenantId}` }]).catch(() => {})
  await valkey.quit(); await app.close(); await issuer.close()
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await admin.end(); await pool.end()
}, 90_000)

/** Sign in through the minting connection and return the session cookie of the namespaced member. */
async function loginNamespaced(): Promise<string> {
  const start = await app.inject({ method: 'GET', url: `/auth/login?connection=${mintingId}`, headers: { host: HOST } })
  expect(start.statusCode).toBe(302)
  const authRes = await fetch(start.headers.location as string, { redirect: 'manual' })
  const u = new URL(authRes.headers.get('location')!)
  const cb = await app.inject({ method: 'GET', url: u.pathname + u.search, headers: { host: HOST } })
  expect(cb.statusCode, `callback: ${cb.body?.slice(0, 300)}`).toBe(302)
  const sid = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(String(cb.headers['set-cookie'] ?? ''))?.[1]
  expect(sid, 'the namespaced login established a session').toBeTruthy()
  return sid!
}

/** The whole OAuth dance as a real client would run it: authorize → complete → consent → token. */
async function accessTokenThroughOAuth(sid: string): Promise<string> {
  const verifier = `ver-${randomUUID()}`
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const redirectUri = 'https://claude.ai/cb'
  const authorize = await app.inject({
    method: 'GET', headers: { host: HOST },
    url: `/mcp/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&scope=read&state=st`,
  })
  expect(authorize.statusCode, authorize.body).toBe(302)
  const returnTo = decodeURIComponent(new URL('http://x' + authorize.headers.location).searchParams.get('returnTo')!)
  const reqId = new URL('http://x' + returnTo).searchParams.get('req')!
  const nonce = /mcp_flow=([^;]+)/.exec(String(authorize.headers['set-cookie']))![1]!
  const consent = await app.inject({
    method: 'POST', url: '/mcp/oauth/consent',
    headers: { host: HOST, cookie: `${SESSION_COOKIE}=${sid}; mcp_flow=${nonce}`, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ req: reqId, nonce, decision: 'approve' }).toString(),
  })
  expect(consent.statusCode, 'the member approved').toBe(302)
  const code = new URL(consent.headers.location as string).searchParams.get('code')!
  const token = await app.inject({
    method: 'POST', url: '/mcp/oauth/token',
    headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'authorization_code', code, code_verifier: verifier,
      client_id: clientId, redirect_uri: redirectUri,
    }).toString(),
  })
  expect(token.statusCode, token.body).toBe(200)
  return (token.json() as { access_token: string }).access_token
}

const toolsList = (bearer: string) => app.inject({
  method: 'POST', url: '/mcp',
  headers: { host: HOST, authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
  payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
})

describe('#592: a namespaced member reaches MCP through the real flow', () => {
  it('login → authorize → consent → token → tools/list = 200', async () => {
    const sid = await loginNamespaced()
    const [row] = await admin<{ sub: string }[]>`SELECT sub FROM members WHERE tenant_id = ${tenantId} AND sub = ${namespacedSub}`
    expect(row, 'the login seated the member under the connection prefix').toBeDefined()
    const res = await toolsList(await accessTokenThroughOAuth(sid))
    expect(res.statusCode, 'this is the case that was 401 before the flip').toBe(200)
  }, 90_000)

  it('the checks ABOVE the flip are untouched: a foreign-tenant token and a wrongly-signed one are still 401', async () => {
    const foreign = await mintMcpAccessToken(
      { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 },
      { tenantId: 'tenant_dev', sub: namespacedSub, scopes: ['read'], groups: [] },
    )
    expect((await toolsList(foreign)).statusCode, 'minted for another tenant').toBe(401)
    const wrongKey = await mintMcpAccessToken(
      { secret: 'not-the-signing-secret', ttlSeconds: 300 },
      { tenantId, sub: namespacedSub, scopes: ['read'], groups: [] },
    )
    expect((await toolsList(wrongKey)).statusCode, 'signed with the wrong secret').toBe(401)
  }, 90_000)

  it('the length ruler is the INTERNAL budget: a sub FGA can store passes, one it cannot is refused', async () => {
    // 507 bytes is FGA's `user:<id>` budget minus `user:`. The external ruler (496) would refuse a
    // namespaced member whose raw sub is 486-496 bytes — legitimate, storable, and 401 before this.
    const long = prefix + 'x'.repeat(507 - prefix.length)
    const tooLong = prefix + 'x'.repeat(508 - prefix.length)
    const tuples = [{ user: `user:${long}`, relation: 'member', object: `tenant:${tenantId}` }]
    await writeTuples(fgaClient, tuples)
    try {
      const ok = await mintMcpAccessToken({ secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 },
        { tenantId, sub: long, scopes: ['read'], groups: [] })
      expect((await toolsList(ok)).statusCode, '507 bytes is exactly the budget').toBe(200)
      const over = await mintMcpAccessToken({ secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 },
        { tenantId, sub: tooLong, scopes: ['read'], groups: [] })
      expect((await toolsList(over)).statusCode, 'past the budget, refused at the seam not inside FGA').toBe(401)
    } finally {
      await deleteTuples(fgaClient, tuples).catch(() => {})
    }
  }, 90_000)
})

describe('#592: MCP is a per-connection switch, and the server is the wall', () => {
  it('a member of a switched-off connection is refused even holding a valid token', async () => {
    const sid = await loginNamespaced()
    const bearer = await accessTokenThroughOAuth(sid)
    expect((await toolsList(bearer)).statusCode, 'on by default').toBe(200)
    await admin`UPDATE tenant_oidc SET mcp_enabled = false WHERE id = ${mintingId}`
    try {
      // The SAME token — nothing was revoked, no session ended. The entry consults the connection.
      expect((await toolsList(bearer)).statusCode, 'the switch is enforced at the door, not in the UI').toBe(401)
    } finally {
      await admin`UPDATE tenant_oidc SET mcp_enabled = true WHERE id = ${mintingId}`
    }
    expect((await toolsList(bearer)).statusCode, 'and switching it back restores access').toBe(200)
  }, 90_000)

  it('the default takes nothing away: a member of a connection nobody has configured still reaches MCP', async () => {
    const [row] = await admin<{ mcp_enabled: boolean }[]>`SELECT mcp_enabled FROM tenant_oidc WHERE id = ${mintingId}`
    expect(row!.mcp_enabled, 'the column describes what was already true').toBe(true)
    const sid = await loginNamespaced()
    expect((await toolsList(await accessTokenThroughOAuth(sid))).statusCode).toBe(200)
  }, 90_000)

  it('a member with no connection prefix is unaffected — there is nothing to consult, and no access is lost', async () => {
    // The pre-#570 legacy connection does not namespace, so its members carry raw subs. The admin
    // surface says so (mcpEnforceable=false) instead of offering a switch that cannot bind.
    const tuples = [{ user: `user:${ADMIN_SUB}`, relation: 'member', object: `tenant:${tenantId}` }]
    await writeTuples(fgaClient, tuples).catch(() => {})
    const bearer = await mintMcpAccessToken({ secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 },
      { tenantId, sub: ADMIN_SUB, scopes: ['read'], groups: [] })
    await admin`UPDATE tenant_oidc SET mcp_enabled = false WHERE id = ${mintingId}`
    try {
      expect((await toolsList(bearer)).statusCode, "another connection's switch is not a tenant-wide one").toBe(200)
    } finally {
      await admin`UPDATE tenant_oidc SET mcp_enabled = true WHERE id = ${mintingId}`
    }
  }, 90_000)
})
