// #930 / ADR-263 §3.1, the same gap #948's own routing pins exist to close for the sibling refusal
// (address_taken): a unit test on `enrolUnderSeatCap` proves the FORTRESS refuses, not that
// `routes/auth.ts` actually turns the thrown `email_required` into `/login?error=email_required` — the
// ROUTING decision, distinct from the fortress decision, and the one place a translation can be wired
// into one door and silently missed on another (design-review finding on this ticket's own landing).
// Drives the REAL `/auth/login` → IdP → `/auth/callback` round trip through the auto-enrolment door.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { fgaClient } from '@wikistead/authz'
import { provisionTenant } from '../auth/provisioning.js'
import { SESSION_COOKIE } from '../auth/session.js'
import { startTestIssuer, type TestIssuer } from './helpers/oidc-issuer.js'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SLUG = `emailreq-${STAMP}`
const HOST = `${SLUG}.localhost`
const ADMIN_SUB = `emailreq-admin-${STAMP}`
const CLIENT_ID = 'wikistead-930'
const EXT_NO_EMAIL = `930-noemail-${STAMP}` // this subject's IdP session carries NO email claim
const EXT_WITH_EMAIL = `930-hasemail-${STAMP}`
const EMAIL = `930-real-${STAMP}@e2e.test`

let app: FastifyInstance
let issuer: TestIssuer
let tenantId = ''
let connId = ''

beforeAll(async () => {
  issuer = await startTestIssuer({ clientId: CLIENT_ID })
  const t = await provisionTenant(fgaClient, { slug: SLUG, admin: { sub: ADMIN_SUB } })
  tenantId = t.tenantId
  // §3.1 fires on auto-enrolment, so the policy has to admit the sign-in at all — 'open', the same
  // choice auto-enroll.test.ts and #948's own routing pin make for the identical reason.
  await admin`INSERT INTO tenant_settings (tenant_id, enroll_policy) VALUES (${tenantId}, 'open')
              ON CONFLICT (tenant_id) DO UPDATE SET enroll_policy = 'open'`
  connId = randomUUID()
  await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, sort, trust_groups, label)
    VALUES (${connId}, ${tenantId}, ${issuer.url}, ${CLIENT_ID}, NULL, 'openid email profile', ${`http://${HOST}/auth/callback`}, true, 0, true, 'Connection')`
  app = await buildApp()
  await app.ready()
}, 60_000)

afterAll(async () => {
  await admin`DELETE FROM members WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await app.close()
  await issuer.close()
  await admin.end()
  await pool.end()
}, 60_000)

// Same shape as #948's own `login()` helper: drive /auth/login → IdP (real fetch) → /auth/callback,
// and return the callback's own response without following the final redirect.
async function login() {
  const start = await app.inject({ method: 'GET', url: `/auth/login?connection=${connId}`, headers: { host: HOST } })
  expect(start.statusCode).toBe(302)
  const authRes = await fetch(start.headers.location as string, { redirect: 'manual' })
  const u = new URL(authRes.headers.get('location')!)
  return app.inject({ method: 'GET', url: u.pathname + u.search, headers: { host: HOST } })
}

describe('#930 / ADR-263 §3.1: the HTTP callback, not just the fortress', () => {
  it('a sign-in whose IdP releases NO email claim is refused error=email_required — not the vague catch-all', async () => {
    issuer.setSubject(EXT_NO_EMAIL) // no profile → no email claim, ADR-121's exact case
    const res = await login()
    expect(res.statusCode).toBe(302)
    expect(res.headers.location, 'the routing decision — email_required, not the vague "access"').toBe('/login?error=email_required')
    expect(String(res.headers['set-cookie'] ?? ''), 'no session for the refused sign-in').not.toContain(`${SESSION_COOKIE}=`)
    const rows = await admin<{ sub: string }[]>`SELECT sub FROM members WHERE tenant_id = ${tenantId} AND sub = ${EXT_NO_EMAIL}`
    expect(rows.length, 'no member seated for the refused identity').toBe(0)
  }, 60_000)

  it('the SAME connection, a subject WITH an email claim, auto-enrols normally — the floor is per-identity, not per-connection', async () => {
    issuer.setSubject(EXT_WITH_EMAIL, { email: EMAIL })
    const res = await login()
    expect(res.statusCode).toBe(302)
    expect(res.headers.location, 'a real sign-in — returnTo, not an error').not.toMatch(/error=/)
    expect(String(res.headers['set-cookie'] ?? ''), 'a real session').toContain(`${SESSION_COOKIE}=`)
  }, 60_000)
})
