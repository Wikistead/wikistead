// #623 (ruling③④): a tenant holds at most MAX_OIDC_CONNECTIONS connections, and the sign-in
// screen shows every one it holds.
//
// This list CANNOT page: reordering saves the complete ordered id list, so a page would let a tenant
// hold connections it can neither see nor reorder; and the same rows are sign-in buttons, where "load
// more ways to sign in" is not a product. So the bound is on what can EXIST — refused at ISSUE with a
// 409, never a display-side cut (#642: a table that trims what it shows while the write keeps minting
// is how invisible rows are born).
//
// The ruling ties ③ (how many can be created) to ④ (how many are shown) with ONE number, and that
// equality is the second pin here: a tenant AT the cap sees every connection on /auth/login-options.
// Without it, a cap on creation plus a slice on display would still manufacture invisible connections
// — from the other side.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { fgaClient, writeTuples } from '@wikistead/authz'
import { MAX_OIDC_CONNECTIONS } from '../routes/admin-connections.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
// A private tenant: the fillers below crowd the connection table right up to the cap, and on the
// shared tenant_dev that would flip every legacy `ORDER BY sort, id LIMIT 1` reader mid-suite.
const TENANT_ID = 'tenant_conn_cap'
const SLUG = 'conncap'
const H = { host: `${SLUG}.localhost`, authorization: 'Bearer dev-token', 'content-type': 'application/json' }

let app: FastifyInstance

/** One enabled, resolvable connection row, inserted directly (the POST under test is the thing being counted). */
async function seedConnection(n: number): Promise<void> {
  await admin`
    INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, redirect_uri, enabled, sort)
    VALUES (${randomUUID()}, ${TENANT_ID}, ${`https://idp${n}.example`}, ${`client-${n}`},
            'https://app.example/auth/callback', TRUE, ${n})`
}

beforeAll(async () => {
  await admin`INSERT INTO tenants (id, slug, plan) VALUES (${TENANT_ID}, ${SLUG}, 'business')
              ON CONFLICT (id) DO UPDATE SET slug = ${SLUG}, plan = 'business'`
  for (const t of [
    { user: 'user:dev-user', relation: 'admin', object: `tenant:${TENANT_ID}` },
    { user: 'user:dev-user', relation: 'member', object: `tenant:${TENANT_ID}` },
  ]) await writeTuples(fgaClient, [t]).catch(() => {})
  await admin`DELETE FROM tenant_oidc WHERE tenant_id = ${TENANT_ID}`
  app = await buildApp(); await app.ready()
}, 120_000)

afterAll(async () => {
  await admin`DELETE FROM tenant_oidc WHERE tenant_id = ${TENANT_ID}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${TENANT_ID}`.catch(() => {})
  await app.close(); await admin.end(); await pool.end()
}, 120_000)

const createOne = () =>
  app.inject({
    method: 'POST', url: '/admin/connections', headers: H,
    payload: JSON.stringify({
      issuer: 'https://one-more.example', clientId: 'overflow', redirectUri: 'https://app.example/auth/callback',
    }),
  })

describe('#623 ③④: the connection cap, and the equality it exists for', () => {
  it('below the cap a connection can still be created (the control)', async () => {
    // Without this, a guard that refused every POST would pass the case below.
    for (let n = 0; n < MAX_OIDC_CONNECTIONS - 1; n++) await seedConnection(n)
    const res = await createOne()
    expect(res.statusCode, res.body).toBe(201)
  }, 120_000)

  it(`the ${MAX_OIDC_CONNECTIONS + 1}th is refused with its own code, and nothing is written`, async () => {
    // The tenant is now AT the cap (the control just filled the last slot).
    const [{ n }] = await admin<[{ n: number }]>`
      SELECT COUNT(*)::int AS n FROM tenant_oidc WHERE tenant_id = ${TENANT_ID}`
    expect(n, 'the fixture is at the cap').toBe(MAX_OIDC_CONNECTIONS)

    const res = await createOne()
    expect(res.statusCode, res.body).toBe(409)
    // The CODE, not the sentence — prose is rewritten; the code is the contract the screen maps.
    expect(res.json<{ code: string }>().code).toBe('connection_limit_reached')

    const [{ after }] = await admin<[{ after: number }]>`
      SELECT COUNT(*)::int AS after FROM tenant_oidc WHERE tenant_id = ${TENANT_ID}`
    expect(after, 'the refused connection left no row').toBe(MAX_OIDC_CONNECTIONS)
  }, 120_000)

  it('a tenant AT the cap sees every connection on the sign-in screen (created = shown)', async () => {
    // ④, measured against ③ rather than against a literal: the ruling's point is the EQUALITY. A
    // display-side slice — the defect #642 named from the other direction — goes red here whatever
    // the cap's value is.
    //
    // The control's POST creates DISABLED (enabled is an explicit act, with a discovery check in
    // front of it), and a disabled connection is rightly not a sign-in button. The claim here is
    // about ENABLED rows, so the fixture flips that one on directly — first measured without this
    // and the screen honestly showed 19.
    await admin`UPDATE tenant_oidc SET enabled = TRUE WHERE tenant_id = ${TENANT_ID} AND enabled = FALSE`
    const res = await app.inject({ method: 'GET', url: '/auth/login-options', headers: { host: `${SLUG}.localhost` } })
    expect(res.statusCode, res.body).toBe(200)
    const { connections } = res.json<{ connections: { kind: string }[] }>()
    const oidc = connections.filter((c) => c.kind === 'oidc')
    expect(oidc.length, 'a connection that could be created cannot be seen').toBe(MAX_OIDC_CONNECTIONS)
  }, 120_000)

  it('the screen is told the cap by the server (no client-side copy of the ruling)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/login-methods', headers: H })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json<{ oidcConnectionCap: number }>().oidcConnectionCap).toBe(MAX_OIDC_CONNECTIONS)
  }, 120_000)
})
