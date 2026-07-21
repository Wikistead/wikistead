// #471 / ADR-176: a member principal must be bound to the tenant it is used against.
//
// Until this landed, membership was checked at LOGIN and nowhere else. Every other way of becoming
// `req.user` — an OIDC bearer token, an API key, an EE provider, the dev bypass — skipped it, and
// the tenant came from the Host. Under a shared IdP that means a member of tenant A was accepted
// verbatim on tenant B's host, and reached everything granted through a `user:*` wildcard: measured
// on a throwaway tenant, an outsider created a space they then managed inside it (#471).
//
// These are authorization-boundary tests, so they are mandatory rather than nice to have. Note
// especially the FIRST one: it mints a real RS256 token from a real JWKS endpoint and presents it
// over HTTP, which is the end-to-end demonstration the ADR could only reason about from the code.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from 'jose'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { registerAuthProvider, resetAuthProviders } from '@wikistead/hooks'
import { groupFgaId } from '../auth/group-sync.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')

// A dedicated tenant that the token's owner is NOT a member of. The token's owner IS a member of
// tenant_dev, so the pair is exactly the shared-IdP situation: same issuer, different tenant.
const OTHER_SLUG = 'mb471'
const OTHER_ID = 'tenant_mb471'
const INSIDER = 'mb471-insider' // a member of tenant_dev
const GROUP_MEMBER = 'mb471-grp' // a member of tenant_dev only through a group
const GROUP_NAME = 'mb471-team'

let app: FastifyInstance
let devTenant: Tenant
let devDb: TenantDb
let jwks: { url: string; mint: (sub: string, claims?: Record<string, unknown>) => Promise<string>; close: () => Promise<void> }

/** A real JWKS endpoint plus a signer for it — the app verifies against this exactly as it would Authentik. */
async function startJwksIssuer(issuerUrl: string) {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = await exportJWK(publicKey)
  Object.assign(jwk, { kid: 'mb471', alg: 'RS256', use: 'sig' })
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ keys: [jwk] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}/jwks`,
    async mint(sub: string, claims: Record<string, unknown> = {}) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'mb471' })
        .setIssuer(issuerUrl)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey as KeyLike)
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

beforeAll(async () => {
  const issuer = 'https://idp.mb471.test/'
  jwks = await startJwksIssuer(issuer)
  process.env.OIDC_ISSUER = issuer
  process.env.OIDC_JWKS_URI = jwks.url
  app = await buildApp()
  await app.ready()

  devTenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  devDb = await acquireTenantDb(devTenant)
  await admin`INSERT INTO tenants (id, slug, plan, isolation) VALUES (${OTHER_ID}, ${OTHER_SLUG}, 'free', 'logical') ON CONFLICT (id) DO NOTHING`
  // start from an empty tenant: a run of this suite against a build WITHOUT the binding leaves the
  // intruder's space behind, and "nothing landed" must mean this run, not the history of the stack
  await admin`DELETE FROM spaces WHERE tenant_id = ${OTHER_ID}`
  // one at a time: OpenFGA rejects a whole batch if any tuple in it already exists
  for (const tuple of [
    { user: `user:${INSIDER}`, relation: 'member', object: `tenant:${devTenant.id}` },
    // the group-derived member has NO direct user tuple: membership reaches them only through the group
    { user: `user:${GROUP_MEMBER}`, relation: 'member', object: `group:${groupFgaId(devTenant.id, GROUP_NAME)}` },
    { user: `group:${groupFgaId(devTenant.id, GROUP_NAME)}#member`, relation: 'member', object: `tenant:${devTenant.id}` },
    // the other tenant is provisioned the way a real one is, space-creation grant and all — that
    // grant is what an outsider actually rode in on
    { user: `tenant:${OTHER_ID}#member`, relation: 'space_creator', object: `tenant:${OTHER_ID}` },
  ]) await writeTuples(fgaClient, [tuple]).catch(() => {})
}, 40_000)

afterAll(async () => {
  resetAuthProviders()
  await deleteTuples(fgaClient, [
    { user: `user:${INSIDER}`, relation: 'member', object: `tenant:${devTenant.id}` },
    { user: `user:${GROUP_MEMBER}`, relation: 'member', object: `group:${groupFgaId(devTenant.id, GROUP_NAME)}` },
    { user: `group:${groupFgaId(devTenant.id, GROUP_NAME)}#member`, relation: 'member', object: `tenant:${devTenant.id}` },
    { user: `tenant:${OTHER_ID}#member`, relation: 'space_creator', object: `tenant:${OTHER_ID}` },
  ]).catch(() => {})
  await admin`DELETE FROM api_keys WHERE tenant_id = ${OTHER_ID}`
  await admin`DELETE FROM spaces WHERE tenant_id = ${OTHER_ID}`
  await admin`DELETE FROM tenants WHERE id = ${OTHER_ID}`
  await devDb?.release()
  await app.close()
  await jwks.close()
  await valkey.quit()
  await admin.end()
  await pool.end()
})

const get = (url: string, host: string, token: string) =>
  app.inject({ method: 'GET', url, headers: { host, authorization: `Bearer ${token}` } })

describe('#471 / ADR-176: the tenant binding', () => {
  it('refuses a bearer token from another tenant, and says nothing more than "unauthorized"', async () => {
    const token = await jwks.mint(INSIDER)

    const ownTenant = await get('/me/capabilities', 'dev.localhost', token)
    expect(ownTenant.statusCode, 'the legitimate case still works').toBe(200)

    const crossTenant = await get('/me/capabilities', `${OTHER_SLUG}.localhost`, token)
    expect(crossTenant.statusCode, 'the same token elsewhere is refused').toBe(401)

    // byte-identical to a plain bad token: a distinguishable message would tell an attacker which
    // tenants a sub they can authenticate as actually belongs to
    const garbage = await get('/me/capabilities', `${OTHER_SLUG}.localhost`, 'not-a-token')
    expect(crossTenant.body).toBe(garbage.body)
  })

  it('refuses the write that measurably went through: creating a space in a stranger\'s tenant', async () => {
    const token = await jwks.mint(INSIDER)
    const res = await app.inject({
      method: 'POST', url: '/spaces',
      headers: { host: `${OTHER_SLUG}.localhost`, authorization: `Bearer ${token}` },
      payload: { name: 'intruder' },
    })
    // before the binding this answered 201 and wrote space#manager to the intruder (#471)
    expect(res.statusCode, 'this created a managed space before #471').toBe(401)
    const spaces = await admin`SELECT id FROM spaces WHERE tenant_id = ${OTHER_ID}`
    expect(spaces.length, 'and nothing landed in the other tenant').toBe(0)
  })

  it('refuses a token whose own tenant claim disagrees with the host it is presented to', async () => {
    const token = await jwks.mint(INSIDER, { tenant: OTHER_ID })
    const res = await get('/me/capabilities', 'dev.localhost', token)
    expect(res.statusCode).toBe(401)
    // …while a token with no tenant claim at all is unaffected: the verifier returns "" for an absent
    // claim, so comparing unconditionally would reject every real token issued today
    expect((await get('/me/capabilities', 'dev.localhost', await jwks.mint(INSIDER))).statusCode).toBe(200)
  })

  it('admits a member who only holds membership through a group', async () => {
    const res = await get('/me/capabilities', 'dev.localhost', await jwks.mint(GROUP_MEMBER))
    expect(res.statusCode, 'FGA is the authority — a members-row read would miss this member').toBe(200)
  })

  it('refuses a member the moment their membership ends, mid-session', async () => {
    const sub = 'mb471-removed'
    await writeTuples(fgaClient, [{ user: `user:${sub}`, relation: 'member', object: `tenant:${devTenant.id}` }])
    const sid = await createSession(valkey, { tenantId: devTenant.id, sub, role: 'member' })
    const cookie = `${SESSION_COOKIE}=${sid}`
    const before = await app.inject({ method: 'GET', url: '/me/capabilities', headers: { host: 'dev.localhost', cookie } })
    expect(before.statusCode).toBe(200)

    await deleteTuples(fgaClient, [{ user: `user:${sub}`, relation: 'member', object: `tenant:${devTenant.id}` }])
    const after = await app.inject({ method: 'GET', url: '/me/capabilities', headers: { host: 'dev.localhost', cookie } })
    expect(after.statusCode, 'resolved per request, so removal takes effect on the next call').toBe(401)
  })

  it('refuses to mint an API key for someone outside the tenant, and refuses one already minted', async () => {
    const outsider = await jwks.mint(INSIDER)
    const mint = await app.inject({
      method: 'POST', url: '/api-keys',
      headers: { host: `${OTHER_SLUG}.localhost`, authorization: `Bearer ${outsider}` },
      payload: { name: 'foothold' },
    })
    expect(mint.statusCode, 'the route had no membership gate of its own — the seam is the gate').toBe(401)

    // …and a key minted through the hole before the fix: the binding stops it at use, and the
    // migration (infra/openfga/migrate-471-nonmember-api-keys.ts) revokes the row itself.
    // a REAL key row, hashed the way the issuer hashes it, so the refusal below can only be about
    // membership — a bogus hash would 401 for the boring reason and pin nothing
    const plaintext = `wks_mb471pre_${'a'.repeat(32)}`
    const hash = createHash('sha256').update(plaintext).digest('hex')
    const [row] = await admin`
      INSERT INTO api_keys (tenant_id, owner_user_id, name, key_prefix, key_hash, scope)
      VALUES (${OTHER_ID}, ${INSIDER}, 'legacy foothold', 'mb471pre', ${hash}, 'write')
      RETURNING id` as unknown as { id: string }[]
    const used = await app.inject({
      method: 'GET', url: '/me/capabilities',
      headers: { host: `${OTHER_SLUG}.localhost`, authorization: `Bearer ${plaintext}` },
    })
    expect(used.statusCode, 'a key issued through the hole no longer authenticates').toBe(401)
    await admin`DELETE FROM api_keys WHERE id = ${row.id}`
  })

  it('applies to a principal an EE auth provider resolves, not only to the OIDC branch', async () => {
    // The provider loop runs BEFORE the OIDC branch, so a binding written inside that branch would
    // never see this principal. Registering a provider that vouches for a non-member proves the seam
    // sits at the confluence.
    registerAuthProvider({ name: 'mb471-dummy', verify: async (token) => (token === 'mb471-vouched' ? { sub: 'mb471-outsider', groups: [] } : null) })
    const res = await get('/me/capabilities', 'dev.localhost', 'mb471-vouched')
    expect(res.statusCode, 'a provider cannot vouch someone into a tenant they do not belong to').toBe(401)
    resetAuthProviders()
  })
})
