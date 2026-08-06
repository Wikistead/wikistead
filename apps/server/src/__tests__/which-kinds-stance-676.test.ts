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
    expect(res.json<{ code: string }>().code).toBe('admin_factor_required')
    expect(await secondFactorStance(db), 'and nothing was written').toBe('any')
  }, 180_000)

  it('…and the same narrowing is allowed once two admin passkeys exist', async () => {
    // The control. Without it, a guard that refused every narrowing would pass the case above.
    const a = await seatAdmin('two-a')
    const b = await seatAdmin('two-b')
    await givePasskey(a, 'two-a')
    await givePasskey(b, 'two-b')
    await admin`INSERT INTO tenant_login_prefs (tenant_id, second_factor_required, second_factor_kinds)
                VALUES (${T}, TRUE, 'any')
                ON CONFLICT (tenant_id) DO UPDATE SET second_factor_required = TRUE, second_factor_kinds = 'any'`

    expect((await setStance('passkey')).statusCode).toBe(204)
    expect(await secondFactorStance(db)).toBe('passkey')
  }, 180_000)

  it('ONE passkey is not enough, and two on one admin are', async () => {
    // The ruling, both halves. Counting admins rather than keys would refuse the second shape, which
    // pushes a small tenant into seating a person for the guard's benefit.
    const a = await seatAdmin('single')
    await givePasskey(a, 'single-1')
    const one = await setStance('passkey')
    expect(one.statusCode, one.body).toBe(409)
    expect(one.json<{ code: string }>().code).toBe('admin_factor_required')

    await givePasskey(a, 'single-2')
    expect((await setStance('passkey')).statusCode, 'two keys, one admin, is two accidents').toBe(204)
  }, 180_000)

  it('a TOTP does not count towards the passkey floor', async () => {
    // …which is the difference between "a floor" and "the floor for THIS stance".
    const a = await seatAdmin('mixed')
    await givePasskey(a, 'mixed-key')
    await giveTotp(a)
    const res = await setStance('passkey')
    expect(res.statusCode, `one passkey and a TOTP is still one passkey :: ${res.body}`).toBe(409)
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
    const a = await seatAdmin('out-a')
    const b = await seatAdmin('out-b')
    await givePasskey(a, 'out-a')
    await givePasskey(b, 'out-b')
    await giveTotp(a) // …and an authenticator app, which under `passkey` protects nobody
    expect((await setStance('passkey')).statusCode).toBe(204)

    const [row] = await admin<{ id: string }[]>`
      SELECT id FROM member_factors WHERE member_sub = ${a} AND kind = 'passkey'`
    expect(await wouldStrandTenant(db, { memberSub: a, factorId: row!.id, host: HOST }),
      'two keys is the floor, so giving one up takes the tenant below it').toBe(true)
  }, 180_000)

  it('…and a third key makes the same delete safe', async () => {
    // The control. Without it a guard that refused every passkey removal would pass the case above and
    // trap a tenant that has plenty.
    const a = await seatAdmin('out3-a')
    const b = await seatAdmin('out3-b')
    await givePasskey(a, 'out3-a')
    await givePasskey(a, 'out3-a2')
    await givePasskey(b, 'out3-b')
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
