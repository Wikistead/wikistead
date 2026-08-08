// #672 (review rejection ①): the refusal has to name WHICH requirement is unmet.
//
// The floor threw one code — `admin_factor_required` — whichever stance had been asked for, and the
// screen answered it with the ON/OFF switch's sentence: "enrol a second factor on an admin account
// first". Said to an admin whose account already held one, while the real requirement (TWO PASSKEYS)
// appeared nowhere. The reader could not find the way forward, and re-reading the screen would never
// have produced it.
//
// Two properties, and the second is the one worth having:
//
//   1. Each floor answers with its own code.
//   2. The GET reports, for every stance, exactly what the PATCH would do about it. The screen greys
//      out what cannot be written; a SECOND implementation of "can this be written" is how the grey and
//      the 409 come to disagree, and then the picker offers a choice that always fails or hides one
//      that would have worked. Walked over every stance rather than asserting today's three answers, so
//      a fourth stance is covered by the walk instead of by somebody remembering this file.
//
// ⚠️ The greying is convenience. `stanceRefusal` is asked HERE, at the write, which is why the last
// case takes the screen out of the loop entirely and PATCHes what the screen would have refused.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { startPasskeyEnrolment, startTotpEnrolment, confirmFactor } from '../auth/second-factors.js'
import { storePasskey } from '../auth/passkeys.js'
import { floorFor } from '../auth/factor-policy.js' // #685: the floor's value has ONE home; here it is derived
import { generateTotpSecret } from '../auth/totp.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const STAMP = Date.now().toString(36)
const HOST = 'dev.localhost'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const H = { host: HOST, authorization: 'Bearer dev-token', 'content-type': 'application/json' }

/** Every kind-stance the picker offers. `off` is the switch, not a kind. */
const STANCES = ['any', 'passkey', 'totp'] as const

let app: FastifyInstance
let db: TenantDb
const subs: string[] = []

const setStance = (secondFactorKinds: string) =>
  app.inject({ method: 'PATCH', url: '/admin/login-methods', headers: H, payload: JSON.stringify({ secondFactorKinds }) })

const view = async () => {
  const res = await app.inject({ method: 'GET', url: '/admin/login-methods', headers: H })
  expect(res.statusCode, res.body).toBe(200)
  return res.json<{ secondFactorRequired: {
    stance: string; stanceRefusals: Record<string, string | null>; stanceFloors: Record<string, number>
  } }>()
}

async function seatAdmin(name: string): Promise<string> {
  const sub = `p672-${name}-${STAMP}`
  if (!subs.includes(sub)) subs.push(sub)
  await admin`
    INSERT INTO members (tenant_id, sub, email, role) VALUES (${T}, ${sub}, ${`${sub}@e2e.test`}, 'admin')
    ON CONFLICT (tenant_id, sub) DO UPDATE SET role = 'admin'`
  return sub
}

async function givePasskey(sub: string, tag: string): Promise<void> {
  const { factorId } = await startPasskeyEnrolment(db, { tenantId: T, memberSub: sub, label: tag })
  await storePasskey(db, {
    tenantId: T, factorId,
    passkey: { credentialId: `cred-${tag}-${STAMP}`, publicKey: 'pk', signCount: 0, transports: ['usb'], rpId: HOST },
  })
  await confirmFactor(db, factorId)
}

async function giveTotp(sub: string): Promise<void> {
  const { factorId } = await startTotpEnrolment(db, { tenantId: T, memberSub: sub, secret: generateTotpSecret() })
  await confirmFactor(db, factorId)
}

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(T))
}, 180_000)

beforeEach(async () => {
  await admin`UPDATE tenant_login_prefs SET second_factor_required = FALSE, second_factor_kinds = 'off' WHERE tenant_id = ${T}`.catch(() => {})
  await admin`DELETE FROM member_factors WHERE tenant_id = ${T} AND member_sub = 'dev-user'`.catch(() => {})
  for (const sub of subs) await admin`DELETE FROM member_factors WHERE member_sub = ${sub}`.catch(() => {})
})

afterAll(async () => {
  await admin`UPDATE tenant_login_prefs SET second_factor_required = FALSE, second_factor_kinds = 'off' WHERE tenant_id = ${T}`.catch(() => {})
  await admin`DELETE FROM member_factors WHERE tenant_id = ${T} AND member_sub = 'dev-user'`.catch(() => {})
  for (const sub of subs) {
    await admin`DELETE FROM member_factors WHERE member_sub = ${sub}`.catch(() => {})
    await admin`DELETE FROM members WHERE tenant_id = ${T} AND sub = ${sub}`.catch(() => {})
  }
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 180_000)

describe('#672 ①: the refusal names which requirement is unmet', () => {
  it('the passkey floor does NOT answer with the sentence about enrolling a second factor', async () => {
    // The report, exactly: an admin who HOLDS an authenticator app asks for `passkey` and is told to
    // enrol a factor. `admin_factor_required` is the ON/OFF switch's refusal — reusing it here is what
    // put that sentence on the screen, so the pin is that this case does not raise it.
    const a = await seatAdmin('holds-totp')
    await giveTotp(a)

    const res = await setStance('passkey')
    expect(res.statusCode, res.body).toBe(409)
    const code = res.json<{ code: string }>().code
    expect(code, 'the passkey floor borrowed the ON/OFF switch\'s refusal').not.toBe('admin_factor_required')
    expect(code).toBe('admin_passkey_floor')
    // …and the sentence says the NUMBER and the KIND, which is what the reader was missing. Read from
    // `message`: a thrown Error goes through Fastify's default serialiser, where `error` is the status
    // name ("Conflict") and the sentence is the message. Measured — the first draft asserted on
    // `error` and matched "Conflict" against /two passkeys/.
    //
    // #685: the FIGURE, derived. This matched /two passkeys/ — the sentence's own wording — so moving
    // the floor would have broken a test that is not about the floor's value at all, and the only
    // guard on the value itself lives in `passkey-floor-ruling-685`.
    expect(res.json<{ message: string }>().message).toMatch(
      new RegExp(`\\b${floorFor('passkey')}\\b.*passkeys`, 'i'))
  }, 180_000)

  it('the totp floor is its own refusal too (a passkey-only admin cannot satisfy it)', async () => {
    // The third meaning the one code was carrying. Without this case, splitting `passkey` out alone
    // leaves `totp` sharing a sentence with the switch — the same defect, one stance over.
    const a = await seatAdmin('holds-passkey')
    await givePasskey(a, 'holds-passkey')

    const res = await setStance('totp')
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('admin_totp_floor')
  }, 180_000)

  it('…and the switch\'s own refusal keeps its code, so the sentence it belongs to still lands', async () => {
    // The control. Renaming everything would satisfy the two cases above while breaking the screen the
    // report says is CORRECT for this case: nobody has enrolled anything, so "enrol a second factor on
    // an admin account first" is the true sentence.
    const res = await setStance('any')
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('admin_factor_required')
  }, 180_000)
})

describe('#672 ①: the screen is told exactly what the write would do', () => {
  it('every stance the GET reports as refused is refused by the PATCH, with the same code', async () => {
    // The anti-drift walk, and the reason `stanceRefusal` is one function. A stance the GET calls
    // writable but the PATCH refuses is the "button that always fails" (#606); one the GET calls
    // refused but the PATCH accepts is a choice hidden for no reason.
    //
    // Run against a tenant holding ONE passkey and no authenticator app: `any` passes, `passkey` is one
    // short of its floor, `totp` has nobody. All three answers differ, so a walk that agreed by
    // accident cannot pass.
    // #685: this fixture needs a state where `any` is satisfiable, `passkey` is SHORT and `totp` has
    // nobody — which requires a passkey that counts for one stance and not the other, and therefore a
    // passkey floor above one. At a floor of one there is no such state (the key that satisfies `any`
    // satisfies `passkey` too), so the three answers cannot differ and the walk has nothing to walk.
    // Stated rather than derived away: pretending otherwise would mean weakening the disagreement the
    // case exists to prove.
    expect(floorFor('passkey'), 'the three-way walk needs a passkey floor above one').toBeGreaterThan(1)
    const a = await seatAdmin('walk')
    for (let i = 1; i < floorFor('passkey'); i++) await givePasskey(a, `walk-${i}`)

    const seen = (await view()).secondFactorRequired
    const reported = seen.stanceRefusals
    expect(Object.keys(reported).sort(), 'the GET reports every stance the picker offers')
      .toEqual([...STANCES].sort())

    // #685: and it reports the FLOOR for each of them, because the screen prints the number in the
    // refusal's sentence and holds no copy of its own. Without this the web would interpolate
    // `undefined` and the reader would meet a sentence with a hole in it — which is why there is no
    // client-side default to fall back on: a default would be a second home for the ruling.
    expect(Object.keys(seen.stanceFloors).sort(), 'a stance the picker offers has no floor to report')
      .toEqual([...STANCES].sort())
    for (const s of STANCES) {
      expect(seen.stanceFloors[s], `the reported floor for ${s} is not the one the write uses`)
        .toBe(floorFor(s))
    }

    const written: Record<string, string | null> = {}
    for (const s of STANCES) {
      const res = await setStance(s)
      written[s] = res.statusCode === 204 ? null : res.json<{ code: string }>().code
      // Put the tenant back, so each stance is asked from the same starting state.
      await admin`UPDATE tenant_login_prefs SET second_factor_required = FALSE, second_factor_kinds = 'off' WHERE tenant_id = ${T}`
    }
    expect(written, 'the screen was told something other than what the write does').toEqual(reported)
    // …and the three answers really are three, so the agreement above means something.
    expect(new Set(Object.values(written)).size, 'the walk needs the stances to disagree').toBe(3)
  }, 180_000)

  it('the server still refuses a stance the screen would have greyed out', async () => {
    // #613: greying is convenience, the write is the fortress. A caller who never rendered the picker —
    // the API, a stale tab, curl — must hit the same wall.
    // #685: one SHORT of the floor, derived. Written as a single key this case only described a
    // refusal at a floor of two.
    const a = await seatAdmin('fortress')
    for (let i = 1; i < floorFor('passkey'); i++) await givePasskey(a, `fortress-${i}`)
    expect((await view()).secondFactorRequired.stanceRefusals.passkey, 'the screen would grey it out')
      .toBe('admin_passkey_floor')

    const res = await setStance('passkey')
    expect(res.statusCode, 'the PATCH waved through what the screen refuses').toBe(409)
    const [row] = await admin<{ second_factor_kinds: string }[]>`
      SELECT second_factor_kinds FROM tenant_login_prefs WHERE tenant_id = ${T}`
    expect(row?.second_factor_kinds, 'and nothing was written').toBe('off')
  }, 180_000)

  it('a writable stance is reported as writable (the walk is not "everything is refused")', async () => {
    // Without this, a `stanceRefusal` that returned a code unconditionally would satisfy every case
    // above — the picker would grey out all three and the screen would be unusable.
    // #685: the floor met, spread across admins — however many that takes.
    const a = await seatAdmin('open-a')
    await givePasskey(a, 'open-a')
    for (let i = 1; i < floorFor('passkey'); i++) {
      const other = await seatAdmin(`open-${i}`)
      await givePasskey(other, `open-${i}`)
    }
    await giveTotp(a)

    const reported = (await view()).secondFactorRequired.stanceRefusals
    expect(reported).toEqual({ any: null, passkey: null, totp: null })
    expect((await setStance('passkey')).statusCode).toBe(204)
  }, 180_000)
})
