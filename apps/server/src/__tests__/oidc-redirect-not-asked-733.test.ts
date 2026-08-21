// #733: the product must not ask for a value it does not use.
//
// The defect: the OIDC connection form REQUIRED a redirect URI (400 when empty), stored it in
// `tenant_oidc.redirect_uri` — and no code path ever read it back. The login flow derives the URI
// from the request instead (`${protocol}://${host}/auth/callback`, routes/auth.ts) and hands that to
// buildLogin. So an administrator who typed a different value was told nothing here, and the sign-in
// failed at the IdP with no message pointing back at the field they had filled in.
//
// Two pins, and they are deliberately of different kinds:
//   1. the API accepts a connection WITHOUT a redirect URI — the contract change (ruling (a));
//   2. the login redirect the server actually sends carries the DERIVED value — the property that
//      made the field pointless, asserted against the real authorize URL rather than reasoned about.
//
// (2) is what stops a future "let's honour the stored value after all" from passing quietly: the
// derivation follows the host, which is why a stored value would break a workspace the day it moves
// to a custom domain (#664's family of failure).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { fgaClient } from '@wikistead/authz'
import { provisionTenant } from '../auth/provisioning.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { startTestIssuer, type TestIssuer } from './helpers/oidc-issuer.js'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SLUG = `oidcr-${STAMP}`
const HOST = `${SLUG}.localhost`
const ADMIN_SUB = `oidcr-admin-${STAMP}`
const CLIENT_ID = 'wikistead-733'

let app: FastifyInstance
let issuer: TestIssuer
let tenantId = ''
let sid = ''
let valkey: IORedis
const H = () => ({ host: HOST, cookie: `${SESSION_COOKIE}=${sid}`, 'content-type': 'application/json' })

beforeAll(async () => {
  issuer = await startTestIssuer({ clientId: CLIENT_ID })
  const t = await provisionTenant(fgaClient, { slug: SLUG, admin: { sub: ADMIN_SUB } })
  tenantId = t.tenantId
  app = await buildApp()
  await app.ready()
  valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
  sid = await createSession(valkey, { tenantId, sub: ADMIN_SUB, role: 'admin' })
}, 60_000)

afterAll(async () => {
  await valkey.quit()
  await app.close()
  await issuer.close()
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await admin.end()
  await pool.end()
}, 60_000)

describe('#733: the redirect URI is shown, not asked for', () => {
  it('creates a connection with no redirect URI at all, and stores no value', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/connections', headers: H(),
      payload: { issuer: issuer.url, clientId: CLIENT_ID, label: 'Corp SSO' },
    })
    expect(res.statusCode, res.body).toBe(201)
    const id = (res.json() as { id: string }).id
    const [row] = await admin<{ redirect_uri: string }[]>`
      SELECT redirect_uri FROM tenant_oidc WHERE id = ${id}`
    // The column survives (ruling residual, its removal is another ticket) and is simply empty.
    expect(row?.redirect_uri).toBe('')

    // …and issuer + client id are still required. Dropping one requirement must not drop the others:
    // an issuer-less connection is not a connection.
    const noIssuer = await app.inject({
      method: 'POST', url: '/admin/connections', headers: H(), payload: { clientId: CLIENT_ID, label: 'Corp SSO' },
    })
    expect(noIssuer.statusCode).toBe(400)
  })

  it('sends the DERIVED redirect_uri to the IdP, ignoring whatever the column holds', async () => {
    // A connection whose stored value is deliberately wrong — the state an administrator could
    // previously reach by typing a typo into the field this ticket removed.
    const id = randomUUID()
    await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, sort, trust_groups)
      VALUES (${id}, ${tenantId}, ${issuer.url}, ${CLIENT_ID}, NULL, 'openid email profile',
              'https://typo.example/wrong-callback', true, 0, true)`

    const res = await app.inject({ method: 'GET', url: `/auth/login?connection=${id}`, headers: { host: HOST } })
    expect(res.statusCode).toBe(302)
    const sent = new URL(res.headers.location as string).searchParams.get('redirect_uri')
    expect(sent, 'the IdP is given the host the browser used, not the stored string').toBe(
      `http://${HOST}/auth/callback`,
    )
    expect(sent).not.toContain('typo.example')
  })
})
