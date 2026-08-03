// #606 / ADR-205 §2 (ruled option A): an admin gives an EXISTING member a password entrance.
//
// The other half of this ticket refuses a password INVITE to somebody already here, because accepting
// one mints a new identity and makes a second person sharing their address. That refusal left the admin
// with no way to do the thing they wanted — and for a SCIM or OIDC member there was no way at all,
// which is why #605's break-glass could not be built.
//
// What must be true, and is measured against real rows: the credential binds to the sub they ALREADY
// have (nobody is duplicated), an IdP-derived sub is allowed (an SSO tenant is entirely IdP-derived, so
// refusing them refuses the case this exists for), and a member who already has a password is refused
// (changing one is a reset, which is somebody else's function).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { completePasswordReset } from '../auth/password-reset.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
// an IdP-derived sub on purpose: the reserved prefix marks a connection-minted identity (#554 S0)
const SUB = `wc0000ffff_setup606-${STAMP}`
const EMAIL = `setup606-${STAMP}@e2e.test`
// no content-type: this POST carries no body, and Fastify refuses an empty one when json is declared
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }

let app: FastifyInstance
let db: TenantDb

const setLocalLogin = (on: boolean) =>
  db.sql`INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled) VALUES (${TENANT}, ${on})
         ON CONFLICT (tenant_id) DO UPDATE SET local_login_enabled = ${on}`
const members = async (): Promise<number> =>
  Number((await admin<{ n: string }[]>`SELECT count(*) AS n FROM members
    WHERE tenant_id = ${TENANT} AND lower(email) = ${EMAIL}`)[0]!.n)
const creds = async (): Promise<{ member_sub: string }[]> =>
  admin<{ member_sub: string }[]>`SELECT member_sub FROM local_credentials WHERE identifier = ${EMAIL}`

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  await setLocalLogin(true)
  await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${TENANT}, ${SUB}, ${EMAIL}, 'member')
              ON CONFLICT (tenant_id, sub) DO NOTHING`
}, 180_000)

afterAll(async () => {
  await setLocalLogin(false).catch(() => {})
  await admin`DELETE FROM local_credentials WHERE member_sub = ${SUB}`.catch(() => {})
  await admin`DELETE FROM password_resets WHERE member_sub = ${SUB}`.catch(() => {})
  await admin`DELETE FROM members WHERE sub = ${SUB}`.catch(() => {})
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 120_000)

describe('#606: a password entrance is added to the person who is already here', () => {
  it('an admin can issue it for an IdP-derived member, and completing it binds to their EXISTING sub', async () => {
    expect(await members(), 'one person before').toBe(1)
    const res = await app.inject({ method: 'POST', url: `/members/${encodeURIComponent(SUB)}/password-setup`, headers: H })
    expect(res.statusCode, res.body).toBe(201)
    const { setupUrl } = res.json() as { setupUrl: string }
    const token = new URL(setupUrl).searchParams.get('token')!
    expect(token, 'the link carries a token').toMatch(/^pwr_/)

    const done = await completePasswordReset(db, { id: TENANT, plan: 'business' }, token, 'setup-606-passphrase-1')
    expect(done?.memberSub, 'the credential binds to the sub they already had').toBe(SUB)
    expect((await creds()).map((c) => c.member_sub), 'exactly one credential, on that sub').toEqual([SUB])
    expect(await members(), 'and nobody was added').toBe(1)
  }, 180_000)

  it('a second setup is refused — they have a password now, and changing it is a reset', async () => {
    const res = await app.inject({ method: 'POST', url: `/members/${encodeURIComponent(SUB)}/password-setup`, headers: H })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { code?: string }).code).toBe('password_setup_unavailable')
  }, 120_000)

  it('with password sign-in switched off, the tenant cannot issue one at all', async () => {
    // A SECOND member, with no credential: asking about the first one would be refused for having a
    // password already, and the test would pass with the switch doing nothing. (Measured: it did — the
    // first version of this test stayed green with the gate deleted.)
    const other = `${SUB}-b`
    const otherEmail = `b-${EMAIL}`
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${TENANT}, ${other}, ${otherEmail}, 'member')
                ON CONFLICT (tenant_id, sub) DO NOTHING`
    try {
      await setLocalLogin(false)
      const off = await app.inject({ method: 'POST', url: `/members/${encodeURIComponent(other)}/password-setup`, headers: H })
      expect(off.statusCode, 'the same door the invite uses').toBe(400)
      await setLocalLogin(true)
      const on = await app.inject({ method: 'POST', url: `/members/${encodeURIComponent(other)}/password-setup`, headers: H })
      expect(on.statusCode, 'and it opens again when the tenant turns passwords on').toBe(201)
    } finally {
      await admin`DELETE FROM password_resets WHERE member_sub = ${other}`.catch(() => {})
      await admin`DELETE FROM members WHERE sub = ${other}`.catch(() => {})
      await setLocalLogin(true)
    }
  }, 120_000)
})
