// #652 slice 2 / ADR-219 §4: the tenant's second-factor stance, and the floor on both sides of it.
//
// The two halves are tested together because they are one guard. #605's is two-sided for a reason its
// own source states — "the same floor the ON precondition set, or the switch's own requirement dies one
// delete later" — and a suite that pinned only the precondition would be green on a product where the
// admin who satisfied it can give the factor up a moment afterwards.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import { totpCode, generateTotpSecret } from '../auth/totp.js'
import { startTotpEnrolment, confirmFactor } from '../auth/second-factors.js'
import { adminWithFactorCount, wouldStrandTenant, secondFactorRequired } from '../auth/factor-policy.js'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const AUTH = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
const H = { ...AUTH, 'content-type': 'application/json' }

let app: FastifyInstance
let db: TenantDb
const subs: string[] = []

const setStance = (secondFactorRequired: boolean) =>
  app.inject({ method: 'PATCH', url: '/admin/login-methods', headers: H, payload: JSON.stringify({ secondFactorRequired }) })

const view = async () =>
  (await app.inject({ method: 'GET', url: '/admin/login-methods', headers: AUTH }))
    .json() as { secondFactorRequired: { selected: boolean; canEnable: boolean; entitled: boolean } }

/** A seated member with a CONFIRMED factor, which is the only kind the guards count. */
async function memberWithFactor(name: string, role: 'admin' | 'member'): Promise<string> {
  const sub = `p652-${name}-${STAMP}`
  subs.push(sub)
  await adminPool`
    INSERT INTO members (tenant_id, sub, email, role) VALUES (${TENANT}, ${sub}, ${`${sub}@e2e.test`}, ${role})
    ON CONFLICT (tenant_id, sub) DO UPDATE SET role = ${role}`
  const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: sub, secret: generateTotpSecret() })
  await confirmFactor(db, factorId)
  return sub
}

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
}, 180_000)

beforeEach(async () => {
  // Both the stance and dev-user's factors are shared state this file writes; every case states its own
  // starting point rather than inheriting the last one's.
  await adminPool`UPDATE tenant_login_prefs SET second_factor_required = FALSE WHERE tenant_id = ${TENANT}`.catch(() => {})
  await adminPool`DELETE FROM member_factors WHERE tenant_id = ${TENANT} AND member_sub = 'dev-user'`.catch(() => {})
  for (const sub of subs) await adminPool`DELETE FROM member_factors WHERE member_sub = ${sub}`.catch(() => {})
})

afterAll(async () => {
  await adminPool`UPDATE tenant_login_prefs SET second_factor_required = FALSE WHERE tenant_id = ${TENANT}`.catch(() => {})
  await adminPool`DELETE FROM member_factors WHERE tenant_id = ${TENANT} AND member_sub = 'dev-user'`.catch(() => {})
  for (const sub of subs) {
    await adminPool`DELETE FROM member_factors WHERE member_sub = ${sub}`.catch(() => {})
    await adminPool`DELETE FROM members WHERE sub = ${sub}`.catch(() => {})
  }
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

describe('#652: turning the requirement on', () => {
  it('is refused while no admin holds a factor', async () => {
    // The lock-out wearing a success response: the person who would have to undo it is the one shut out.
    expect(await adminWithFactorCount(db), 'the premise: nobody is enrolled').toBe(0)
    const res = await setStance(true)
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('admin_factor_required')
    expect(await secondFactorRequired(db), 'and nothing was written').toBe(false)
  }, 120_000)

  it('is allowed once one does, and the stance is stored', async () => {
    await memberWithFactor('admin-a', 'admin')
    expect((await setStance(true)).statusCode).toBe(204)
    expect(await secondFactorRequired(db)).toBe(true)
  }, 120_000)

  it('does not count a MEMBER, nor an abandoned enrolment', async () => {
    // Both are ways to satisfy the precondition without anybody who can actually get in.
    await memberWithFactor('plain', 'member')
    const strayAdmin = `p652-stray-${STAMP}`
    subs.push(strayAdmin)
    await adminPool`
      INSERT INTO members (tenant_id, sub, email, role) VALUES (${TENANT}, ${strayAdmin}, ${`${strayAdmin}@e2e.test`}, 'admin')
      ON CONFLICT (tenant_id, sub) DO UPDATE SET role = 'admin'`
    await startTotpEnrolment(db, { tenantId: TENANT, memberSub: strayAdmin, secret: generateTotpSecret() }) // not confirmed

    expect(await adminWithFactorCount(db), 'a member and a pending row count for nothing').toBe(0)
    expect((await setStance(true)).statusCode).toBe(409)
  }, 120_000)

  it('turning it OFF is always allowed', async () => {
    await memberWithFactor('admin-off', 'admin')
    expect((await setStance(true)).statusCode).toBe(204)
    expect((await setStance(false)).statusCode, 'no precondition on the way down').toBe(204)
    expect(await secondFactorRequired(db)).toBe(false)
  }, 120_000)

  it('the screen is told why the switch is unavailable, rather than discovering it', async () => {
    const before = await view()
    expect(before.secondFactorRequired.selected).toBe(false)
    expect(before.secondFactorRequired.canEnable, 'nobody enrolled yet').toBe(false)
    // …and the edition question is answered separately, because "your plan does not include this" and
    // "nobody here could satisfy it" are different problems with different fixes.
    expect(before.secondFactorRequired.entitled, 'the seam answers CE today (#644 ruling pending)').toBe(true)

    await memberWithFactor('admin-view', 'admin')
    expect((await view()).secondFactorRequired.canEnable, 'now it can').toBe(true)
  }, 120_000)
})

describe('#652: the floor on the way out', () => {
  it('refuses the last admin factor while the policy is on', async () => {
    // Enrol dev-user (an admin) as the ONLY holder, turn the policy on, then try to give it up.
    const secret = generateTotpSecret()
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user', secret })
    await confirmFactor(db, factorId)
    expect((await setStance(true)).statusCode).toBe(204)

    // The code here is deliberately a VALID one: the refusal must not be "your code was wrong". The
    // floor is checked before the code is even looked at — there is no point asking somebody to prove
    // possession of a thing they are not allowed to give up.
    const res = await app.inject({
      method: 'DELETE', headers: AUTH,
      url: `/me/factors/${factorId}?code=${totpCode(secret, Date.now())}`,
    })
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('last_admin_factor')
    expect(await adminWithFactorCount(db), 'and it is still there').toBe(1)
  }, 120_000)

  it('allows it when another admin holds one', async () => {
    const secret = generateTotpSecret()
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user', secret })
    await confirmFactor(db, factorId)
    await memberWithFactor('second-admin', 'admin')
    expect((await setStance(true)).statusCode).toBe(204)

    const res = await app.inject({
      method: 'DELETE', headers: AUTH,
      url: `/me/factors/${factorId}?code=${totpCode(secret, Date.now())}`,
    })
    expect(res.statusCode, res.body).toBe(204)
  }, 120_000)

  it('allows it when the same admin keeps another one', async () => {
    // A guard that counted admins-with-factors would refuse this for no reason: the tenant loses
    // nothing when somebody with two authenticators gives one up.
    const keep = generateTotpSecret()
    const kept = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user', secret: keep })
    await confirmFactor(db, kept.factorId)
    const spare = generateTotpSecret()
    const going = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user', secret: spare })
    await confirmFactor(db, going.factorId)
    expect((await setStance(true)).statusCode).toBe(204)

    const res = await app.inject({
      method: 'DELETE', headers: AUTH,
      url: `/me/factors/${going.factorId}?code=${totpCode(spare, Date.now())}`,
    })
    expect(res.statusCode, res.body).toBe(204)
  }, 120_000)

  it('does not apply while the policy is off', async () => {
    // The floor exists to protect the switch's requirement. With no requirement there is nothing to
    // protect, and refusing anyway would be a rule nobody asked for.
    const secret = generateTotpSecret()
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user', secret })
    await confirmFactor(db, factorId)
    expect(await secondFactorRequired(db)).toBe(false)

    const res = await app.inject({
      method: 'DELETE', headers: AUTH,
      url: `/me/factors/${factorId}?code=${totpCode(secret, Date.now())}`,
    })
    expect(res.statusCode, res.body).toBe(204)
  }, 120_000)

  it('a plain MEMBER giving up their last factor strands nobody', async () => {
    const sub = await memberWithFactor('lone-member', 'member')
    const [row] = await adminPool<{ id: string }[]>`
      SELECT id FROM member_factors WHERE member_sub = ${sub} AND confirmed_at IS NOT NULL`
    expect(await wouldStrandTenant(db, { memberSub: sub, factorId: row!.id }), 'only an admin can strand a tenant')
      .toBe(false)
  }, 120_000)
})
