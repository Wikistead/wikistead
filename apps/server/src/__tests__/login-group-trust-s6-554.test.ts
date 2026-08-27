// #554 S6 / ADR-197 §6: group trust is a PER-CONNECTION attribute, cut BEFORE persistence. The
// login upsert writes members.groups, and the #111 FGA sync, default-role evaluation, the admin
// mapping AND the drift sweep all read what the upsert wrote — so dropping the claim before the
// upsert covers every sink at once. Pins (full OIDC round trips through named connections):
//   - an UNTRUSTED connection's asserted groups never land: members.groups stays [], and no FGA
//     group#member tuple appears (the R1 rule: the column, not only the tuples);
//   - the TRUSTED connection (the backfilled legacy shape) keeps today's exact behavior;
//   - #858 / #962, ADR-259 §3.8 SUPERSEDES this file's original third claim ("an untrusted login
//     after a trusted one empties the column the same way a trusted group-less login would"). That
//     was S6's wholesale-overwrite model: one column, last login wins. #962 replaced it with a
//     UNION across every connection a member has signed in through (member_connection_groups) —
//     the whole point being that a SECOND connection's login must NOT erase what a FIRST, still-
//     trusted connection asserted. An untrusted connection's OWN slice still carries nothing (its
//     claim is dropped before it ever reaches the upsert, same as always); what changed is that
//     this no longer clears a DIFFERENT connection's contribution to the union.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { provisionTenant } from '../auth/provisioning.js'
import { groupFgaId } from '../auth/group-sync.js'
import { startTestIssuer, type TestIssuer } from './helpers/oidc-issuer.js'
import { SESSION_COOKIE } from '../auth/session.js'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SLUG = `s6gt-${STAMP}`
const HOST = `${SLUG}.localhost`
const CLIENT_ID = 'wikistead-s6'
const MEMBER = `s6gt-member-${STAMP}`

let app: FastifyInstance
let issuer: TestIssuer
let tenantId = ''
const trusted = randomUUID()
const untrusted = randomUUID()

beforeAll(async () => {
  issuer = await startTestIssuer({ clientId: CLIENT_ID })
  const t = await provisionTenant(fgaClient, { slug: SLUG, admin: { sub: `s6gt-admin-${STAMP}` } })
  tenantId = t.tenantId
  for (const [id, sort, trust] of [[trusted, 0, true], [untrusted, 1, false]] as const) {
    await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, sort, trust_groups)
      VALUES (${id}, ${tenantId}, ${issuer.url}, ${CLIENT_ID}, NULL, 'openid email profile', ${`http://${HOST}/auth/callback`}, true, ${sort}, ${trust})`
  }
  await writeTuples(fgaClient, [{ user: `user:${MEMBER}`, relation: 'member', object: `tenant:${tenantId}` }])
  app = await buildApp()
  await app.ready()
}, 60_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [{ user: `user:${MEMBER}`, relation: 'member', object: `tenant:${tenantId}` }]).catch(() => {})
  await deleteTuples(fgaClient, [{ user: `user:${MEMBER}`, relation: 'member', object: `group:${groupFgaId(tenantId, 'Engineering')}` }]).catch(() => {})
  await app.close()
  await issuer.close()
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await admin.end()
  await pool.end()
}, 60_000)

async function login(connection: string): Promise<void> {
  const res = await app.inject({ method: 'GET', url: `/auth/login?connection=${connection}`, headers: { host: HOST } })
  expect(res.statusCode).toBe(302)
  const authRes = await fetch(res.headers.location as string, { redirect: 'manual' })
  const u = new URL(authRes.headers.get('location')!)
  const cb = await app.inject({ method: 'GET', url: u.pathname + u.search, headers: { host: HOST } })
  expect(cb.statusCode).toBe(302)
  expect(String(cb.headers['set-cookie'] ?? '')).toContain(`${SESSION_COOKIE}=`)
}
const memberGroups = async () =>
  (await admin<{ groups: string[] }[]>`SELECT groups FROM members WHERE tenant_id = ${tenantId} AND sub = ${MEMBER}`)[0]?.groups
const fgaGroupMember = async () =>
  (await fgaClient.check({ user: `user:${MEMBER}`, relation: 'member', object: `group:${groupFgaId(tenantId, 'Engineering')}` })).allowed

describe('#554 S6: per-connection group trust', () => {
  it('an untrusted connection\'s groups claim never persists — no column, no FGA tuple', async () => {
    issuer.setSubject(MEMBER, { email: 'm@s6.test', groups: ['Engineering'] })
    await login(untrusted)
    expect(await memberGroups(), 'the column stays empty (R1: not only the tuples)').toEqual([])
    expect(await fgaGroupMember(), 'no group#member tuple synced').toBe(false)
  }, 60_000)

  it('the trusted (legacy-shaped) connection keeps today\'s behavior; a later untrusted login through a DIFFERENT connection does not erase it (#962)', async () => {
    issuer.setSubject(MEMBER, { email: 'm@s6.test', groups: ['Engineering'] })
    await login(trusted)
    expect(await memberGroups()).toEqual(['Engineering'])
    expect(await fgaGroupMember(), 'trusted claim syncs to FGA').toBe(true)

    // #962: `untrusted`'s own claim still drops (dropped before it ever reaches the upsert), but it
    // must not erase what the TRUSTED connection's slice still asserts — the union, not the last write.
    await login(untrusted)
    expect(await memberGroups(), 'a different connection\'s untrusted login must not erase the trusted one\'s grant').toEqual(['Engineering'])
    expect(await fgaGroupMember(), 'the trusted connection\'s slice still holds Engineering').toBe(true)
  }, 60_000)
})

// #554 S6 review N3: the byte-compat claims themselves — a connection inserted WITHOUT the flag
// defaults untrusted (deleting migration 093's DEFAULT/backfill must go RED, not stay green
// because every fixture spells the flag out).
describe('#554 S6 review N3: the default is untrusted', () => {
  it('a connection that never mentions trust_groups drops ITS OWN claim (its slice stays empty)', async () => {
    const defaulted = randomUUID()
    await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, sort)
      VALUES (${defaulted}, ${tenantId}, ${issuer.url}, ${CLIENT_ID}, NULL, 'openid email profile', ${`http://${HOST}/auth/callback`}, true, 9)`
    try {
      // A DIFFERENT group, so this test can tell "did NOT persist through this connection" apart
      // from "the union still holds Engineering from the trusted connection's earlier login (#962)".
      issuer.setSubject(MEMBER, { email: 'm@s6.test', groups: ['Sales'] })
      await login(defaulted)
      expect(await memberGroups(), 'no flag = untrusted by default — Sales never lands, and Engineering (the trusted connection\'s standing grant, #962) survives').toEqual(['Engineering'])
      expect(await fgaGroupMember(), 'Engineering — asserted by the still-trusted connection — remains synced').toBe(true)
      expect((await fgaClient.check({ user: `user:${MEMBER}`, relation: 'member', object: `group:${groupFgaId(tenantId, 'Sales')}` })).allowed, 'Sales must never have landed').toBe(false)
    } finally {
      await admin`DELETE FROM tenant_oidc WHERE id = ${defaulted}`
    }
  }, 60_000)
})
