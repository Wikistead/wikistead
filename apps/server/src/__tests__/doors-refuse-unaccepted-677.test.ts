// #677 / ADR-222 §5: the doors refuse a kind the tenant does not accept — and there are three of them.
//
// Not one gate. The sign-in step picks its branch from the SHAPE of the body (a passkey assertion or a
// code), the challenge is a third route, and the code branch already filters by kind and therefore
// looks finished. An implementer reading "under `passkey` it must try only passkeys" gates the code
// path, ships, and leaves passkeys working under `totp` — the setting decorative in exactly one
// direction, which no single-direction test would show.
//
// The heavier half is the DEAD END (ADR-222 §3). `enrolled` used to mean "any confirmed row": under a
// passkey stance, a member holding only an authenticator app was told to present the factor they hold,
// refused for its kind, and then refused enrolment for holding one. Both halves are measured here, and
// the second is the reason this ticket exists at the same time as the first.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { FACTOR_COOKIE } from '../auth/factor-session.js'
import { SESSION_COOKIE } from '../auth/session.js'
import { startPasskeyEnrolment, startTotpEnrolment, confirmFactor } from '../auth/second-factors.js'
import { storePasskey } from '../auth/passkeys.js'
import { generateTotpSecret, totpCode } from '../auth/totp.js'
import { hashPassword } from '../auth/password-hash.js'
import type { Tenant } from '@wikistead/types'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
// #700: this file flips the tenant-wide stance and wipes dev-user's factor rows per test — both
// writes reached every parallel neighbour on tenant_dev. A private tenant owns them.
let T: string
let HOST: string
let pt: PrivateTenant
const STAMP = Date.now().toString(36)
const PASSWORD = 'a password for the 677 doors'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
let H: { host: string; 'content-type': string; 'sec-fetch-site': string }
let AUTH: { host: string; authorization: string; 'content-type': string }

let app: FastifyInstance
let db: TenantDb
let priorLocalLogin = false
const emails: string[] = []

const setStance = (kinds: string) => admin`
  INSERT INTO tenant_login_prefs (tenant_id, second_factor_required, second_factor_kinds, local_login_enabled)
  VALUES (${T}, ${kinds !== 'off'}, ${kinds}, TRUE)
  ON CONFLICT (tenant_id) DO UPDATE
    SET second_factor_required = ${kinds !== 'off'}, second_factor_kinds = ${kinds}, local_login_enabled = TRUE`

/**
 * A member with a password, made the way `/auth/local/accept` makes one — rows plus the FGA membership,
 * because `establishMemberSession` refuses a sub that is only a row (#471) and the refusal looks exactly
 * like a wrong password.
 */
async function memberWithPassword(name: string): Promise<{ sub: string; email: string }> {
  const sub = `wlocal_p677-${name}-${STAMP}`
  const email = `p677-${name}-${STAMP}@e2e.test`
  emails.push(email)
  await admin`
    INSERT INTO members (tenant_id, sub, email, role) VALUES (${T}, ${sub}, ${email}, 'member')
    ON CONFLICT (tenant_id, sub) DO NOTHING`
  await admin`
    INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
    VALUES (${T}, ${sub}, ${email}, ${await hashPassword(PASSWORD)})
    ON CONFLICT (tenant_id, member_sub) DO UPDATE SET password_hash = EXCLUDED.password_hash`
  const { ensureMembers } = await import('./helpers/membership.js')
  await ensureMembers(T, [sub])
  return { sub, email }
}

const signIn = (identifier: string) =>
  app.inject({ method: 'POST', url: '/auth/local/login', headers: H, payload: JSON.stringify({ identifier, password: PASSWORD }) })

const cookieOf = (res: Awaited<ReturnType<typeof signIn>>) =>
  res.cookies.find((c) => c.name === FACTOR_COOKIE)?.value

beforeAll(async () => {
  pt = await privateTenant(admin, 't677d')
  T = pt.id
  HOST = `${pt.slug}.localhost`
  H = { host: HOST, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }
  AUTH = pt.H
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(T))
  const [pref] = await admin<{ local_login_enabled: boolean }[]>`
    SELECT local_login_enabled FROM tenant_login_prefs WHERE tenant_id = ${T}`
  priorLocalLogin = pref?.local_login_enabled ?? false
}, 180_000)

beforeEach(async () => {
  await setStance('off')
  await admin`DELETE FROM member_factors WHERE tenant_id = ${T} AND member_sub = 'dev-user'`.catch(() => {})
})

afterAll(async () => {
  await admin`
    UPDATE tenant_login_prefs SET second_factor_required = FALSE, second_factor_kinds = 'off',
      local_login_enabled = ${priorLocalLogin} WHERE tenant_id = ${T}`.catch(() => {})
  await admin`DELETE FROM member_factors WHERE tenant_id = ${T} AND member_sub = 'dev-user'`.catch(() => {})
  // The SEAT outlives everything else and pushes the tenant past its cap in later runs.
  for (const email of emails) {
    const mine = admin`SELECT sub FROM members WHERE tenant_id = ${T} AND email = ${email}`
    await admin`DELETE FROM member_factors WHERE member_sub IN (${mine})`.catch(() => {})
    await admin`DELETE FROM local_credentials WHERE tenant_id = ${T} AND member_sub IN (${mine})`.catch(() => {})
    await admin`DELETE FROM members WHERE tenant_id = ${T} AND email = ${email}`.catch(() => {})
  }
  await pt.dispose()
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 180_000)

describe('#677: the sign-in door refuses an unaccepted kind, in both directions', () => {
  it('a passkey assertion is refused under a `totp` stance', async () => {
    // The direction an implementer is most likely to leave open: the code branch was already filtered
    // by kind before this ticket, so gating "only passkeys under `passkey`" looks like the whole job.
    const { sub, email } = await memberWithPassword('pk-under-totp')
    const { factorId } = await startPasskeyEnrolment(db, { tenantId: T, memberSub: sub, label: 'key' })
    await storePasskey(db, {
      tenantId: T, factorId,
      passkey: { credentialId: `cred-677-${STAMP}`, publicKey: 'pk', signCount: 0, transports: ['usb'], rpId: HOST },
    })
    await confirmFactor(db, factorId)
    await setStance('totp')

    const fsid = cookieOf(await signIn(email))!
    const res = await app.inject({
      method: 'POST', url: '/auth/local/factor',
      headers: { ...H, cookie: `${FACTOR_COOKIE}=${fsid}` },
      payload: JSON.stringify({ passkey: { id: 'whatever' } }),
    })
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('factor_kind_not_accepted')
  }, 180_000)

  it('a code is refused under a `passkey` stance', async () => {
    const { sub, email } = await memberWithPassword('code-under-pk')
    const { factorId } = await startTotpEnrolment(db, { tenantId: T, memberSub: sub, secret: generateTotpSecret() })
    await confirmFactor(db, factorId)
    await setStance('passkey')

    const fsid = cookieOf(await signIn(email))!
    const res = await app.inject({
      method: 'POST', url: '/auth/local/factor',
      headers: { ...H, cookie: `${FACTOR_COOKIE}=${fsid}` },
      payload: JSON.stringify({ code: '000000' }),
    })
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json<{ code: string }>().code, 'not "your code was wrong" — it was never looked at').toBe('factor_kind_not_accepted')
  }, 180_000)

  it('the passkey CHALLENGE is refused too, not only the assertion', async () => {
    // Gate the branches and forget this, and a member meets a browser prompt that can only end in a
    // refusal — the key is asked for, touched, and then told it was never acceptable.
    const { sub, email } = await memberWithPassword('challenge')
    const { factorId } = await startPasskeyEnrolment(db, { tenantId: T, memberSub: sub, label: 'key' })
    await storePasskey(db, {
      tenantId: T, factorId,
      passkey: { credentialId: `cred-677c-${STAMP}`, publicKey: 'pk', signCount: 0, transports: ['usb'], rpId: HOST },
    })
    await confirmFactor(db, factorId)
    await setStance('totp')

    const fsid = cookieOf(await signIn(email))!
    const res = await app.inject({
      method: 'POST', url: '/auth/local/factor/passkey/options',
      headers: { ...H, cookie: `${FACTOR_COOKIE}=${fsid}` }, payload: '{}',
    })
    expect(res.statusCode, res.body).toBe(409)
  }, 180_000)

  it('…and under `any` both are still offered', async () => {
    // The control. Without it a build that refused every kind — or that had no factor step at all —
    // would satisfy all three cases above.
    const { sub, email } = await memberWithPassword('any-both')
    const { factorId } = await startPasskeyEnrolment(db, { tenantId: T, memberSub: sub, label: 'key' })
    await storePasskey(db, {
      tenantId: T, factorId,
      passkey: { credentialId: `cred-677a-${STAMP}`, publicKey: 'pk', signCount: 0, transports: ['usb'], rpId: HOST },
    })
    await confirmFactor(db, factorId)
    await setStance('any')

    const fsid = cookieOf(await signIn(email))!
    const opts = await app.inject({
      method: 'POST', url: '/auth/local/factor/passkey/options',
      headers: { ...H, cookie: `${FACTOR_COOKIE}=${fsid}` }, payload: '{}',
    })
    expect(opts.statusCode, 'a challenge is issued').toBe(200)

    // …and a WRONG code is refused as a wrong code, not as a wrong kind: the branch was entered.
    const code = await app.inject({
      method: 'POST', url: '/auth/local/factor',
      headers: { ...H, cookie: `${FACTOR_COOKIE}=${fsid}` }, payload: JSON.stringify({ code: '000000' }),
    })
    expect(code.json<{ code?: string }>().code, `the code path ran :: ${code.body}`).not.toBe('factor_kind_not_accepted')
  }, 180_000)
})

describe('#677: the enrolment doors refuse it too — not the screen', () => {
  it('the session doors answer 409 for the kind the tenant does not accept', async () => {
    // #613: hiding the button leaves the POST working for anybody who has seen the form once.
    await setStance('passkey')
    const totp = await app.inject({ method: 'POST', url: '/me/factors/totp', headers: AUTH, payload: '{}' })
    expect(totp.statusCode, totp.body).toBe(409)
    expect(totp.json<{ code: string }>().code).toBe('factor_kind_not_accepted')

    await setStance('totp')
    const key = await app.inject({ method: 'POST', url: '/me/factors/passkey', headers: AUTH, payload: '{}' })
    expect(key.statusCode, key.body).toBe(409)
  }, 180_000)

  it('`off` closes NEITHER door', async () => {
    // ADR-222 §1's trap, and the one this slice is most likely to spring: "refuse what is not accepted"
    // written against an `off` read as the empty set closes both doors — and then the floor can never be
    // met and the stance can never go on again.
    await setStance('off')
    const totp = await app.inject({ method: 'POST', url: '/me/factors/totp', headers: AUTH, payload: '{}' })
    expect(totp.statusCode, `an authenticator can still be enrolled :: ${totp.body}`).toBe(201)
    await app.inject({ method: 'DELETE', url: `/me/factors/${totp.json<{ factorId: string }>().factorId}`, headers: AUTH })

    const key = await app.inject({ method: 'POST', url: '/me/factors/passkey', headers: AUTH, payload: '{}' })
    expect(key.statusCode, `and so can a passkey :: ${key.body}`).toBe(201)
    await app.inject({ method: 'DELETE', url: `/me/factors/${key.json<{ factorId: string }>().factorId}`, headers: AUTH })
  }, 180_000)
})

describe('#677 / ADR-222 §3: there is no dead end', () => {
  it('a member holding only an unaccepted kind is sent to ENROL, not asked to present it', async () => {
    // The whole of §3. Under the old `enrolled` — any confirmed row — this member was told "present
    // your existing factor", refused for its kind, and then refused enrolment for holding one.
    const { sub, email } = await memberWithPassword('dead-end')
    const { factorId } = await startTotpEnrolment(db, { tenantId: T, memberSub: sub, secret: generateTotpSecret() })
    await confirmFactor(db, factorId)
    await setStance('passkey')

    const res = await signIn(email)
    const body = res.json<{ ok: boolean; factor: string; kinds?: string[] }>()
    expect(body.factor, 'they are asked to enrol, because they can present nothing that counts')
      .toBe('enrolment-required')
    expect(body.kinds, '…and the screen is told WHICH kind to offer').toEqual(['passkey'])

    // …and the enrolment door does not refuse them for holding the factor that does not count.
    const fsid = cookieOf(res)!
    const enrol = await app.inject({
      method: 'POST', url: '/auth/local/factor/enrol',
      headers: { ...H, cookie: `${FACTOR_COOKIE}=${fsid}` }, payload: '{}',
    })
    expect(enrol.json<{ code?: string }>().code, 'not "present your existing factor first"').not.toBe('factor_required')
    // It refuses for a different reason — this door only mints TOTP, and #678 is the slice that fixes
    // that. A refusal naming the missing capability is not the dead end; it is the honest answer.
    expect(enrol.statusCode, enrol.body).toBe(409)
    expect(enrol.json<{ code: string }>().code).toBe('factor_kind_not_accepted')
  }, 180_000)

  it('…and somebody who CAN present one is still asked to', async () => {
    // The control for the guard #677 kept: holding an accepted factor must still mean "present it",
    // or knowing a password becomes a way to add an authenticator (ADR-219 §8's re-authentication).
    const { sub, email } = await memberWithPassword('can-present')
    const { factorId } = await startTotpEnrolment(db, { tenantId: T, memberSub: sub, secret: generateTotpSecret() })
    await confirmFactor(db, factorId)
    await setStance('totp')

    const res = await signIn(email)
    expect(res.json<{ factor: string }>().factor).toBe('required')
    const fsid = cookieOf(res)!
    const enrol = await app.inject({
      method: 'POST', url: '/auth/local/factor/enrol',
      headers: { ...H, cookie: `${FACTOR_COOKIE}=${fsid}` }, payload: '{}',
    })
    expect(enrol.statusCode).toBe(409)
    expect(enrol.json<{ code: string }>().code).toBe('factor_required')
  }, 180_000)
})

// #677 review: the START refused an unaccepted kind and the CONFIRM did not — and the confirm is where
// the enrolment becomes real and, at the interstitial, where a session is handed out.
//
// Not a race. A pending row has no TTL and is only discarded when the same member starts another
// enrolment, so the window is "begin one while the tenant accepts your kind, finish it whenever" —
// which under a passkey stance is a full `local+factor` session obtained with an authenticator app.
// Measured by an independent review before this was written; it is the same shape as the branch/
// challenge split above, one layer deeper.
describe('#677 review: the confirm side asks too', () => {
  it('a pending TOTP begun under `any` cannot be confirmed once the stance is `passkey`', async () => {
    const { sub, email } = await memberWithPassword('late-confirm')
    await setStance('any')
    const started = await app.inject({
      method: 'POST', url: '/auth/local/factor/enrol',
      headers: { ...H, cookie: `${FACTOR_COOKIE}=${cookieOf(await signIn(email))!}` }, payload: '{}',
    })
    expect(started.statusCode, started.body).toBe(201)
    const { factorId, secret } = started.json<{ factorId: string; secret: string }>()

    await setStance('passkey')
    const fsid = cookieOf(await signIn(email))!
    const res = await app.inject({
      method: 'POST', url: `/auth/local/factor/enrol/${factorId}/confirm`,
      headers: { ...H, cookie: `${FACTOR_COOKIE}=${fsid}` },
      payload: JSON.stringify({ code: totpCode(secret, Date.now()) }),
    })
    expect(res.statusCode, `a correct code for an unaccepted kind :: ${res.body}`).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('factor_kind_not_accepted')
    // The half that matters: no session came out of it.
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE), 'and no session was handed over').toBeUndefined()
    void sub
  }, 180_000)

  it('…and the session-side confirm refuses it as well', async () => {
    // Same window, the settings door. `dev-user` has a session, so this is the ordinary enrolment path.
    await setStance('any')
    const started = await app.inject({ method: 'POST', url: '/me/factors/totp', headers: AUTH, payload: '{}' })
    expect(started.statusCode).toBe(201)
    const { factorId, secret } = started.json<{ factorId: string; secret: string }>()

    await setStance('passkey')
    const res = await app.inject({
      method: 'POST', url: `/me/factors/${factorId}/confirm`, headers: AUTH,
      payload: JSON.stringify({ code: totpCode(secret, Date.now()) }),
    })
    expect(res.statusCode, res.body).toBe(409)

    const [row] = await admin<{ confirmed: boolean }[]>`
      SELECT confirmed_at IS NOT NULL AS confirmed FROM member_factors WHERE id = ${factorId}`
    expect(row?.confirmed, 'the row is still pending — nothing became real').toBe(false)
    await admin`DELETE FROM member_factors WHERE id = ${factorId}`.catch(() => {})
  }, 180_000)

  it('…and under `any` the same confirm still works', async () => {
    // The control. Without it a build that refused every confirm would satisfy both cases above — and
    // nobody could ever enrol anything.
    await setStance('any')
    const started = await app.inject({ method: 'POST', url: '/me/factors/totp', headers: AUTH, payload: '{}' })
    const { factorId, secret } = started.json<{ factorId: string; secret: string }>()
    const res = await app.inject({
      method: 'POST', url: `/me/factors/${factorId}/confirm`, headers: AUTH,
      payload: JSON.stringify({ code: totpCode(secret, Date.now()) }),
    })
    expect(res.statusCode, res.body).toBe(200)
    await admin`DELETE FROM member_factors WHERE id = ${factorId}`.catch(() => {})
  }, 180_000)
})
