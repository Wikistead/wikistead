// #554 S6 / ADR-197 §6: group trust is a PER-CONNECTION attribute, cut BEFORE persistence. The
// login upsert writes members.groups, and the #111 FGA sync, default-role evaluation, the admin
// mapping AND the drift sweep all read what the upsert wrote — so dropping the claim before the
// upsert covers every sink at once. Pins (full OIDC round trips through named connections):
//   - an UNTRUSTED connection's asserted groups never land: members.groups stays [], and no FGA
//     group#member tuple appears (the R1 rule: the column, not only the tuples);
//   - the TRUSTED connection (the backfilled legacy shape) keeps today's exact behavior;
//   - the drop uses absent-claim semantics DELIBERATELY: an untrusted login after a trusted one
//     empties the column the same way a trusted group-less login would — a recorded decision,
//     not an accident.
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

  it('the trusted (legacy-shaped) connection keeps today\'s behavior; a later untrusted login empties by absent-claim semantics', async () => {
    issuer.setSubject(MEMBER, { email: 'm@s6.test', groups: ['Engineering'] })
    await login(trusted)
    expect(await memberGroups()).toEqual(['Engineering'])
    expect(await fgaGroupMember(), 'trusted claim syncs to FGA').toBe(true)

    // the recorded decision: dropped = the same as an IdP that sent no groups claim
    await login(untrusted)
    expect(await memberGroups(), 'untrusted login behaves like a group-less login').toEqual([])
    expect(await fgaGroupMember(), 'the diff removes the previous groups').toBe(false)
  }, 60_000)
})
