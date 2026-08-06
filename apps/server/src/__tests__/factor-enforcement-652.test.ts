// #652 slice 3 / ADR-219 §3 §5 §6: the policy at the door, and the way through it.
//
// Driven with real cookies rather than by calling the decision function, because everything that can go
// wrong here is about what the DOOR does: whether a password alone still produces a session, whether an
// un-enrolled member can reach the enrolment (§6's circle), and whether the receipt is spent.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import { totpCode, generateTotpSecret } from '../auth/totp.js'
import { startTotpEnrolment, confirmFactor } from '../auth/second-factors.js'
import { hashPassword } from '../auth/password-hash.js'
import { SESSION_COOKIE } from '../auth/session.js'
import { FACTOR_COOKIE } from '../auth/factor-session.js'
import { ensureMembers } from './helpers/membership.js'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
// Same-origin proof, as every browser sends it (the door refuses a request with neither header).
const WEB = { host: 'dev.localhost', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }
const PASSWORD = 'correct horse battery staple 652'

/** What `local_login_enabled` was before this file touched it, so afterAll can put it back. */
let priorLocalLogin = false
let app: FastifyInstance
let db: TenantDb
const subs: string[] = []

/** A local member who can sign in with a password. `wlocal_` because migration 105 requires it. */
async function localMember(name: string, role: 'admin' | 'member'): Promise<{ sub: string; email: string }> {
  const sub = `wlocal_e652-${name}-${STAMP}`
  const email = `e652-${name}-${STAMP}@e2e.test`
  subs.push(sub)
  await adminPool`
    INSERT INTO members (tenant_id, sub, email, role) VALUES (${TENANT}, ${sub}, ${email}, ${role})
    ON CONFLICT (tenant_id, sub) DO UPDATE SET role = ${role}`
  await adminPool`
    INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
    VALUES (${TENANT}, ${sub}, ${email}, ${await hashPassword(PASSWORD)})
    ON CONFLICT (tenant_id, member_sub) DO UPDATE SET password_hash = EXCLUDED.password_hash`
  // #471 / ADR-176: `establishMemberSession` refuses a subject FGA does not know, so a row inserted
  // straight into the table signs in with "invalid credentials" for a correct password. Measured.
  await ensureMembers(TENANT, [sub])
  return { sub, email }
}

const signIn = (identifier: string) =>
  app.inject({ method: 'POST', url: '/auth/local/login', headers: WEB, payload: JSON.stringify({ identifier, password: PASSWORD }) })

const cookie = (res: { cookies: { name: string; value: string }[] }, name: string) =>
  res.cookies.find((c) => c.name === name)?.value

/**
 * The stance — and `local_login_enabled` with it, deliberately.
 *
 * Migration 106 defaults that column to FALSE, so writing a prefs row for a tenant that had none
 * SHUTS THE PASSWORD DOOR. Measured: every case here failed with "invalid credentials" for a correct
 * password, because the fixture's first `setStance(false)` had created the row. This file's premise is
 * that the password door works, so it says so rather than inheriting whatever the seed left.
 */
const setStance = (on: boolean) =>
  adminPool`
    INSERT INTO tenant_login_prefs (tenant_id, second_factor_required, local_login_enabled)
    VALUES (${TENANT}, ${on}, TRUE)
    ON CONFLICT (tenant_id) DO UPDATE SET second_factor_required = ${on}, local_login_enabled = TRUE`

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  const [pref] = await adminPool<{ local_login_enabled: boolean }[]>`
    SELECT local_login_enabled FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`
  priorLocalLogin = pref?.local_login_enabled === true
}, 180_000)

beforeEach(async () => {
  await setStance(false)
  // The limiter keys THIS file trips, and only those. `flushdb` was here first and it is far too
  // broad: the Valkey is shared with every other suite in the run, so wiping it takes their sessions
  // and their counters with it.
  for (const sub of ['dev-user', ...subs]) {
    await app.valkey.del(`authlocal:id:${sub}`).catch(() => {})
  }
  await app.valkey.del(`authlocal:ip:127.0.0.1`).catch(() => {})
})

afterAll(async () => {
  // Put the STANCE back and stop forcing the password door open. Leaving `local_login_enabled = TRUE`
  // behind changed what other suites measured — #537's lockout guard counts the effective methods, and
  // it went red on a fixture this file had edited.
  await adminPool`
    UPDATE tenant_login_prefs SET second_factor_required = FALSE, local_login_enabled = ${priorLocalLogin}
    WHERE tenant_id = ${TENANT}`.catch(() => {})
  for (const sub of subs) {
    await adminPool`DELETE FROM member_factors WHERE member_sub = ${sub}`.catch(() => {})
    await adminPool`DELETE FROM local_credentials WHERE member_sub = ${sub}`.catch(() => {})
    await adminPool`DELETE FROM members WHERE sub = ${sub}`.catch(() => {})
  }
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

describe('#652: with the policy off, the password door is unchanged', () => {
  it('a correct password is a session', async () => {
    const { email } = await localMember('off', 'member')
    const res = await signIn(email)
    expect(res.statusCode, res.body).toBe(200)
    expect(cookie(res, SESSION_COOKIE), 'a full session').toBeTruthy()
    expect(cookie(res, FACTOR_COOKIE), 'and no receipt').toBeUndefined()
  }, 120_000)
})

describe('#652: with the policy on, a password alone is not a session', () => {
  it('hands back a receipt, and tells the screen WHICH thing to ask for', async () => {
    const enrolled = await localMember('has-factor', 'member')
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: enrolled.sub, secret: generateTotpSecret() })
    await confirmFactor(db, factorId)
    await setStance(true)

    const res = await signIn(enrolled.email)
    expect(res.statusCode, res.body).toBe(200)
    expect(cookie(res, SESSION_COOKIE), 'NO session yet — this is the whole point').toBeUndefined()
    expect(cookie(res, FACTOR_COOKIE), 'a receipt instead').toBeTruthy()
    expect(res.json<{ factor: string }>().factor, 'present the one you have').toBe('required')
  }, 120_000)

  it('…and says "enrol" to somebody who has nothing to present', async () => {
    // Two situations, not one: a single "factor required" sends a member with no authenticator to a
    // code box they cannot fill.
    const bare = await localMember('no-factor', 'member')
    await setStance(true)
    const res = await signIn(bare.email)
    expect(res.json<{ factor: string }>().factor).toBe('enrolment-required')
    expect(cookie(res, FACTOR_COOKIE)).toBeTruthy()
  }, 120_000)

  it('a WRONG password still says nothing about the factor', async () => {
    // The policy must not turn the sign-in into an oracle for "this address exists and is enrolled".
    const m = await localMember('wrong-pw', 'member')
    await setStance(true)
    const res = await app.inject({
      method: 'POST', url: '/auth/local/login', headers: WEB,
      payload: JSON.stringify({ identifier: m.email, password: 'not the password' }),
    })
    expect(res.statusCode).toBe(401)
    expect(cookie(res, FACTOR_COOKIE), 'no receipt for a wrong password').toBeUndefined()
  }, 120_000)
})

describe('#652: presenting the factor', () => {
  it('turns the receipt into a session, and spends it', async () => {
    const m = await localMember('present', 'member')
    const secret = generateTotpSecret()
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: m.sub, secret })
    await confirmFactor(db, factorId)
    await setStance(true)
    const fsid = cookie(await signIn(m.email), FACTOR_COOKIE)!

    const res = await app.inject({
      method: 'POST', url: '/auth/local/factor', headers: { ...WEB, cookie: `${FACTOR_COOKIE}=${fsid}` },
      payload: JSON.stringify({ code: totpCode(secret, Date.now()) }),
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(cookie(res, SESSION_COOKIE), 'now there is a session').toBeTruthy()

    // …and the receipt is spent. A half-credential that outlives its use is a second way in for
    // anybody who captured it.
    const again = await app.inject({
      method: 'POST', url: '/auth/local/factor', headers: { ...WEB, cookie: `${FACTOR_COOKIE}=${fsid}` },
      payload: JSON.stringify({ code: totpCode(secret, Date.now() + 30_000) }),
    })
    expect(again.statusCode, 'the receipt cannot be presented twice').toBe(401)
  }, 120_000)

  it('refuses a wrong code, and a code already used', async () => {
    const m = await localMember('replay', 'member')
    const secret = generateTotpSecret()
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: m.sub, secret })
    await confirmFactor(db, factorId)
    await setStance(true)

    const first = cookie(await signIn(m.email), FACTOR_COOKIE)!
    const bad = await app.inject({
      method: 'POST', url: '/auth/local/factor', headers: { ...WEB, cookie: `${FACTOR_COOKIE}=${first}` },
      payload: JSON.stringify({ code: '000000' }),
    })
    expect(bad.statusCode).toBe(401)
    expect(bad.json<{ code: string }>().code).toBe('factor_code_invalid')

    const code = totpCode(secret, Date.now())
    expect((await app.inject({
      method: 'POST', url: '/auth/local/factor', headers: { ...WEB, cookie: `${FACTOR_COOKIE}=${first}` },
      payload: JSON.stringify({ code }),
    })).statusCode).toBe(200)

    // The SAME code, on a fresh receipt, inside its window. Without the spend this opens a second
    // session — the shoulder-surfing case, which "wrong code" can never catch.
    const second = cookie(await signIn(m.email), FACTOR_COOKIE)!
    const replay = await app.inject({
      method: 'POST', url: '/auth/local/factor', headers: { ...WEB, cookie: `${FACTOR_COOKIE}=${second}` },
      payload: JSON.stringify({ code }),
    })
    expect(replay.statusCode, 'a spent code is not a second session').toBe(401)
    expect(replay.json<{ code: string }>().code).toBe('factor_code_replayed')
  }, 120_000)

  it('refuses without a receipt at all', async () => {
    await setStance(true)
    const res = await app.inject({
      method: 'POST', url: '/auth/local/factor', headers: WEB, payload: JSON.stringify({ code: '123456' }),
    })
    expect(res.statusCode).toBe(401)
    expect(res.json<{ code: string }>().code).toBe('factor_session_expired')
  }, 120_000)
})

describe('#652: enrolling from the interstitial — ADR-219 §6\'s circle', () => {
  it('an un-enrolled member can enrol and lands in a session', async () => {
    // Policy on → no session → cannot reach settings → can never enrol. This is the way out, and it is
    // the case a policy without it makes unrecoverable.
    const m = await localMember('circle', 'member')
    await setStance(true)
    const fsid = cookie(await signIn(m.email), FACTOR_COOKIE)!

    const started = await app.inject({
      method: 'POST', url: '/auth/local/factor/enrol', headers: { ...WEB, cookie: `${FACTOR_COOKIE}=${fsid}` },
      payload: '{}',
    })
    expect(started.statusCode, started.body).toBe(201)
    const { factorId, secret } = started.json<{ factorId: string; secret: string }>()

    const done = await app.inject({
      method: 'POST', url: `/auth/local/factor/enrol/${factorId}/confirm`,
      headers: { ...WEB, cookie: `${FACTOR_COOKIE}=${fsid}` },
      payload: JSON.stringify({ code: totpCode(secret, Date.now()) }),
    })
    expect(done.statusCode, done.body).toBe(200)
    // Enrolling IS answering — they produced a code from the thing they just registered, in front of
    // us. Asking them to sign in again would be asking for the same proof twice.
    expect(cookie(done, SESSION_COOKIE), 'and they are in').toBeTruthy()
  }, 120_000)

  it('refuses this door to somebody who ALREADY holds a factor', async () => {
    // Otherwise "I know the password" becomes "I can add an authenticator", which is the
    // re-authentication ADR-219 §8 asks for, skipped.
    const m = await localMember('already', 'member')
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: m.sub, secret: generateTotpSecret() })
    await confirmFactor(db, factorId)
    await setStance(true)
    const fsid = cookie(await signIn(m.email), FACTOR_COOKIE)!

    const res = await app.inject({
      method: 'POST', url: '/auth/local/factor/enrol', headers: { ...WEB, cookie: `${FACTOR_COOKIE}=${fsid}` },
      payload: '{}',
    })
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('factor_required')
  }, 120_000)

  it('refuses without a receipt', async () => {
    await setStance(true)
    const res = await app.inject({ method: 'POST', url: '/auth/local/factor/enrol', headers: WEB, payload: '{}' })
    expect(res.statusCode).toBe(401)
  }, 120_000)
})
