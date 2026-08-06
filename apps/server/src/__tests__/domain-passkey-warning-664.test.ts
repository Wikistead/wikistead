// #664 / ADR-219 §1 (ruling 4): moving to a custom domain invalidates every passkey, and the flow says
// so BEFORE it commits.
//
// The refusal is the pin, not a field. There is no console for custom domains yet, so a number in the
// list response is a warning that can be skipped by not reading it — and the whole point of the ruling
// is that this must not break silently. Verification is the step that makes the domain the one serving
// the tenant, which is the moment the keys stop working.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import { storePasskey } from '../auth/passkeys.js'
import { startPasskeyEnrolment, confirmFactor } from '../auth/second-factors.js'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const DOMAIN = `wiki-664-${STAMP}.example`
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const AUTH = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
const H = { ...AUTH, 'content-type': 'application/json' }

let app: FastifyInstance
let db: TenantDb

const verify = (body?: unknown) =>
  app.inject({ method: 'POST', url: `/admin/custom-domains/${DOMAIN}/verify`, headers: H, payload: JSON.stringify(body ?? {}) })

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
}, 180_000)

beforeEach(async () => {
  await adminPool`DELETE FROM member_factors WHERE tenant_id = ${TENANT} AND member_sub = 'dev-user'`.catch(() => {})
  await adminPool`DELETE FROM custom_domains WHERE domain = ${DOMAIN}`.catch(() => {})
  await adminPool`
    INSERT INTO custom_domains (tenant_id, domain, verification_token, status)
    VALUES (${TENANT}, ${DOMAIN}, ${`tok-${STAMP}`}, 'pending')`
})

afterAll(async () => {
  await adminPool`DELETE FROM member_factors WHERE tenant_id = ${TENANT} AND member_sub = 'dev-user'`.catch(() => {})
  await adminPool`DELETE FROM custom_domains WHERE domain = ${DOMAIN}`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

/** A confirmed passkey made under the CURRENT host, i.e. one this move would strand. */
async function givePasskey(credentialId: string, rpId = 'dev.localhost'): Promise<void> {
  const { factorId } = await startPasskeyEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user' })
  await storePasskey(db, {
    tenantId: TENANT, factorId,
    passkey: { credentialId, publicKey: 'pk', signCount: 0, transports: [], rpId },
  })
  await confirmFactor(db, factorId)
}

describe('#664: a move that would strand passkeys is refused until it is acknowledged', () => {
  it('names how many, and does not verify', async () => {
    await givePasskey(`strand-${STAMP}`)
    const res = await verify()
    expect(res.statusCode, res.body).toBe(409)
    const body = res.json() as { code: string; passkeysStranded: number; error: string }
    expect(body.code).toBe('passkeys_would_be_lost')
    expect(body.passkeysStranded, 'the number, so the reader can weigh it').toBe(1)
    expect(body.error, 'and why, not just that').toMatch(/enrol again/i)

    const [row] = await adminPool<{ status: string }[]>`SELECT status FROM custom_domains WHERE domain = ${DOMAIN}`
    expect(row!.status, 'nothing was committed').toBe('pending')
  }, 120_000)

  // The cases below assert the passkey gate was PASSED, not that verification succeeded: this domain
  // does not exist, so the DNS proof that follows fails with its own 400. Asserting 204 here would be
  // asserting that a made-up domain resolves — a pin about the wrong thing, and one that could only be
  // made green by weakening the DNS check.
  const passedTheGate = (status: number) => status !== 409

  it('goes through the gate once acknowledged', async () => {
    await givePasskey(`ack-${STAMP}`)
    const res = await verify({ acknowledgePasskeyLoss: true })
    expect(passedTheGate(res.statusCode), `${res.statusCode}: past the passkey question`).toBe(true)
    // …and what stops it now is DNS, which is the next step's business rather than this one's.
    expect(res.statusCode).toBe(400)
  }, 120_000)

  it('asks nothing when there is nothing to lose', async () => {
    // A caution about something that cannot happen is one nobody reads the next time it appears.
    expect(passedTheGate((await verify()).statusCode), 'no passkeys, no question').toBe(true)
  }, 120_000)

  it('and nothing when the passkeys were already made for THAT domain', async () => {
    await givePasskey(`already-${STAMP}`, DOMAIN)
    expect(passedTheGate((await verify()).statusCode), 'moving where they already work strands nobody').toBe(true)
  }, 120_000)

  it('an unfinished enrolment is not a loss', async () => {
    const { factorId } = await startPasskeyEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user' })
    await storePasskey(db, {
      tenantId: TENANT, factorId,
      passkey: { credentialId: `pending-${STAMP}`, publicKey: 'pk', signCount: 0, transports: [], rpId: 'dev.localhost' },
    })
    expect(passedTheGate((await verify()).statusCode), 'it was never usable').toBe(true)
  }, 120_000)
})

describe('#664: the list carries the count too', () => {
  it('so a screen can warn before the button is pressed', async () => {
    await givePasskey(`list-${STAMP}`)
    const res = await app.inject({ method: 'GET', url: '/admin/custom-domains', headers: AUTH })
    const mine = (res.json() as { domain: string; passkeysStranded?: number }[]).find((d) => d.domain === DOMAIN)
    expect(mine?.passkeysStranded, 'the same number the refusal would give').toBe(1)
  }, 120_000)
})
