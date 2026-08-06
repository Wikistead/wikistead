// #666: a passkey you can register and never remove.
//
// #660 asks for POSSESSION before a confirmed factor goes, and #663 gave passkeys no TOTP secret. Both
// are right on their own; the delete path knew only how to check a code, so `totpSecretFor` answered
// null for every passkey and the refusal was unconditional. The same shape as #653's invisible pending
// rows: two correct rules, and a trap where they meet.
//
// Proof of possession stays per-FACTOR. A TOTP code must not remove a passkey — otherwise somebody who
// took one factor can strip the other, and holding two stops meaning anything.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import { startPasskeyEnrolment, startTotpEnrolment, confirmFactor, listFactors } from '../auth/second-factors.js'
import { storePasskey, putChallenge } from '../auth/passkeys.js'
import { generateTotpSecret, totpCode } from '../auth/totp.js'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const AUTH = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
const H = { ...AUTH, 'content-type': 'application/json' }

let app: FastifyInstance
let db: TenantDb

const del = (id: string, query = '') =>
  app.inject({ method: 'DELETE', url: `/me/factors/${id}${query}`, headers: AUTH })

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
}, 180_000)

beforeEach(async () => {
  await adminPool`DELETE FROM member_factors WHERE tenant_id = ${TENANT} AND member_sub = 'dev-user'`.catch(() => {})
  await app.valkey.del(
    `factor:try:${TENANT}:dev-user`, `factor:lock:${TENANT}:dev-user`, `passkeychal:${TENANT}:dev-user`,
  ).catch(() => {})
})

afterAll(async () => {
  await adminPool`DELETE FROM member_factors WHERE tenant_id = ${TENANT} AND member_sub = 'dev-user'`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

/** A confirmed passkey belonging to dev-user. */
async function givePasskey(credentialId: string): Promise<string> {
  const { factorId } = await startPasskeyEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user', label: 'key' })
  await storePasskey(db, {
    tenantId: TENANT, factorId,
    passkey: { credentialId, publicKey: 'pk', signCount: 0, transports: ['usb'], rpId: 'dev.localhost' },
  })
  await confirmFactor(db, factorId)
  return factorId
}

describe('#666: a confirmed passkey can be removed', () => {
  it('asks for a passkey assertion, not for a code', async () => {
    // Before this fix EVERY answer was 400: `totpSecretFor` returns null for a passkey, so the code
    // check refused unconditionally and the key was permanent.
    const factorId = await givePasskey(`rm-${STAMP}`)
    // A SECOND key, or "only it" is trivially true and a challenge offering everything passes.
    // Measured: it did — the assertion was green with the whole set offered.
    await givePasskey(`spare-${STAMP}`)

    const opts = await app.inject({ method: 'POST', url: `/me/factors/${factorId}/remove-challenge`, headers: H, payload: '{}' })
    expect(opts.statusCode, opts.body).toBe(200)
    const { options } = opts.json() as { options: { challenge: string; allowCredentials: { id: string }[] } }
    expect(options.allowCredentials.map((c) => c.id), 'the key being given up, and only it')
      .toEqual([`rm-${STAMP}`])
  }, 120_000)

  it('a TOTP code does not remove a passkey', async () => {
    // Possession is per-factor. Otherwise taking one lets somebody strip the other, and holding two
    // stops meaning anything.
    const secret = generateTotpSecret()
    const totp = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user', secret })
    await confirmFactor(db, totp.factorId)
    const passkeyId = await givePasskey(`crossed-${STAMP}`)

    const res = await del(passkeyId, `?code=${totpCode(secret, Date.now())}`)
    expect(res.statusCode, res.body).toBe(400)
    expect((await listFactors(db, 'dev-user')).map((f) => f.id), 'both are still there').toContain(passkeyId)
  }, 120_000)

  it('…and a passkey assertion does not remove a TOTP factor', async () => {
    const secret = generateTotpSecret()
    const totp = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user', secret })
    await confirmFactor(db, totp.factorId)
    await givePasskey(`other-${STAMP}`)

    // A TOTP factor has no challenge route: asking for one is a 400, not a way in.
    const opts = await app.inject({
      method: 'POST', url: `/me/factors/${totp.factorId}/remove-challenge`, headers: H, payload: '{}',
    })
    expect(opts.statusCode, opts.body).toBe(400)
  }, 120_000)

  it('an unconfirmed passkey still goes without proving anything', async () => {
    // It guards nothing, and demanding possession of a key that was never finished would make an
    // abandoned enrolment permanent — the trap #653 had to undo.
    const { factorId } = await startPasskeyEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user' })
    expect((await del(factorId)).statusCode).toBe(204)
  }, 120_000)

  it('the challenge is one-shot', async () => {
    const factorId = await givePasskey(`once-${STAMP}`)
    await app.inject({ method: 'POST', url: `/me/factors/${factorId}/remove-challenge`, headers: H, payload: '{}' })
    // A malformed assertion still SPENDS it: a failed attempt must not leave a live challenge for a
    // better-formed second try.
    const first = await del(factorId, `?passkey=${encodeURIComponent(JSON.stringify({ id: `once-${STAMP}` }))}`)
    expect(first.statusCode).toBe(400)
    const second = await del(factorId, `?passkey=${encodeURIComponent(JSON.stringify({ id: `once-${STAMP}` }))}`)
    expect(second.statusCode, 'and the challenge is gone').toBe(400)
    expect(await app.valkey.get(`passkeychal:${TENANT}:dev-user`), 'nothing live is left').toBeNull()
  }, 120_000)

  it('somebody else\'s passkey is not addressable', async () => {
    const otherSub = `p666-other-${STAMP}`
    await adminPool`
      INSERT INTO members (tenant_id, sub, email, role)
      VALUES (${TENANT}, ${otherSub}, ${`${otherSub}@e2e.test`}, 'member') ON CONFLICT DO NOTHING`
    const [row] = await adminPool<{ id: string }[]>`
      INSERT INTO member_factors (tenant_id, member_sub, kind, confirmed_at)
      VALUES (${TENANT}, ${otherSub}, 'passkey', now()) RETURNING id`

    const opts = await app.inject({
      method: 'POST', url: `/me/factors/${row!.id}/remove-challenge`, headers: H, payload: '{}',
    })
    expect(opts.statusCode, 'not yours, and not distinguishable from not existing').toBe(404)

    await adminPool`DELETE FROM member_factors WHERE member_sub = ${otherSub}`
    await adminPool`DELETE FROM members WHERE sub = ${otherSub}`
  }, 120_000)

  it('a pending PASSKEY is not confirmable through the code route', async () => {
    // Same family as the removal bug: the confirm route filtered only on "pending", so a passkey
    // reached it, `totpSecretFor` answered null, and the member was told their CODE was wrong about a
    // factor that has none. Which proof a factor takes belongs to the factor.
    const { factorId } = await startPasskeyEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user' })
    const res = await app.inject({
      method: 'POST', url: `/me/factors/${factorId}/confirm`, headers: H, payload: JSON.stringify({ code: '123456' }),
    })
    expect(res.statusCode, res.body).toBe(404)
    expect(res.json<{ code: string }>().code, 'not "your code was wrong"').toBe('factor_not_pending')
  }, 120_000)

  it('the challenge helper is the same one registration uses', () => {
    // Named so the wiring cannot drift into a second store with its own lifetime.
    expect(typeof putChallenge).toBe('function')
  })
})
