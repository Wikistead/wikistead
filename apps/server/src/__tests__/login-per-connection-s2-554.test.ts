// #554 S2 / ADR-197 §2: per-connection OIDC start/callback — the B3 generalization. What this pins:
//   - ?connection=<id> starts a NAMED connection, including one the legacy first-row pick could
//     never reach (the second row) — and the full round trip seats a session through it;
//   - the state is BOUND to its connection: disabling the connection mid-flight closes the 300s
//     window with the unified 404 even though a SIBLING connection of the same kind stays effective
//     (the kind-level check alone would have completed the code against the wrong IdP);
//   - unknown / SAML-kind connection ids answer the same unified 404 as an unknown tenant;
//   - the connection-less legacy start keeps working (byte-compat, N=1 shape).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { fgaClient } from '@wikistead/authz'
import { provisionTenant } from '../auth/provisioning.js'
import { startTestIssuer, type TestIssuer } from './helpers/oidc-issuer.js'
import { SESSION_COOKIE } from '../auth/session.js'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SLUG = `s2pc-${STAMP}`
const HOST = `${SLUG}.localhost`
const CLIENT_ID = 'wikistead-s2'
const ADMIN_SUB = `s2pc-admin-${STAMP}`

let app: FastifyInstance
let issuer: TestIssuer
let tenantId = ''
let connA = ''
let connB = ''

const insertConn = async (id: string, sort: number) => {
  await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, sort)
    VALUES (${id}, ${tenantId}, ${issuer.url}, ${CLIENT_ID}, NULL, 'openid email profile', ${`http://${HOST}/auth/callback`}, true, ${sort})`
}

beforeAll(async () => {
  issuer = await startTestIssuer({ clientId: CLIENT_ID })
  const t = await provisionTenant(fgaClient, { slug: SLUG, admin: { sub: ADMIN_SUB } })
  tenantId = t.tenantId
  connA = randomUUID()
  connB = randomUUID()
  await insertConn(connA, 0)
  await insertConn(connB, 1)
  app = await buildApp()
  await app.ready()
  issuer.setSubject(ADMIN_SUB, { email: 'a@s2.test', name: 'S2 Admin' })
}, 60_000)

afterAll(async () => {
  await app.close()
  await issuer.close()
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await admin.end()
  await pool.end()
}, 60_000)

// Start the flow (optionally under a named connection) and return the callback path the IdP
// redirects back to — the same shape as auth-oidc.test.ts's helper.
async function start(connection?: string): Promise<{ status: number; cbPath?: string }> {
  const url = '/auth/login' + (connection ? `?connection=${encodeURIComponent(connection)}` : '')
  const res = await app.inject({ method: 'GET', url, headers: { host: HOST } })
  if (res.statusCode !== 302 || !String(res.headers.location).startsWith('http')) {
    return { status: res.statusCode }
  }
  const authRes = await fetch(res.headers.location as string, { redirect: 'manual' })
  const u = new URL(authRes.headers.get('location')!)
  return { status: 302, cbPath: u.pathname + u.search }
}
const cb = (path: string) => app.inject({ method: 'GET', url: path, headers: { host: HOST } })

describe('#554 S2: per-connection start/callback', () => {
  it('a NAMED second connection round-trips to a session (unreachable via the legacy first-row pick)', async () => {
    const { status, cbPath } = await start(connB)
    expect(status).toBe(302)
    const res = await cb(cbPath!)
    expect(res.statusCode).toBe(302)
    expect(String(res.headers['set-cookie'] ?? '')).toContain(`${SESSION_COOKIE}=`)
  }, 60_000)

  it('disabling the state\'s connection closes its window — even though a sibling of the SAME kind stays effective', async () => {
    const { status, cbPath } = await start(connB)
    expect(status).toBe(302)
    await admin`UPDATE tenant_oidc SET enabled = false WHERE id = ${connB}`
    try {
      const res = await cb(cbPath!)
      expect(res.statusCode, 'no fallback to connection A — the unified 404').toBe(404)
      expect(res.json()).toEqual({ error: 'not found' })
    } finally {
      await admin`UPDATE tenant_oidc SET enabled = true WHERE id = ${connB}`
    }
  }, 60_000)

  it('unknown and SAML-kind connection ids answer the unified 404 (the unknown-tenant body)', async () => {
    const unknown = await app.inject({ method: 'GET', url: `/auth/login?connection=${randomUUID()}`, headers: { host: HOST } })
    expect(unknown.statusCode).toBe(404)
    const samlId = randomUUID()
    await admin`INSERT INTO tenant_saml (id, tenant_id, idp_entity_id, sso_url, idp_cert_enc, sp_entity_id, acs_url, enabled)
      VALUES (${samlId}, ${tenantId}, 'https://idp.example/meta', 'https://idp.example/sso', 'enc', 'sp', 'https://wks/acs', true)`
    try {
      const saml = await app.inject({ method: 'GET', url: `/auth/login?connection=${samlId}`, headers: { host: HOST } })
      expect(saml.statusCode, 'a SAML connection is not an OIDC start').toBe(404)
      expect(saml.json()).toEqual(unknown.json())
      const noTenant = await app.inject({ method: 'GET', url: '/auth/login', headers: { host: 'nope.localhost' } })
      expect(saml.json(), 'indistinguishable from an unknown tenant').toEqual(noTenant.json())
    } finally {
      await admin`DELETE FROM tenant_saml WHERE id = ${samlId}`
    }
  }, 60_000)

  it('the connection-less legacy start still round-trips through the first connection (byte-compat)', async () => {
    const { status, cbPath } = await start()
    expect(status).toBe(302)
    const res = await cb(cbPath!)
    expect(res.statusCode).toBe(302)
    expect(String(res.headers['set-cookie'] ?? '')).toContain(`${SESSION_COOKIE}=`)
  }, 60_000)
})
