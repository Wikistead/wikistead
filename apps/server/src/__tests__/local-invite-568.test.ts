// #568 / ADR-198 §2: accepting a PASSWORD invite. The person holding the link is not a member yet,
// so this is the one place membership, identity and a credential are created together — and the
// dangerous states are the partial ones. A member with no password cannot sign in; a password with
// no membership is a credential for nothing. One transaction, or neither.
//
// The other half is what a dead link may learn. An unknown token, an expired one, a consumed one, a
// token for an OIDC invite, and a tenant that has since switched password sign-in off all answer the
// same way: whoever is holding a link that does not work must not find out which of those is true.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { createInvite, acceptLocalInvite } from '../auth/invites.js'
import { verifyPassword } from '../auth/password-hash.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const PASSWORD = 'invite-set-passphrase-1'
const H = { host: 'dev.localhost', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }

let app: FastifyInstance
let db: TenantDb
const emails: string[] = []

const email = (n: string) => { const e = `inv568-${n}-${STAMP}@e2e.test`; emails.push(e); return e }
const setLocalLogin = (on: boolean) =>
  db.sql`INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled) VALUES (${TENANT}, ${on})
         ON CONFLICT (tenant_id) DO UPDATE SET local_login_enabled = ${on}`
const makeInvite = (addr: string) =>
  createInvite(db, { tenantId: TENANT, plan: 'business', invitedBy: 'dev-user', email: addr, role: 'member', kind: 'local' })
const accept = (token: string, password = PASSWORD) =>
  acceptLocalInvite({ db, fga: fgaClient }, { id: TENANT, plan: 'business' }, token, password)

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  await setLocalLogin(true)
}, 120_000)

afterAll(async () => {
  await setLocalLogin(false).catch(() => {})
  for (const e of emails) {
    const subs = await adminPool<{ member_sub: string }[]>`SELECT member_sub FROM local_credentials WHERE identifier = ${e}`
    for (const { member_sub } of subs) {
      await adminPool`DELETE FROM local_credentials WHERE member_sub = ${member_sub}`.catch(() => {})
      await adminPool`DELETE FROM members WHERE sub = ${member_sub}`.catch(() => {})
    }
    await adminPool`DELETE FROM invites WHERE tenant_id = ${TENANT} AND email = ${e}`.catch(() => {})
  }
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

describe('#568 §2: acceptance creates the member and the credential together', () => {
  it('one acceptance seats the member, stores the password, and mints OUR kind of subject', async () => {
    const addr = email('happy')
    const { token } = await makeInvite(addr)
    const out = await accept(token)
    expect(out.ok).toBe(true)
    const sub = (out as { ok: true; sub: string }).sub
    expect(sub.startsWith('wlocal_'), 'the subject is minted here, in the reserved space').toBe(true)

    const [member] = await db.sql<{ identity_source: string }[]>`SELECT identity_source FROM members WHERE sub = ${sub}`
    expect(member?.identity_source, 'and it is recorded as ours').toBe('local')
    // `member` is a RAW relation on a tenant object, not a page/space capability — ask FGA directly
    // (the same reason establishMemberSession calls fga.check itself).
    const { allowed } = await fgaClient.check({ user: `user:${sub}`, relation: 'member', object: `tenant:${TENANT}` })
    expect(allowed, 'membership landed in FGA').toBe(true)

    const [cred] = await db.sql<{ password_hash: string; identifier: string }[]>`
      SELECT password_hash, identifier FROM local_credentials WHERE member_sub = ${sub}`
    expect(cred?.identifier, 'the invited address IS the sign-in name').toBe(addr)
    expect(await verifyPassword(PASSWORD, cred!.password_hash), 'the password they chose is what was stored').toBe(true)
  }, 120_000)

  it('a token is consumed once — the second acceptance seats nobody', async () => {
    const addr = email('once')
    const { token } = await makeInvite(addr)
    expect((await accept(token)).ok).toBe(true)
    const second = await accept(token, 'a-different-passphrase-x')
    expect(second.ok, 'consumed').toBe(false)
    const rows = await db.sql`SELECT 1 FROM local_credentials WHERE identifier = ${addr}`
    expect(rows.length, 'and no second credential was written').toBe(1)
  }, 120_000)

  it('a dead link, an OIDC invite and a tenant with passwords off are ONE answer', async () => {
    const oidcAddr = email('oidc-kind')
    const oidcInvite = await createInvite(db, { tenantId: TENANT, plan: 'business', invitedBy: 'dev-user', email: oidcAddr, role: 'member' })
    const liveAddr = email('switched-off')
    const live = await makeInvite(liveAddr)

    const unknown = await accept('inv_nothing-like-this')
    const wrongKind = await accept(oidcInvite.token)
    await setLocalLogin(false)
    const disabled = await accept(live.token)
    await setLocalLogin(true)

    for (const [name, r] of [['unknown token', unknown], ['an OIDC invite', wrongKind], ['passwords switched off', disabled]] as const) {
      expect(r.ok, name).toBe(false)
    }
    // ...and none of them consumed the still-valid invite
    expect((await accept(live.token)).ok, 'the live invite survived all three refusals').toBe(true)
  }, 120_000)

  it('a password below the policy is refused, and the invite is NOT consumed', async () => {
    // The person is choosing a password right now; the invite must still be there when they pick a
    // longer one. A refusal that burned the token would strand them.
    const addr = email('weak')
    const { token } = await makeInvite(addr)
    await expect(accept(token, 'short')).rejects.toMatchObject({ statusCode: 400, code: 'weak_password' })
    expect((await accept(token)).ok, 'the invite is still live').toBe(true)
  }, 120_000)

  it('a local invite cannot be issued without an email, or while passwords are off', async () => {
    // Refused at ISSUE time, where the admin is looking — not at acceptance, where the person who
    // sees the failure chose none of it.
    await expect(
      createInvite(db, { tenantId: TENANT, plan: 'business', invitedBy: 'dev-user', email: null, role: 'member', kind: 'local' }),
    ).rejects.toMatchObject({ statusCode: 400 })
    await setLocalLogin(false)
    await expect(makeInvite(email('while-off'))).rejects.toMatchObject({ statusCode: 400, code: 'local_login_disabled' })
    await setLocalLogin(true)
  }, 120_000)

  it('the HTTP route answers 404 for every dead link and 201 with a session for a live one', async () => {
    const addr = email('http')
    const { token } = await makeInvite(addr)
    const dead = await app.inject({ method: 'POST', url: '/auth/local/accept', headers: H, payload: { token: 'inv_dead', password: PASSWORD } })
    expect(dead.statusCode).toBe(404)
    const ok = await app.inject({ method: 'POST', url: '/auth/local/accept', headers: H, payload: { token, password: PASSWORD } })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.cookies.some((c) => c.name === 'wks_sess'), 'they are signed in immediately').toBe(true)
  }, 120_000)

  it('a cross-site POST cannot accept an invite either', async () => {
    const addr = email('csrf')
    const { token } = await makeInvite(addr)
    const res = await app.inject({
      method: 'POST', url: '/auth/local/accept',
      headers: { ...H, 'sec-fetch-site': 'cross-site' }, payload: { token, password: PASSWORD },
    })
    expect(res.statusCode).toBe(403)
    expect((await accept(token)).ok, 'and the invite was not touched').toBe(true)
  }, 120_000)
})

describe('#568 review B2: the two invite doors do not accept each other\'s tokens', () => {
  it('a PASSWORD invite cannot be consumed by signing in at the IdP', async () => {
    // Without the kind filter this burned the token on a member seated as identity_source='oidc',
    // and the credential the invite existed to create was never written — silently, for both the
    // person and the admin who sent it.
    const { acceptInvite } = await import('../auth/invites.js')
    const addr = email('kind-oidc-door')
    const { token } = await makeInvite(addr)
    const intruder = `oidc-b2-${STAMP}`
    const took = await acceptInvite({ db, fga: fgaClient }, { id: TENANT, plan: 'business' }, token, { sub: intruder, email: addr })
    expect(took, 'the OIDC door refuses a password invite').toBe(false)
    const rows = await adminPool`SELECT status FROM invites WHERE tenant_id = ${TENANT} AND email = ${addr}`
    expect((rows[0] as { status: string }).status, 'and the token was not burned').toBe('pending')
    // ...and it still works through its own door
    expect((await accept(token)).ok).toBe(true)
    await adminPool`DELETE FROM members WHERE sub = ${intruder}`.catch(() => {})
  }, 120_000)

  it('the landing page can ask which door a token belongs to, and a dead one says nothing', async () => {
    const addr = email('kind-endpoint')
    const { token } = await makeInvite(addr)
    const ok = await app.inject({ method: 'GET', url: `/auth/invite-kind?token=${encodeURIComponent(token)}`, headers: { host: 'dev.localhost' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ kind: 'local' })
    for (const bad of ['inv_nothing', '']) {
      const res = await app.inject({ method: 'GET', url: `/auth/invite-kind?token=${encodeURIComponent(bad)}`, headers: { host: 'dev.localhost' } })
      expect(res.statusCode, bad || '(empty)').toBe(404)
    }
    // consumed is dead too
    await accept(token)
    const spent = await app.inject({ method: 'GET', url: `/auth/invite-kind?token=${encodeURIComponent(token)}`, headers: { host: 'dev.localhost' } })
    expect(spent.statusCode).toBe(404)
  }, 120_000)

  it('N3: a taken identifier refuses BEFORE any FGA tuple is written', async () => {
    // The membership tuple does not roll back with the transaction, so a UNIQUE violation after it
    // was written left an orphan grant for a member the database had discarded.
    // RE-AIMED by #606: both links are now issued BEFORE either is accepted. Issuing the second one
    // afterwards is refused at the door now (`already_member`), which is a different, earlier defence —
    // this test is about what ACCEPTANCE does when it meets a taken identifier, and that path still has
    // to hold for the two links that were legitimately outstanding at the same time.
    const addr = email('collision')
    const first = await makeInvite(addr)
    const second = await makeInvite(addr)
    expect((await accept(first.token)).ok).toBe(true)
    const out = await accept(second.token, 'a-second-passphrase-ok')
    expect(out.ok, 'the second acceptance refuses like any dead link').toBe(false)
    const creds = await db.sql`SELECT 1 FROM local_credentials WHERE identifier = ${addr}`
    expect(creds.length, 'one credential, not two').toBe(1)
  }, 120_000)
})
