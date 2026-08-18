// #650 / ADR-226 — the recovery DOOR and the MINT surface, driven through real cookies.
//
// The unit file beside this one (`recovery-codes-650`) proves the store's rules. This one exists because
// everything else that can go wrong is about what the ROUTES do: whether the receipt is what identifies
// the caller, whether the sessions really die, whether a stolen session can mint itself a set, and
// whether the notices are actually queued rather than merely intended.
//
// ⚠️ The notices are asserted AT THE OUTBOX (ADR-226 §7's wording). A test that checked "we called the
// mailer" would pass on a deployment with no mailer configured, which is most self-hosted ones.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import { totpCode, generateTotpSecret } from '../auth/totp.js'
import { startTotpEnrolment, confirmFactor, totpSecretFor } from '../auth/second-factors.js'
import { hashPassword } from '../auth/password-hash.js'
import { SESSION_COOKIE } from '../auth/session.js'
import { FACTOR_COOKIE } from '../auth/factor-session.js'
import { mintRecoveryCodes, recoveryCodesUsable } from '../auth/recovery-codes.js'
import { ensureMembers } from './helpers/membership.js'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const WEB = { host: 'dev.localhost', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }
const PASSWORD = 'correct horse battery staple 650'

let priorLocalLogin = false
let app: FastifyInstance
let db: TenantDb
const subs: string[] = []

async function localMember(name: string, role: 'admin' | 'member' = 'member'): Promise<{ sub: string; email: string }> {
  const sub = `wlocal_r650-${name}-${STAMP}`
  const email = `r650-${name}-${STAMP}@e2e.test`
  subs.push(sub)
  await adminPool`
    INSERT INTO members (tenant_id, sub, email, role) VALUES (${TENANT}, ${sub}, ${email}, ${role})
    ON CONFLICT (tenant_id, sub) DO UPDATE SET role = ${role}`
  await adminPool`
    INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
    VALUES (${TENANT}, ${sub}, ${email}, ${await hashPassword(PASSWORD)})
    ON CONFLICT (tenant_id, member_sub) DO UPDATE SET password_hash = EXCLUDED.password_hash`
  await ensureMembers(TENANT, [sub])
  return { sub, email }
}

/** Give the member a confirmed authenticator, and hand back a way to produce codes from it. */
async function enrolTotp(sub: string): Promise<{ factorId: string; code: () => Promise<string> }> {
  const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: sub, secret: generateTotpSecret() })
  await confirmFactor(db, factorId)
  return { factorId, code: async () => totpCode((await totpSecretFor(db, factorId))!, Date.now()) }
}

const signIn = (identifier: string) =>
  app.inject({ method: 'POST', url: '/auth/local/login', headers: WEB, payload: JSON.stringify({ identifier, password: PASSWORD }) })

const cookie = (res: { cookies: { name: string; value: string }[] }, name: string) =>
  res.cookies.find((c) => c.name === name)?.value

const setStance = (on: boolean) =>
  adminPool`
    INSERT INTO tenant_login_prefs (tenant_id, second_factor_required, second_factor_kinds, local_login_enabled)
    VALUES (${TENANT}, ${on}, ${on ? 'any' : 'off'}, TRUE)
    ON CONFLICT (tenant_id) DO UPDATE
      SET second_factor_required = ${on}, second_factor_kinds = ${on ? 'any' : 'off'}, local_login_enabled = TRUE`

/** Queued notices of a class for a member — the outbox, not the mailer (see the header). */
const queued = async (sub: string, cls: string): Promise<number> => {
  const [row] = await adminPool<[{ n: number }]>`
    SELECT count(*)::int AS n FROM email_outbox WHERE tenant_id = ${TENANT} AND member_sub = ${sub} AND class = ${cls}`
  return row?.n ?? 0
}

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  const [pref] = await adminPool<{ local_login_enabled: boolean }[]>`
    SELECT local_login_enabled FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`
  priorLocalLogin = pref?.local_login_enabled === true
}, 180_000)

beforeEach(async () => {
  await setStance(true)
  for (const sub of ['dev-user', ...subs]) await app.valkey.del(`authlocal:id:${sub}`).catch(() => {})
  await app.valkey.del('authlocal:ip:127.0.0.1').catch(() => {})
})

afterAll(async () => {
  await adminPool`
    UPDATE tenant_login_prefs SET second_factor_required = FALSE, second_factor_kinds = 'off',
                                  local_login_enabled = ${priorLocalLogin}
    WHERE tenant_id = ${TENANT}`.catch(() => {})
  for (const sub of subs) {
    await adminPool`DELETE FROM email_outbox WHERE member_sub = ${sub}`.catch(() => {})
    await adminPool`DELETE FROM member_recovery_codes WHERE member_sub = ${sub}`.catch(() => {})
    await adminPool`DELETE FROM member_factors WHERE member_sub = ${sub}`.catch(() => {})
    await adminPool`DELETE FROM local_credentials WHERE member_sub = ${sub}`.catch(() => {})
    await adminPool`DELETE FROM members WHERE sub = ${sub}`.catch(() => {})
  }
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

describe('#650 §4: the door takes a code, and the code performs a RESET', () => {
  it('wipes the factors, kills the old sessions and lands the member in a fresh one', async () => {
    const m = await localMember('door')
    await enrolTotp(m.sub)
    const codes = await mintRecoveryCodes(db, { tenantId: TENANT, memberSub: m.sub })

    // A live session from before, standing in for the phone that is now in somebody else's hands.
    await setStance(false)
    const before = await signIn(m.email)
    const oldSid = cookie(before, SESSION_COOKIE)
    expect(oldSid, 'a session existed before the recovery').toBeTruthy()
    await setStance(true)

    const start = await signIn(m.email)
    expect(start.json<{ factor: string; recovery?: boolean }>().factor).toBe('required')
    // The screen cannot ask `/me/factors` — there is no session — so the sign-in response is the only
    // place "you have codes" can arrive from. Without it the link is never drawn.
    expect(start.json<{ recovery?: boolean }>().recovery, 'the door says a fallback exists').toBe(true)

    const res = await app.inject({
      method: 'POST', url: '/auth/local/factor/recovery',
      headers: { ...WEB, cookie: `${FACTOR_COOKIE}=${cookie(start, FACTOR_COOKIE)}` },
      payload: JSON.stringify({ code: codes[0]! }),
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(cookie(res, SESSION_COOKIE), 'a fresh full session (ADR-226 §1.2)').toBeTruthy()
    expect(res.json<{ factorsRemoved: number }>().factorsRemoved, 'it is a reset, not a shortcut').toBe(1)

    const [factors] = await adminPool<[{ n: number }]>`
      SELECT count(*)::int AS n FROM member_factors WHERE member_sub = ${m.sub}`
    expect(factors!.n, 'every factor is gone').toBe(0)
    expect(await recoveryCodesUsable(db, m.sub), 'and so is the rest of the set').toBe(false)
    // #474: the session opened by the device that is no longer the member's must not survive this.
    expect(await app.valkey.get(`sess:${oldSid}`), 'the earlier session is dead').toBeNull()
    expect(await queued(m.sub, 'recovery_codes_used'), 'the member is told (§5)').toBe(1)
  }, 180_000)

  it('refuses without a receipt, and refuses another member\'s code identically', async () => {
    const mine = await localMember('mine')
    const theirs = await localMember('theirs')
    await enrolTotp(mine.sub); await enrolTotp(theirs.sub)
    const theirCodes = await mintRecoveryCodes(db, { tenantId: TENANT, memberSub: theirs.sub })

    const naked = await app.inject({
      method: 'POST', url: '/auth/local/factor/recovery', headers: WEB,
      payload: JSON.stringify({ code: theirCodes[0]! }),
    })
    expect(naked.statusCode, 'no receipt, no door').toBe(401)

    // With MY receipt and THEIR code: the authz boundary this ticket's `stop:authz` label is about.
    const start = await signIn(mine.email)
    const stolen = await app.inject({
      method: 'POST', url: '/auth/local/factor/recovery',
      headers: { ...WEB, cookie: `${FACTOR_COOKIE}=${cookie(start, FACTOR_COOKIE)}` },
      payload: JSON.stringify({ code: theirCodes[0]! }),
    })
    expect(stolen.statusCode, 'a code opens exactly one account').toBe(401)
    expect(cookie(stolen, SESSION_COOKIE)).toBeUndefined()
    expect(await recoveryCodesUsable(db, theirs.sub), 'and their code was not burned by the attempt').toBe(true)
  }, 180_000)

  it('answers a wrong code, an empty set and a spent set with the same bytes', async () => {
    const m = await localMember('uniform')
    await enrolTotp(m.sub)

    const attempt = async (code: string) => {
      const start = await signIn(m.email)
      const res = await app.inject({
        method: 'POST', url: '/auth/local/factor/recovery',
        headers: { ...WEB, cookie: `${FACTOR_COOKIE}=${cookie(start, FACTOR_COOKIE)}` },
        payload: JSON.stringify({ code }),
      })
      // The limiter would turn the fourth attempt into a 429 and stop comparing bodies, so the counters
      // are cleared between attempts: this test is about the REFUSAL, not about the throttle.
      await app.valkey.del(`authlocal:id:${m.sub}`, 'authlocal:ip:127.0.0.1').catch(() => {})
      return { status: res.statusCode, body: res.body }
    }

    const noSet = await attempt('ZZZZ-ZZZZ-ZZZZ-ZZZZ')
    const codes = await mintRecoveryCodes(db, { tenantId: TENANT, memberSub: m.sub })
    const wrong = await attempt('ZZZZ-ZZZZ-ZZZZ-ZZZZ')
    await mintRecoveryCodes(db, { tenantId: TENANT, memberSub: m.sub }) // retires the set above
    const revoked = await attempt(codes[0]!)
    process.env.SECOND_FACTOR_RECOVERY = 'off'
    const off = await attempt(codes[1]!)
    delete process.env.SECOND_FACTOR_RECOVERY

    expect([wrong, revoked, off], 'four causes, one answer').toEqual([noSet, noSet, noSet])
  }, 180_000)
})

describe('#650 §4: minting proves the account again', () => {
  it('refuses a session that cannot prove itself, and mints when it can', async () => {
    const m = await localMember('mint')
    const totp = await enrolTotp(m.sub)
    await setStance(false)
    const session = cookie(await signIn(m.email), SESSION_COOKIE)!

    const bare = await app.inject({
      method: 'POST', url: '/me/recovery-codes',
      headers: { ...WEB, cookie: `${SESSION_COOKIE}=${session}` }, payload: '{}',
    })
    // A stolen session that could mint would BE the factor bypass this feature is careful not to be.
    expect(bare.statusCode, 'a session alone is not enough').toBe(401)
    expect(bare.json<{ code: string }>().code).toBe('reauth_required')

    const ok = await app.inject({
      method: 'POST', url: '/me/recovery-codes',
      headers: { ...WEB, cookie: `${SESSION_COOKIE}=${session}` },
      payload: JSON.stringify({ password: PASSWORD }),
    })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json<{ codes: string[] }>().codes, 'ten, once, in this response only').toHaveLength(10)
    expect(await queued(m.sub, 'recovery_codes_minted'), 'and the member is told (§5)').toBe(1)

    // …and the factor's own code re-authenticates too, for a member with no password entrance.
    const byCode = await app.inject({
      method: 'POST', url: '/me/recovery-codes',
      headers: { ...WEB, cookie: `${SESSION_COOKIE}=${session}` },
      payload: JSON.stringify({ code: await totp.code() }),
    })
    expect(byCode.statusCode, byCode.body).toBe(201)
    // Re-minting retired the first set: the status never reports more than one live set's worth.
    const status = await app.inject({
      method: 'GET', url: '/me/recovery-codes', headers: { ...WEB, cookie: `${SESSION_COOKIE}=${session}` },
    })
    expect(status.json<{ remaining: number }>().remaining, 'exactly one live set').toBe(10)
    // The old set is refused at the door, which is the half a count cannot prove.
    expect((await Promise.all(ok.json<{ codes: string[] }>().codes.slice(0, 2).map(
      (c) => import('../auth/recovery-codes.js').then((m2) => m2.spendRecoveryCode(db, { memberSub: m.sub, code: c })),
    ))).every((r) => !r.ok), 'a printout you replaced is worthless').toBe(true)
  }, 180_000)

  it('refuses a member with nothing to recover', async () => {
    const m = await localMember('nofactor')
    await setStance(false)
    const session = cookie(await signIn(m.email), SESSION_COOKIE)!
    const res = await app.inject({
      method: 'POST', url: '/me/recovery-codes',
      headers: { ...WEB, cookie: `${SESSION_COOKIE}=${session}` },
      payload: JSON.stringify({ password: PASSWORD }),
    })
    // ADR-226 §2's ONE precondition. Not a predicate about the workspace — about this member's own rows.
    expect(res.statusCode).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('recovery_no_factors')
  }, 180_000)
})

describe('#650 §5: the administrator reset takes the codes with it', () => {
  it('leaves no live set behind after #644 §10a clears the factors', async () => {
    const victim = await localMember('reset-target')
    await enrolTotp(victim.sub)
    await mintRecoveryCodes(db, { tenantId: TENANT, memberSub: victim.sub })
    expect(await recoveryCodesUsable(db, victim.sub)).toBe(true)

    await setStance(false)
    // The suite's admin bearer, as `admin-factor-reset-644` drives the same route. NOT a password
    // sign-in for `dev-user`: the shared fixture has no local credential, so that would 401 and the
    // assertion below would never run — a test that passes by not reaching its subject.
    const res = await app.inject({
      method: 'DELETE', url: `/members/${encodeURIComponent(victim.sub)}/factors`,
      headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' },
    })
    expect(res.statusCode, res.body).toBe(200)
    // A reset that left the printout working would be a reset in name only.
    expect(await recoveryCodesUsable(db, victim.sub), 'the set goes with the factors').toBe(false)
  }, 180_000)
})
