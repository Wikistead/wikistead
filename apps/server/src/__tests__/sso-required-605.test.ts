// Integration — real Postgres + real OpenFGA. #605 / ADR-210: the SSO-required stance.
//
// Own tenant (tenant_t605): the pins need exact control of the federated set, the exemptions and the
// prefs row, which the shared dev tenant cannot promise (#482). Every entrance in §4's table is
// measured by calling the endpoint (or its function) directly, per §10 — never by looking at a screen.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { buildApp } from '../app.js'
import { hashPassword } from '../auth/password-hash.js'
import { resolveSsoStance } from '../auth/sso-stance.js'
import { assertNotLastWayIn, resolveLoginConnections } from '../auth/login-methods.js'
import { completePasswordReset, mintPasswordReset, mintPasswordSetup } from '../auth/password-reset.js'
import type { FastifyInstance } from 'fastify'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_t605'
const ADMIN = 'dev-user'
const E = 't605-exempt' // exempt, holds a password
const N = 't605-normal' // not exempt, holds a password
const PW = 'correct horse battery st4ple!'
const H = { host: 't605.localhost', authorization: 'Bearer dev-token' }
const anon = { host: 't605.localhost', origin: 'http://t605.localhost' } // origin: the login route's CSRF check runs before anything else
const asTenant = (id: string): Tenant => ({ id, slug: 't605', plan: 'free', isolation: 'logical' }) as Tenant

let app: FastifyInstance
let db: TenantDb
let connId: string

const adminTuples = [
  { user: `user:${ADMIN}`, relation: 'member', object: `tenant:${T}` },
  { user: `user:${ADMIN}`, relation: 'admin', object: `tenant:${T}` },
  // membership is the authority (establishMemberSession refuses a sub with no member tuple)
  { user: `user:${E}`, relation: 'member', object: `tenant:${T}` },
  { user: `user:${N}`, relation: 'member', object: `tenant:${T}` },
]

const setStance = (on: boolean) => admin`UPDATE tenant_login_prefs SET sso_required = ${on} WHERE tenant_id = ${T}`

beforeAll(async () => {
  await admin`INSERT INTO tenants (id, slug, plan) VALUES (${T}, 't605', 'free') ON CONFLICT (slug) DO NOTHING`
  await admin`DELETE FROM sso_exemptions WHERE tenant_id = ${T}`
  await admin`DELETE FROM local_credentials WHERE tenant_id = ${T}`
  await admin`DELETE FROM password_resets WHERE tenant_id = ${T}`
  await admin`DELETE FROM tenant_oidc WHERE tenant_id = ${T}`
  for (const sub of [ADMIN, E, N]) {
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${T}, ${sub}, ${sub + '@t605.test'}, ${sub === ADMIN ? 'admin' : 'member'})
                ON CONFLICT (tenant_id, sub) DO UPDATE SET role = EXCLUDED.role, deactivated_at = NULL`
  }
  const hash = await hashPassword(PW)
  for (const sub of [E, N]) {
    await admin`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash) VALUES (${T}, ${sub}, ${sub + '@t605.test'}, ${hash})
                ON CONFLICT (tenant_id, member_sub) DO UPDATE SET password_hash = EXCLUDED.password_hash`
  }
  await admin`INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled, sso_required) VALUES (${T}, TRUE, FALSE)
              ON CONFLICT (tenant_id) DO UPDATE SET local_login_enabled = TRUE, sso_required = FALSE`
  connId = randomUUID()
  await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, sort)
              VALUES (${connId}, ${T}, 'https://idp.t605.test', 't605-client', NULL, 'openid email', 'http://t605.localhost/auth/callback', true, 0)`
  for (const t of adminTuples) await writeTuples(fgaClient, [t]).catch(() => {})
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(T))
}, 120_000)

afterAll(async () => {
  for (const t of adminTuples) await deleteTuples(fgaClient, [t]).catch(() => {})
  for (const tbl of ['sso_exemptions', 'password_resets', 'local_credentials', 'tenant_oidc', 'tenant_login_prefs', 'audit_outbox', 'audit_log', 'members']) {
    await admin.unsafe(`DELETE FROM ${tbl} WHERE tenant_id = '${T}'`).catch(() => {})
  }
  await admin`DELETE FROM tenants WHERE id = ${T}`.catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
  await pool.end()
}, 60_000)

describe('#605 §R5-4: turning the stance ON has write-time preconditions', () => {
  it('refuses without a federated way in, then without a credentialed exemption, then passes — audited', async () => {
    await admin`UPDATE tenant_oidc SET enabled = FALSE WHERE tenant_id = ${T}`
    const noIdp = await app.inject({ method: 'PATCH', url: '/admin/login-methods', headers: H, payload: { ssoRequired: true } })
    expect(noIdp.statusCode).toBe(409)
    expect(noIdp.json().code).toBe('own_idp_required')
    await admin`UPDATE tenant_oidc SET enabled = TRUE WHERE tenant_id = ${T}`
    const noExempt = await app.inject({ method: 'PATCH', url: '/admin/login-methods', headers: H, payload: { ssoRequired: true } })
    expect(noExempt.statusCode).toBe(409)
    expect(noExempt.json().code).toBe('sso_exemption_required')
    const grant = await app.inject({ method: 'PUT', url: `/admin/sso-exemptions/${E}`, headers: H })
    expect(grant.statusCode).toBe(204)
    const on = await app.inject({ method: 'PATCH', url: '/admin/login-methods', headers: H, payload: { ssoRequired: true } })
    expect(on.statusCode).toBe(204)
    const [audit] = await admin`SELECT action FROM audit_outbox WHERE tenant_id = ${T} AND action = 'tenant.sso_required_on' LIMIT 1`
    expect(audit, 'the switch is in the ledger, in-tx').toBeTruthy()
    expect((await resolveSsoStance(db, { plan: 'free' })).biting).toBe(true)
  }, 60_000)

  it('a stranger cannot name an exemption for a non-member, and the last credentialed exemption cannot be revoked while on', async () => {
    const ghost = await app.inject({ method: 'PUT', url: '/admin/sso-exemptions/no-such-member', headers: H })
    expect(ghost.statusCode).toBe(404)
    const last = await app.inject({ method: 'DELETE', url: `/admin/sso-exemptions/${E}`, headers: H })
    expect(last.statusCode).toBe(409)
    expect(last.json().code).toBe('sso_exemption_required')
  })
})

describe('#605 §1/§4 rows 1-3: while the stance bites, the doors answer per the table', () => {
  it('the method lists hide local and platform (rows 1-2)', async () => {
    const conns = await resolveLoginConnections(db, { plan: 'free' })
    expect(conns.map((c) => c.kind).sort()).toEqual(['oidc'])
    const view = (await app.inject({ method: 'GET', url: '/admin/login-methods', headers: H })).json()
    expect(view.ssoRequired).toEqual({ selected: true, biting: true })
    expect(view.methods.local.selected, 'the selection is PRESERVED (ADR-195 §1)').toBe(true)
    expect(view.methods.local.effective).toBe(false)
    expect(view.methods.local.blockedByStance, 'and the row says why').toBe(true)
  })

  it('row 3: the exempt member signs in; the non-exempt refusal is byte-identical to a wrong password', async () => {
    const login = (identifier: string, password: string) =>
      app.inject({ method: 'POST', url: '/auth/local/login', headers: anon, payload: { identifier, password } })
    const exempt = await login(`${E}@t605.test`, PW)
    expect(exempt.statusCode, 'the exemption is the break-glass').toBeLessThan(400)
    const blocked = await login(`${N}@t605.test`, PW)
    const wrongPw = await login(`${N}@t605.test`, 'not-the-password-1!')
    expect(blocked.statusCode).toBe(wrongPw.statusCode)
    expect(blocked.body, 'never "you are not exempt" — the §3 uniform refusal').toBe(wrongPw.body)
  }, 60_000)
})

describe('#605 §4 rows 4-5: reset asks about the member, and a refused link stays alive', () => {
  it('reset-request mints for the exempt member only (uniform outside)', async () => {
    expect(await mintPasswordReset(db, { plan: 'free' }, `${E}@t605.test`), 'exempt: minted').not.toBeNull()
    expect(await mintPasswordReset(db, { plan: 'free' }, `${N}@t605.test`), 'non-exempt: the uniform nothing').toBeNull()
  })

  it('a non-exempt completion is refused WITHOUT consuming; the exemption granted after saves the SAME link', async () => {
    await setStance(false)
    const minted = await mintPasswordReset(db, { plan: 'free' }, `${N}@t605.test`)
    expect(minted).not.toBeNull()
    await setStance(true)
    expect(await completePasswordReset(db, asTenant(T), minted!.token, `${PW}x2!`), 'refused while blocked').toBeNull()
    const [row] = await admin`SELECT used_at FROM password_resets WHERE member_sub = ${N} AND tenant_id = ${T} ORDER BY expires_at DESC LIMIT 1`
    expect(row!.used_at, 'the link is UNSPENT — an admin can still save it').toBeNull()
    await app.inject({ method: 'PUT', url: `/admin/sso-exemptions/${N}`, headers: H })
    expect(await completePasswordReset(db, asTenant(T), minted!.token, `${PW}x2!`), 'the same link now completes').not.toBeNull()
    await app.inject({ method: 'DELETE', url: `/admin/sso-exemptions/${N}`, headers: H })
    await admin`UPDATE local_credentials SET password_hash = ${await hashPassword(PW)} WHERE tenant_id = ${T} AND member_sub = ${N}`
  }, 60_000)

  it('rows 6+7 stay open: an admin mints a setup link for a NEW exemption and they complete it while ON (exempt → mint → complete)', async () => {
    const F = 't605-fresh'
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${T}, ${F}, 'fresh@t605.test', 'member') ON CONFLICT (tenant_id, sub) DO NOTHING`
    await app.inject({ method: 'PUT', url: `/admin/sso-exemptions/${F}`, headers: H })
    const setup = await mintPasswordSetup(db, F)
    expect(setup, 'row 6: arranging a key is allowed under the stance').not.toBeNull()
    expect(await completePasswordReset(db, asTenant(T), setup!.token, `${PW}x3!`), 'row 5 for an exempt member: completes').not.toBeNull()
    await app.inject({ method: 'DELETE', url: `/admin/sso-exemptions/${F}`, headers: H })
  }, 60_000)
})

describe('#605 §4 rows 8-9: nobody NEW arrives by password while the stance bites', () => {
  it('issuing a local invite is refused with the reason (admin surface); accepting one is the uniform dead link', async () => {
    const { createInvite, acceptLocalInvite } = await import('../auth/invites.js')
    await expect(
      createInvite(db, { tenantId: T, plan: 'free', invitedBy: ADMIN, email: 'new@t605.test', role: 'member', kind: 'local' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'sso_required' })
    await setStance(false)
    const inv = await createInvite(db, { tenantId: T, plan: 'free', invitedBy: ADMIN, email: 'new@t605.test', role: 'member', kind: 'local' })
    await setStance(true)
    expect(await acceptLocalInvite({ db, fga: fgaClient }, asTenant(T), inv.token, `${PW}x4!`)).toEqual({ ok: false })
  }, 60_000)
})

describe('#605 §R5-1/§R5-2: the guard is counterfactual, and failures fall to lapse', () => {
  it('§R5-1: disabling the ONLY federated connection passes — the stance lapses after the write', async () => {
    await expect(assertNotLastWayIn(db, { id: T, plan: 'free' }, connId), 'local returns once the stance lapses').resolves.toBeUndefined()
  })

  it('§R5-2: a corrupt secret does not hold the stance up, and the password path never 500s for it', async () => {
    await admin`UPDATE tenant_oidc SET client_secret_enc = 'bm90LXJlYWwtY2lwaGVydGV4dA==' WHERE id = ${connId}`
    const stance = await resolveSsoStance(db, { plan: 'free' })
    expect(stance, 'selected but LAPSED — an error opens the door early, never holds it shut').toEqual({ selected: true, biting: false })
    const r = await app.inject({ method: 'POST', url: '/auth/local/login', headers: anon, payload: { identifier: `${N}@t605.test`, password: PW } })
    expect(r.statusCode, 'the lapse means the non-exempt member is back in — and no 500').toBeLessThan(400)
    await admin`UPDATE tenant_oidc SET client_secret_enc = NULL WHERE id = ${connId}`
  }, 60_000)

  it('turning the stance off restores everything and is audited', async () => {
    const off = await app.inject({ method: 'PATCH', url: '/admin/login-methods', headers: H, payload: { ssoRequired: false } })
    expect(off.statusCode).toBe(204)
    const view = (await app.inject({ method: 'GET', url: '/admin/login-methods', headers: H })).json()
    expect(view.ssoRequired.selected).toBe(false)
    expect(view.methods.local.effective).toBe(true)
    const [audit] = await admin`SELECT action FROM audit_outbox WHERE tenant_id = ${T} AND action = 'tenant.sso_required_off' LIMIT 1`
    expect(audit).toBeTruthy()
  })
})
