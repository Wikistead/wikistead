// #663 / ADR-219 §1: registering a passkey.
//
// The library's verification is not re-tested here — that is what buying it was for, and a test that
// hand-built an attestation would be re-deriving the thing ADR-219 §9 said not to re-derive. What IS
// tested is the product's half, which is where this can go wrong without anybody noticing:
//
//   - the RP ID comes from the HOST, not from a constant. A hard-coded one registers keys that never
//     authenticate anywhere else, and every test on one host would pass.
//   - the challenge is one-shot. A survivor is a replay for whoever captured the response.
//   - a passkey and a TOTP sit in one list, because #656 split the tables so they could.
//   - `excludeCredentials` names what the member already holds, or an authenticator makes a second
//     credential silently and the second one's counter starts behind the first's.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import { rpIdFromHost, originFromHost, takeChallenge, passkeysStrandedBy, storePasskey } from '../auth/passkeys.js'
import { startPasskeyEnrolment, startTotpEnrolment, confirmFactor, listFactors } from '../auth/second-factors.js'
import { generateTotpSecret } from '../auth/totp.js'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const AUTH = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
const H = { ...AUTH, 'content-type': 'application/json' }

let app: FastifyInstance
let db: TenantDb

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
}, 180_000)

beforeEach(async () => {
  await adminPool`DELETE FROM member_factors WHERE tenant_id = ${TENANT} AND member_sub = 'dev-user'`.catch(() => {})
  await app.valkey.del(`passkeychal:${TENANT}:dev-user`).catch(() => {})
  // …and the failure counters. This file deliberately sends malformed responses, and the limiter is
  // keyed per member with a 30-minute lock — measured: after a few runs the refusals turned into 429s
  // and two cases went red with the code untouched, which reads as a regression and is leftover state.
  await app.valkey.del(`factor:try:${TENANT}:dev-user`, `factor:lock:${TENANT}:dev-user`).catch(() => {})
})

afterAll(async () => {
  await adminPool`DELETE FROM member_factors WHERE tenant_id = ${TENANT} AND member_sub = 'dev-user'`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

describe('#663: the Relying Party is where the request arrived', () => {
  it('takes the host, without its port', () => {
    // Ruling 4. A constant here would create credentials that work on one deployment and silently fail
    // on every other — and a suite that only ever asks one host would never see it.
    expect(rpIdFromHost('dev.localhost')).toBe('dev.localhost')
    expect(rpIdFromHost('dev.localhost:5173'), 'the port is not part of an RP ID').toBe('dev.localhost')
    expect(rpIdFromHost('wiki.acme.com')).toBe('wiki.acme.com')
    expect(rpIdFromHost(undefined), 'a request with no host is not an RP').toBe('')
  })

  it('and the origin the browser will claim carries the port', () => {
    // The RP ID and the origin are different strings with different rules, and swapping them is the
    // classic WebAuthn misconfiguration: the assertion is checked against the origin.
    expect(originFromHost('dev.localhost:5173')).toBe('http://dev.localhost:5173')
  })

  it('the options the browser is given name THIS host', async () => {
    const res = await app.inject({ method: 'POST', url: '/me/factors/passkey', headers: H, payload: '{}' })
    expect(res.statusCode, res.body).toBe(201)
    const { options } = res.json() as { options: { rp: { id: string }; challenge: string } }
    expect(options.rp.id, 'the RP is the host this request came to').toBe('dev.localhost')
  }, 120_000)
})

describe('#663: the challenge is one-shot', () => {
  it('is banked when the options are issued, and gone once taken', async () => {
    const res = await app.inject({ method: 'POST', url: '/me/factors/passkey', headers: H, payload: '{}' })
    const { options } = res.json() as { options: { challenge: string } }

    const first = await takeChallenge(app.valkey, TENANT, 'dev-user')
    expect(first, 'the one the browser was given').toBe(options.challenge)
    // GETDEL, not GET-then-DEL: two requests carrying the same captured response must not both read it.
    expect(await takeChallenge(app.valkey, TENANT, 'dev-user'), 'and it does not come twice').toBeNull()
  }, 120_000)

  it('a confirmation with no live challenge is refused', async () => {
    const started = await app.inject({ method: 'POST', url: '/me/factors/passkey', headers: H, payload: '{}' })
    const { factorId } = started.json() as { factorId: string }
    await takeChallenge(app.valkey, TENANT, 'dev-user') // spend it out from under the request

    const res = await app.inject({
      method: 'POST', url: `/me/factors/${factorId}/passkey`, headers: H,
      payload: JSON.stringify({ response: { id: 'x', rawId: 'x', type: 'public-key', response: {}, clientExtensionResults: {} } }),
    })
    expect(res.statusCode, res.body).toBe(400)
    expect(res.json<{ code: string }>().code).toBe('passkey_invalid')
  }, 120_000)

  it('a malformed response answers rather than throwing', async () => {
    // It reaches a caller asking "did this work". A 500 there says the product is broken when the
    // browser simply said no.
    const started = await app.inject({ method: 'POST', url: '/me/factors/passkey', headers: H, payload: '{}' })
    const { factorId } = started.json() as { factorId: string }
    const res = await app.inject({
      method: 'POST', url: `/me/factors/${factorId}/passkey`, headers: H,
      payload: JSON.stringify({ response: { nonsense: true } }),
    })
    expect(res.statusCode, res.body).toBe(400)
  }, 120_000)
})

describe('#663: a pending passkey behaves like any other pending factor', () => {
  it('is listed as unfinished and counts for nothing', async () => {
    const res = await app.inject({ method: 'POST', url: '/me/factors/passkey', headers: H, payload: JSON.stringify({ label: 'yubikey' }) })
    const { factorId } = res.json() as { factorId: string }

    const list = await listFactors(db, 'dev-user')
    const mine = list.find((f) => f.id === factorId)
    expect(mine?.kind, 'the header knows what kind it is').toBe('passkey')
    expect(mine?.label).toBe('yubikey')
    expect(mine?.confirmedAt, 'nothing has been proved yet').toBeNull()
  }, 120_000)

  it('a new start clears the abandoned one', async () => {
    await app.inject({ method: 'POST', url: '/me/factors/passkey', headers: H, payload: '{}' })
    await app.inject({ method: 'POST', url: '/me/factors/passkey', headers: H, payload: '{}' })
    const [row] = await adminPool<{ n: number }[]>`
      SELECT count(*)::int AS n FROM member_factors
      WHERE tenant_id = ${TENANT} AND member_sub = 'dev-user' AND confirmed_at IS NULL`
    expect(row!.n, '#653①: abandoned starts do not pile up').toBe(1)
  }, 120_000)
})

describe('#663: passkeys and TOTP share one list', () => {
  it('both kinds come back together, which is what #656 split the tables for', async () => {
    const totp = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user', secret: generateTotpSecret(), label: 'phone' })
    await confirmFactor(db, totp.factorId)
    const pk = await startPasskeyEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user', label: 'yubikey' })
    await storePasskey(db, {
      tenantId: TENANT, factorId: pk.factorId,
      passkey: { credentialId: 'cred-663', publicKey: 'pk', signCount: 0, transports: ['usb'], rpId: 'dev.localhost' },
    })
    await confirmFactor(db, pk.factorId)

    const list = await listFactors(db, 'dev-user')
    expect(list.map((f) => f.kind).sort(), 'one list, two kinds').toEqual(['passkey', 'totp'])
    expect(list.map((f) => f.label).sort()).toEqual(['phone', 'yubikey'])
  }, 120_000)

  it('the same credential id cannot be registered twice in a tenant', async () => {
    // Two rows answering one assertion, the second with a counter that starts behind the first's.
    const a = await startPasskeyEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user' })
    const b = await startPasskeyEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user' })
    const passkey = { credentialId: 'dup-663', publicKey: 'pk', signCount: 0, transports: [], rpId: 'dev.localhost' }
    await storePasskey(db, { tenantId: TENANT, factorId: a.factorId, passkey })
    await expect(storePasskey(db, { tenantId: TENANT, factorId: b.factorId, passkey })).rejects.toThrow()
  }, 120_000)

  it('the options exclude what the member already holds', async () => {
    // Without this an authenticator the member has used before makes a SECOND credential without
    // saying so, and nothing downstream can tell the two apart.
    const pk = await startPasskeyEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user' })
    await storePasskey(db, {
      tenantId: TENANT, factorId: pk.factorId,
      passkey: { credentialId: 'held-663', publicKey: 'pk', signCount: 0, transports: ['usb'], rpId: 'dev.localhost' },
    })
    await confirmFactor(db, pk.factorId)

    const res = await app.inject({ method: 'POST', url: '/me/factors/passkey', headers: H, payload: '{}' })
    const { options } = res.json() as { options: { excludeCredentials?: { id: string }[] } }
    expect((options.excludeCredentials ?? []).map((c) => c.id), 'the one already held').toContain('held-663')
  }, 120_000)
})

describe('#663: what a domain move would strand (#664 needs a number)', () => {
  it('counts members whose passkeys were made under another RP ID', async () => {
    const pk = await startPasskeyEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user' })
    await storePasskey(db, {
      tenantId: TENANT, factorId: pk.factorId,
      passkey: { credentialId: 'move-663', publicKey: 'pk', signCount: 0, transports: [], rpId: 'dev.localhost' },
    })
    await confirmFactor(db, pk.factorId)

    expect(await passkeysStrandedBy(db, 'wiki.acme.com'), 'moving elsewhere strands them').toBe(1)
    expect(await passkeysStrandedBy(db, 'dev.localhost'), 'staying put strands nobody').toBe(0)
  }, 120_000)

  it('an unconfirmed passkey is nobody\'s loss', async () => {
    const pk = await startPasskeyEnrolment(db, { tenantId: TENANT, memberSub: 'dev-user' })
    await storePasskey(db, {
      tenantId: TENANT, factorId: pk.factorId,
      passkey: { credentialId: 'pending-663', publicKey: 'pk', signCount: 0, transports: [], rpId: 'dev.localhost' },
    })
    expect(await passkeysStrandedBy(db, 'wiki.acme.com'), 'it was never usable').toBe(0)
  }, 120_000)
})
