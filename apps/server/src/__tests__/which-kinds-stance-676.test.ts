// #676 / ADR-222 §1 §2: the tenant says WHICH kinds it accepts, and the floor is asked about the
// stance being selected rather than about "is the requirement going on".
//
// The trap this file exists for: `any → passkey` leaves the requirement ON the whole time. A guard
// keyed to the transition (`if (on && …)`, which is what #652 shipped) waves through exactly the change
// most likely to strand a tenant — the one where every admin holding only an authenticator app stops
// being able to sign in.
//
// The passkey floor is TWO, and that is a ruling rather than an off-by-one (#672 ②): a passkey cannot be
// written down, so the de-facto backup a TOTP has — the photographed QR, the password manager — does
// not exist, and one key is a single accident from a locked workspace.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { secondFactorStance, secondFactorRequired, floorFor, acceptedKinds, wouldStrandTenant } from '../auth/factor-policy.js'
import { startPasskeyEnrolment, startTotpEnrolment, confirmFactor } from '../auth/second-factors.js'
import { storePasskey } from '../auth/passkeys.js'
import { generateTotpSecret } from '../auth/totp.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import type { Tenant } from '@wikistead/types'
import { onDomainEvent } from '@wikistead/events' // #676 ⑤ / #228: the event is additive

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const STAMP = Date.now().toString(36)
const HOST = 'dev.localhost'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const AUTH = { host: HOST, authorization: 'Bearer dev-token' }
const H = { ...AUTH, 'content-type': 'application/json' }

let app: FastifyInstance
let db: TenantDb
const subs: string[] = []

const setStance = (secondFactorKinds: string) =>
  app.inject({ method: 'PATCH', url: '/admin/login-methods', headers: H, payload: JSON.stringify({ secondFactorKinds }) })
const setBoolean = (secondFactorRequired: boolean) =>
  app.inject({ method: 'PATCH', url: '/admin/login-methods', headers: H, payload: JSON.stringify({ secondFactorRequired }) })

async function seatAdmin(name: string): Promise<string> {
  const sub = `p676-${name}-${STAMP}`
  if (!subs.includes(sub)) subs.push(sub)
  await admin`
    INSERT INTO members (tenant_id, sub, email, role) VALUES (${T}, ${sub}, ${`${sub}@e2e.test`}, 'admin')
    ON CONFLICT (tenant_id, sub) DO UPDATE SET role = 'admin'`
  return sub
}

/** One confirmed passkey for `sub`, made at this host, so it counts. */
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

describe('#676: the floor is about the stance, not about the transition', () => {
  it('a NARROWING with nobody who can satisfy it is refused, though the requirement never turned off', async () => {
    // The whole point of the file. `any` is satisfiable (a TOTP admin), `passkey` is not.
    const a = await seatAdmin('narrow')
    await giveTotp(a)
    expect((await setStance('any')).statusCode, 'the requirement goes on').toBe(204)
    expect(await secondFactorRequired(db)).toBe(true)

    const res = await setStance('passkey')
    expect(res.statusCode, res.body).toBe(409)
    // #672 the PASSKEY floor has its own code now. It shared `admin_factor_required` with the
    // ON/OFF switch, and the screen printed the switch's sentence — "enrol a second factor" — at an
    // admin who already held one. What this case measures (the narrowing is refused, nothing written)
    // is unchanged; only the name of the refusal is.
    expect(res.json<{ code: string }>().code).toBe('admin_passkey_floor')
    expect(await secondFactorStance(db), 'and nothing was written').toBe('any')
  }, 180_000)

  it('…and the same narrowing is allowed once the floor is met, spread across admins', async () => {
    // The control. Without it, a guard that refused every narrowing would pass the case above.
    //
    // #685: the COUNT comes from `floorFor`. It used to seat exactly two admins with a key each, which
    // is this case's subject only incidentally — what it measures is "spread across people satisfies
    // the floor", and that is true at any floor. Moving the ruling should not make this file wrong.
    for (let i = 0; i < floorFor('passkey'); i++) {
      const sub = await seatAdmin(`two-${i}`)
      await givePasskey(sub, `two-${i}`)
    }
    await admin`INSERT INTO tenant_login_prefs (tenant_id, second_factor_required, second_factor_kinds)
                VALUES (${T}, TRUE, 'any')
                ON CONFLICT (tenant_id) DO UPDATE SET second_factor_required = TRUE, second_factor_kinds = 'any'`

    expect((await setStance('passkey')).statusCode).toBe(204)
    expect(await secondFactorStance(db)).toBe('passkey')
  }, 180_000)

  it('one short of the floor is not enough, and reaching it on ONE admin is', async () => {
    // The ruling, both halves. Counting admins rather than keys would refuse the second shape, which
    // pushes a small tenant into seating a person for the guard's benefit.
    //
    // #685: "one short" and "exactly enough" are derived. Written as 1-then-2 this case read as a claim
    // about the number two; what it is really about is the boundary, wherever the boundary sits.
    const floor = floorFor('passkey')
    const a = await seatAdmin('single')
    for (let i = 1; i < floor; i++) await givePasskey(a, `single-${i}`)
    const short = await setStance('passkey')
    expect(short.statusCode, `${floor - 1} of ${floor} passkeys was accepted :: ${short.body}`).toBe(409)
    expect(short.json<{ code: string }>().code).toBe('admin_passkey_floor')

    await givePasskey(a, `single-${floor}`)
    expect((await setStance('passkey')).statusCode, 'the whole floor on one admin is that many accidents').toBe(204)
  }, 180_000)

  it('a TOTP does not count towards the passkey floor', async () => {
    // …which is the difference between "a floor" and "the floor for THIS stance".
    // #685: one SHORT of the floor in passkeys, plus an authenticator app that cannot make up the
    // difference. At any floor the arithmetic is the same claim.
    const a = await seatAdmin('mixed')
    for (let i = 1; i < floorFor('passkey'); i++) await givePasskey(a, `mixed-key-${i}`)
    await giveTotp(a)
    const res = await setStance('passkey')
    expect(res.statusCode, `${floorFor('passkey') - 1} passkeys and a TOTP is still short :: ${res.body}`).toBe(409)
  }, 180_000)
})

describe('#676: off is not the empty set', () => {
  it('accepts every kind, so nothing an enrolment door asks is refused by the stance', () => {
    // Written as a unit truth because the failure it prevents is a reading, not a query: an
    // implementation that treated `off` as "accepts no kind" would close both enrolment doors under
    // §5's refusal — and then the floor could never be met and the stance could never go on again.
    expect(acceptedKinds('off').sort()).toEqual(['passkey', 'totp'])
    expect(floorFor('off'), 'and nobody has to be able to satisfy nothing').toBe(1)
    expect(acceptedKinds('any').sort(), 'any accepts both too').toEqual(['passkey', 'totp'])
    expect(acceptedKinds('passkey')).toEqual(['passkey'])
    expect(acceptedKinds('totp')).toEqual(['totp'])
  })

  it('turning the stance off is never refused', async () => {
    const a = await seatAdmin('off-path')
    await giveTotp(a)
    expect((await setStance('any')).statusCode).toBe(204)
    // …even with nothing enrolled any more: the escape route from a stance nobody can satisfy.
    await admin`DELETE FROM member_factors WHERE member_sub = ${a}`
    expect((await setStance('off')).statusCode, 'no precondition on the way down').toBe(204)
    expect(await secondFactorStance(db)).toBe('off')
  }, 180_000)
})

describe('#676: a one-person workspace is not offered passkeys', () => {
  // Ruling ②-2: what stays exposed there is "the only admin loses their key", which is #650's subject.
  // `tenant_acme` is the seeded one-member tenant; its own admin holds the keys so the FLOOR is met and
  // the only thing left to refuse is the size.
  const ACME = 'tenant_acme'
  // A SESSION for acme's own admin: the dev bearer is bound to tenant_dev (#471 / ADR-176), so it
  // answers 401 here — measured, and it is the guard working rather than a fixture problem.
  const setAcme = async (secondFactorKinds: string) => {
    const sid = await createSession(app.valkey, { tenantId: ACME, sub: 'acme-admin', role: 'admin' })
    return app.inject({
      method: 'PATCH', url: '/admin/login-methods',
      headers: { host: 'acme.localhost', 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${sid}` },
      payload: JSON.stringify({ secondFactorKinds }),
    })
  }

  it('refuses `passkey` even with two keys, and still allows `any`', async () => {
    const acmeDb = await acquireTenantDb(asTenant(ACME))
    try {
      for (const tag of ['acme-1', 'acme-2']) {
        const { factorId } = await startPasskeyEnrolment(acmeDb, { tenantId: ACME, memberSub: 'acme-admin', label: tag })
        await storePasskey(acmeDb, {
          tenantId: ACME, factorId,
          passkey: { credentialId: `cred-${tag}-${STAMP}`, publicKey: 'pk', signCount: 0, transports: ['usb'], rpId: 'acme.localhost' },
        })
        await confirmFactor(acmeDb, factorId)
      }
      const res = await setAcme('passkey')
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json<{ code: string }>().code).toBe('passkey_needs_second_member')

      // The control: the same tenant, the same keys, a stance that does not need company. Without it,
      // a tenant simply unable to change anything would satisfy the case above.
      expect((await setAcme('any')).statusCode, 'requiring a factor at all is still offered').toBe(204)
      expect(await secondFactorStance(acmeDb)).toBe('any')
    } finally {
      await admin`UPDATE tenant_login_prefs SET second_factor_required = FALSE, second_factor_kinds = 'off' WHERE tenant_id = ${ACME}`.catch(() => {})
      await admin`DELETE FROM member_factors WHERE tenant_id = ${ACME} AND member_sub = 'acme-admin'`.catch(() => {})
      await acmeDb.release()
    }
  }, 180_000)
})

describe('#676: the old spelling still works', () => {
  it('a boolean writes the two ends of the axis', async () => {
    // #652's clients send `secondFactorRequired`. Breaking them to add a field would be the opposite of
    // what #228 asks of a new capability.
    const a = await seatAdmin('boolean')
    await giveTotp(a)
    expect((await setBoolean(true)).statusCode).toBe(204)
    expect(await secondFactorStance(db), 'true means "any kind will do"').toBe('any')
    expect(await secondFactorRequired(db)).toBe(true)

    expect((await setBoolean(false)).statusCode).toBe(204)
    expect(await secondFactorStance(db)).toBe('off')
  }, 180_000)

  it('an unknown stance is refused rather than silently ignored', async () => {
    const res = await setStance('sometimes')
    expect(res.statusCode, res.body).toBe(400)
    expect(await secondFactorStance(db)).toBe('off')
  }, 180_000)
})

// #677 review: the floor was one-sided. `wouldStrandTenant` asked "is any factor left" while the stance
// may accept only one KIND and may ask for TWO of them — so a tenant could go from two admin passkeys
// to none by deleting them one at a time, each delete answering "somebody else still holds one" about
// an authenticator app the door refuses. The floor #676 sets on the way in was dismantled on the way
// out, which is precisely what #605's two-sided guard exists to prevent.
describe('#676: the floor holds on the way out too', () => {
  it('the LAST passkey above the floor cannot be given up while `passkey` is selected', async () => {
    // #685: EXACTLY the floor, however many that is — the state where the next removal is the one that
    // strands the tenant. Written as two fixed keys this read as a claim about the number two.
    const a = await seatAdmin('out-a')
    await givePasskey(a, 'out-a')
    for (let i = 1; i < floorFor('passkey'); i++) {
      const other = await seatAdmin(`out-${i}`)
      await givePasskey(other, `out-${i}`)
    }
    await giveTotp(a) // …and an authenticator app, which under `passkey` protects nobody
    expect((await setStance('passkey')).statusCode).toBe(204)

    const [row] = await admin<{ id: string }[]>`
      SELECT id FROM member_factors WHERE member_sub = ${a} AND kind = 'passkey'`
    expect(await wouldStrandTenant(db, { memberSub: a, factorId: row!.id, host: HOST }),
      'the tenant is at the floor, so giving one up takes it below').toBe(true)
  }, 180_000)

  it('…and a third key makes the same delete safe', async () => {
    // The control. Without it a guard that refused every passkey removal would pass the case above and
    // trap a tenant that has plenty.
    // #685: one MORE than the floor — the smallest state in which the removal is safe.
    const a = await seatAdmin('out3-a')
    await givePasskey(a, 'out3-a')
    for (let i = 1; i <= floorFor('passkey'); i++) {
      const other = await seatAdmin(`out3-${i}`)
      await givePasskey(other, `out3-${i}`)
    }
    expect((await setStance('passkey')).statusCode).toBe(204)

    const [row] = await admin<{ id: string }[]>`
      SELECT id FROM member_factors WHERE member_sub = ${a} AND label = ${'out3-a'}`
    expect(await wouldStrandTenant(db, { memberSub: a, factorId: row!.id, host: HOST }),
      'three keys, one given up, two remain — the floor still stands').toBe(false)
  }, 180_000)

  it('an authenticator app is freely removable under `passkey` — it protects nobody', async () => {
    const a = await seatAdmin('out-app')
    await givePasskey(a, 'out-app-key')
    await givePasskey(a, 'out-app-key2')
    await giveTotp(a)
    expect((await setStance('passkey')).statusCode).toBe(204)

    const [row] = await admin<{ id: string }[]>`
      SELECT id FROM member_factors WHERE member_sub = ${a} AND kind = 'totp'`
    expect(await wouldStrandTenant(db, { memberSub: a, factorId: row!.id, host: HOST })).toBe(false)
  }, 180_000)
})

// #676 ruling ⑤ / #228: the event GREW. It did not change shape.
//
// `kinds` is the new fact; `required` stays, derived, so a subscriber written against the boolean —
// one that has never heard of a stance — keeps working. That is what "additive" means, and it is the
// half of the ruling that has a consumer outside this repository.
//
// Measured because nothing did: pinning `required` to `false` at the emit site left twenty-four
// assertions green. A subscriber that pages somebody when a tenant drops its second-factor
// requirement would have gone quiet, and the suite would have said nothing.
describe('#676 ⑤: the event grew rather than changed', () => {
  const emitted: { required: boolean; kinds?: string }[] = []
  let off: (() => void) | undefined

  beforeAll(() => {
    off = onDomainEvent((e) => {
      if (e.type === 'tenant.second_factor_policy_changed' && e.tenantId === T) {
        emitted.push({ required: e.required, kinds: (e as { kinds?: string }).kinds })
      }
    })
  })
  afterAll(() => off?.())

  // The floor refuses a stance nobody can satisfy, and this file's `beforeEach` clears the factors —
  // so each case here seats an admin who can. Without it the switch answers 409 and the emissions
  // being measured never happen, which reads as "the event is missing" rather than "the floor held".
  let n = 0
  beforeEach(async () => {
    // A FRESH admin per case. The file-level `beforeEach` clears the factors, and re-enrolling for the
    // same sub each time stacks rows on one member rather than restoring the precondition.
    await giveTotp(await seatAdmin(`evt${n++}`))
  })

  it('carries both the new value and the old one, and they agree', async () => {
    // Every stance, because the derivation is where a boolean and a set can disagree: `off` is the
    // only one that means "not required", and the other three all mean "required" for a subscriber
    // that only knows the boolean.
    for (const [stance, required] of [['any', true], ['totp', true], ['off', false]] as const) {
      emitted.length = 0
      expect((await setStance(stance)).statusCode, `${stance} was refused`).toBe(204)
      const last = emitted.at(-1)
      expect(last, `${stance} emitted nothing`).toBeTruthy()
      expect(last!.kinds, `${stance}: the new fact is missing`).toBe(stance)
      expect(last!.required, `${stance}: an old subscriber would read this as ${last!.required}`).toBe(required)
    }
  }, 180_000)

  it('…including the narrowing that has no boolean of its own', async () => {
    // `any → totp` changes nothing a boolean can express: it was required before and it is required
    // now. The point of `kinds` is that the change is visible at all — and `required` must not flicker
    // while it happens, or a subscriber sees a policy being turned off and on.
    await setStance('any')
    emitted.length = 0
    expect((await setStance('totp')).statusCode).toBe(204)
    expect(emitted.map((e) => e.required), 'the requirement appeared to drop during a narrowing')
      .not.toContain(false)
    expect(emitted.at(-1)?.kinds).toBe('totp')
  }, 180_000)
})
