// ADR-259 §3.2/§3.4/§6.2 — the HTTP-level pins review's round-1 pass found missing (the tracker
// #948, comment on the rejection). The unit-level tests in auto-enroll.test.ts call
// `establishMemberSession` directly; this file drives the REAL `/auth/login` → IdP → `/auth/callback`
// round trip, because the two things those unit tests cannot see are:
//   - whether `routes/auth.ts` actually turns the thrown `address_taken` into
//     `/login?error=address_taken` (as opposed to some other error, or the vague catch-all every other
//     refusal collapses into) — the routing decision, not the fortress decision;
//   - ADR-197's retired anti-test, done properly: that suite (login-connections-s4-554) pre-seeds FGA
//     tuples directly and never reaches the seat fortress at all (measured and annotated there). This
//     file exercises the SAME shape — one external subject, two connections, one asserted email — but
//     through GENUINE fresh sign-ins with no pre-seeding, which is the scenario §3.2 actually changes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { fgaClient } from '@wikistead/authz'
import { provisionTenant } from '../auth/provisioning.js'
import { subjectPrefixFor } from '../routes/admin-connections.js'
import { SESSION_COOKIE } from '../auth/session.js'
import { startTestIssuer, type TestIssuer } from './helpers/oidc-issuer.js'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SLUG = `addrtaken-${STAMP}`
const HOST = `${SLUG}.localhost`
const ADMIN_SUB = `addrtaken-admin-${STAMP}`
const CLIENT_ID = 'wikistead-948'
const EXT = `948-ext-${STAMP}` // the external subject both connections authenticate
const EMAIL = `948-collide-${STAMP}@e2e.test`

let app: FastifyInstance
let issuer: TestIssuer
let tenantId = ''

beforeAll(async () => {
  issuer = await startTestIssuer({ clientId: CLIENT_ID })
  const t = await provisionTenant(fgaClient, { slug: SLUG, admin: { sub: ADMIN_SUB } })
  tenantId = t.tenantId
  // §3.2 fires on auto-enrolment, so the tenant's policy has to admit the sign-in — 'open' is the
  // widest, matching auto-enroll.test.ts's own choice for the same reason.
  await admin`INSERT INTO tenant_settings (tenant_id, enroll_policy) VALUES (${tenantId}, 'open')
              ON CONFLICT (tenant_id) DO UPDATE SET enroll_policy = 'open'`
  const connA = randomUUID()
  const connB = randomUUID()
  // connA MINTS a namespaced sub (subject_prefix set); connB is the LEGACY raw-sub connection — the
  // exact shape ADR-197's retired anti-test used, so the "two connections" half of §6.2 is genuine.
  await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, sort, trust_groups, label, subject_prefix)
    VALUES (${connA}, ${tenantId}, ${issuer.url}, ${CLIENT_ID}, NULL, 'openid email profile', ${`http://${HOST}/auth/callback`}, true, 0, true, 'Connection A', ${subjectPrefixFor(connA)})`
  await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, sort, trust_groups, label, subject_prefix)
    VALUES (${connB}, ${tenantId}, ${issuer.url}, ${CLIENT_ID}, NULL, 'openid email profile', ${`http://${HOST}/auth/callback`}, true, 1, true, 'Connection B', NULL)`
  app = await buildApp()
  await app.ready()
  issuer.setSubject(EXT, { email: EMAIL })
}, 60_000)

afterAll(async () => {
  await admin`DELETE FROM members WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await app.close()
  await issuer.close()
  await admin.end()
  await pool.end()
}, 60_000)

// Drive /auth/login?connection=<id> → IdP (real fetch) → /auth/callback, and return the callback's
// own response (never follows the final redirect — its Location and Set-Cookie are what we measure).
async function login(connection: string) {
  const start = await app.inject({ method: 'GET', url: `/auth/login?connection=${connection}`, headers: { host: HOST } })
  expect(start.statusCode).toBe(302)
  const authRes = await fetch(start.headers.location as string, { redirect: 'manual' })
  const u = new URL(authRes.headers.get('location')!)
  return app.inject({ method: 'GET', url: u.pathname + u.search, headers: { host: HOST } })
}

describe('ADR-259 §3.2/§3.4/§6.2: the HTTP callback, not just the fortress', () => {
  it('the first sign-in auto-enrols; the second, same address through a DIFFERENT connection, is refused with error=address_taken — not the vague catch-all', async () => {
    const [connA, connB] = (await admin<{ id: string; sort: number }[]>`
      SELECT id, sort FROM tenant_oidc WHERE tenant_id = ${tenantId} ORDER BY sort`).map((r) => r.id)

    const first = await login(connA!)
    expect(first.statusCode).toBe(302)
    expect(first.headers.location, 'the first sign-in succeeds — returnTo, not an error').not.toMatch(/error=/)
    expect(String(first.headers['set-cookie'] ?? ''), 'a real session for the first sign-in').toContain(`${SESSION_COOKIE}=`)

    // ADR-197's retired anti-test asserted this second call ALSO seats a member (two connections, one
    // address → two members, no collision). §3.2 reverses exactly that.
    const second = await login(connB!)
    expect(second.statusCode).toBe(302)
    expect(second.headers.location, 'the routing decision — address_taken, not the vague "access"').toBe('/login?error=address_taken')
    expect(String(second.headers['set-cookie'] ?? ''), 'no session for the refused sign-in').not.toContain(`${SESSION_COOKIE}=`)

    const rows = await admin<{ sub: string }[]>`SELECT sub FROM members WHERE tenant_id = ${tenantId} AND lower(email) = ${EMAIL.toLowerCase()}`
    expect(rows.length, 'one member holds the address — the pair the retired anti-test allowed does not exist').toBe(1)
  }, 60_000)
})
