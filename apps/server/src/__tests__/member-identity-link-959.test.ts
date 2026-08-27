// #858 / #959, ADR-259 §3.1 + §3.9: the member_identities link table, and the login-resolution
// precedence it exists to give — "a stored link wins over the deterministic mint" (routes/auth.ts).
//
// The pin that carries weight is §5's own case: put a link on member ONE, then sign in through a
// MINTING connection with the external subject connection B would deterministically mint as member
// TWO's sub — while member TWO's row is still there, live. ADR-259 names the wrong implementation by
// name: "prefer the link only when the minted sub has no member row" passes every other link case
// while reproducing this exact defect (#807's own pair). So the fixture builds member TWO first
// (through a real sign-in, so its row is the product's own mint) and only THEN links member ONE to
// the same (connection, external subject) — asserting B's next sign-in resolves to ONE, with TWO's
// row untouched and unreachable.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { provisionTenant } from '../auth/provisioning.js'
import { SESSION_COOKIE, readSession } from '../auth/session.js'
import { subjectPrefixFor } from '../routes/admin-connections.js'
import { startTestIssuer, type TestIssuer } from './helpers/oidc-issuer.js'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SLUG = `mil959-${STAMP}`
const HOST = `${SLUG}.localhost`
const ADMIN_SUB = `mil959-admin-${STAMP}`
const CLIENT_ID = 'wikistead-mil959'
const EXT = `mil959-ext-${STAMP}` // the external subject the minting connection asserts

let app: FastifyInstance
let issuer: TestIssuer
let tenantId = ''
let valkey: IORedis
let minting = ''
let prefix = ''

beforeAll(async () => {
  issuer = await startTestIssuer({ clientId: CLIENT_ID })
  const t = await provisionTenant(fgaClient, { slug: SLUG, admin: { sub: ADMIN_SUB } })
  tenantId = t.tenantId
  minting = randomUUID()
  prefix = subjectPrefixFor(minting)
  await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, sort, trust_groups, subject_prefix)
    VALUES (${minting}, ${tenantId}, ${issuer.url}, ${CLIENT_ID}, NULL, 'openid email profile', ${`http://${HOST}/auth/callback`}, true, 0, true, ${prefix})`
  app = await buildApp()
  await app.ready()
  valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
}, 60_000)

afterAll(async () => {
  await valkey.quit()
  await app.close()
  await issuer.close()
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await admin.end()
  await pool.end()
}, 60_000)

// Drives one full OIDC round trip through the minting connection and returns the sid the callback set.
const signIn = async (): Promise<string> => {
  const res = await app.inject({ method: 'GET', url: `/auth/login?connection=${minting}`, headers: { host: HOST } })
  expect(res.statusCode).toBe(302)
  const authRes = await fetch(res.headers.location as string, { redirect: 'manual' })
  const u = new URL(authRes.headers.get('location')!)
  const cb = await app.inject({ method: 'GET', url: u.pathname + u.search, headers: { host: HOST } })
  expect(cb.statusCode).toBe(302)
  const sid = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(String(cb.headers['set-cookie'] ?? ''))?.[1]
  expect(sid, 'session established').toBeTruthy()
  return sid!
}

describe('#959 member_identities: schema', () => {
  it('one external identity resolves to exactly one member (UNIQUE); a member\'s deletion takes its links; a freeze does not', async () => {
    const oneSub = `mil959-one-${STAMP}`
    const twoSub = `mil959-two-${STAMP}`
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenantId}, ${oneSub}, ${'one@mil959.test'}, 'member')`
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenantId}, ${twoSub}, ${'two@mil959.test'}, 'member')`
    try {
      await admin`INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
        VALUES (${tenantId}, ${minting}, ${'schema-ext'}, ${oneSub})`

      // §3.1: UNIQUE (tenant_id, connection_id, external_subject) — a second member cannot claim the
      // same upstream identity, which is the whole of the non-determinism this constraint forbids.
      await expect(
        admin`INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
          VALUES (${tenantId}, ${minting}, ${'schema-ext'}, ${twoSub})`,
      ).rejects.toThrow()

      // §3.1: removing a member removes their links.
      await admin`DELETE FROM members WHERE tenant_id = ${tenantId} AND sub = ${oneSub}`
      const [afterDelete] = await admin<{ member_sub: string }[]>`
        SELECT member_sub FROM member_identities WHERE tenant_id = ${tenantId} AND connection_id = ${minting} AND external_subject = ${'schema-ext'}`
      expect(afterDelete, 'ON DELETE CASCADE — the link does not outlive the member it names').toBeUndefined()

      // §3.1: a member frozen by seat overage (deactivated_at set, row NOT deleted) keeps their links.
      await admin`INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
        VALUES (${tenantId}, ${minting}, ${'schema-ext-2'}, ${twoSub})`
      await admin`UPDATE members SET deactivated_at = now() WHERE tenant_id = ${tenantId} AND sub = ${twoSub}`
      const [stillThere] = await admin<{ member_sub: string }[]>`
        SELECT member_sub FROM member_identities WHERE tenant_id = ${tenantId} AND connection_id = ${minting} AND external_subject = ${'schema-ext-2'}`
      expect(stillThere?.member_sub, 'a freeze is not a deletion — the link survives it').toBe(twoSub)
    } finally {
      await admin`DELETE FROM members WHERE tenant_id = ${tenantId} AND sub IN (${oneSub}, ${twoSub})`.catch(() => {})
    }
  }, 30_000)
})

describe('#959 login precedence (ADR-259 §5, the #807 case)', () => {
  it('a stored link on member ONE wins even though the connection would mint member TWO\'s own sub', async () => {
    const oneSub = `mil959-linked-one-${STAMP}`
    const tuplesForOne = [{ user: `user:${oneSub}`, relation: 'member', object: `tenant:${tenantId}` }]
    const tuplesForTwo = [{ user: `user:${prefix}${EXT}`, relation: 'member', object: `tenant:${tenantId}` }]
    await writeTuples(fgaClient, [...tuplesForOne, ...tuplesForTwo])
    issuer.setSubject(EXT, { email: 'ext@mil959.test' })
    try {
      // Member TWO is seated the ordinary way — a real sign-in through the minting connection,
      // BEFORE any link exists. Its sub is exactly what B deterministically mints.
      await signIn()
      const [two] = await admin<{ sub: string }[]>`SELECT sub FROM members WHERE tenant_id = ${tenantId} AND sub = ${prefix + EXT}`
      expect(two, 'member TWO exists — the product\'s own mint, not a fixture literal').toBeDefined()

      // Member ONE is a distinct, pre-existing member (not seated through this connection at all).
      await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenantId}, ${oneSub}, ${'one@mil959.test'}, 'member')`

      // The link: member ONE claims the SAME (connection, external subject) B mints for TWO.
      await admin`INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
        VALUES (${tenantId}, ${minting}, ${EXT}, ${oneSub})`

      // B signs in again, asserting the SAME external subject. The link must win — resolving to ONE —
      // not the deterministic mint, which would resolve to (or re-touch) TWO.
      const sid = await signIn()
      const session = await readSession(valkey, sid)
      expect(session?.sub, 'the stored link on ONE wins over the mint that belongs to the live TWO').toBe(oneSub)

      // TWO's row is untouched by B's second sign-in — unreachable, not merged, not deleted (§3.1: two
      // members are never merged; #807's pair is left for an administrator to resolve).
      const [twoAfter] = await admin<{ sub: string; email: string | null }[]>`
        SELECT sub, email FROM members WHERE tenant_id = ${tenantId} AND sub = ${prefix + EXT}`
      expect(twoAfter, 'member TWO still exists — nothing merges or deletes it').toBeDefined()
    } finally {
      await deleteTuples(fgaClient, [...tuplesForOne, ...tuplesForTwo]).catch(() => {})
      await admin`DELETE FROM members WHERE tenant_id = ${tenantId} AND sub IN (${oneSub}, ${prefix + EXT})`.catch(() => {})
    }
  }, 60_000)
})
