// #665 / ADR-219 §1: signing in with a passkey.
//
// WHAT IS NOT HERE, and why: a full assertion round trip. Producing a valid one means signing with a
// private key the browser holds, i.e. re-deriving the verification `@simplewebauthn/server` exists to
// do — the thing ADR-219 §9 ruled against. So the crypto is the library's, and everything the PRODUCT
// decides around it is measured here: who the challenge belongs to, which credentials are offered,
// what happens when there is no receipt, and the sign-counter rule, which is lifted into its own
// function precisely so it can be tested without forging a signature.
//
// The gap is stated on #665 rather than hidden: a virtual-authenticator e2e (Playwright's CDP
// WebAuthn) is what would close it.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import { counterAcceptable, takeAuthChallenge, storePasskey } from '../auth/passkeys.js'
import { startPasskeyEnrolment, confirmFactor } from '../auth/second-factors.js'
import { hashPassword } from '../auth/password-hash.js'
import { FACTOR_COOKIE } from '../auth/factor-session.js'
import { ensureMembers } from './helpers/membership.js'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const WEB = { host: 'dev.localhost', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }
const PASSWORD = 'correct horse battery staple 665'

/** What `local_login_enabled` was before this file touched it, so afterAll can put it back. */
let priorLocalLogin = false
let app: FastifyInstance
let db: TenantDb
const subs: string[] = []

async function localMember(name: string): Promise<{ sub: string; email: string }> {
  const sub = `wlocal_e665-${name}-${STAMP}`
  const email = `e665-${name}-${STAMP}@e2e.test`
  subs.push(sub)
  await adminPool`
    INSERT INTO members (tenant_id, sub, email, role) VALUES (${TENANT}, ${sub}, ${email}, 'member')
    ON CONFLICT (tenant_id, sub) DO NOTHING`
  await adminPool`
    INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
    VALUES (${TENANT}, ${sub}, ${email}, ${await hashPassword(PASSWORD)})
    ON CONFLICT (tenant_id, member_sub) DO UPDATE SET password_hash = EXCLUDED.password_hash`
  await ensureMembers(TENANT, [sub])
  return { sub, email }
}

/** A confirmed passkey for `sub`, made under `rpId`. */
async function givePasskey(sub: string, credentialId: string, rpId = 'dev.localhost'): Promise<void> {
  const { factorId } = await startPasskeyEnrolment(db, { tenantId: TENANT, memberSub: sub })
  await storePasskey(db, {
    tenantId: TENANT, factorId,
    passkey: { credentialId, publicKey: 'pk', signCount: 0, transports: ['internal'], rpId },
  })
  await confirmFactor(db, factorId)
}

const setStance = (on: boolean) =>
  adminPool`
    INSERT INTO tenant_login_prefs (tenant_id, second_factor_required, local_login_enabled)
    VALUES (${TENANT}, ${on}, TRUE)
    ON CONFLICT (tenant_id) DO UPDATE SET second_factor_required = ${on}, local_login_enabled = TRUE`

const cookie = (res: { cookies: { name: string; value: string }[] }, name: string) =>
  res.cookies.find((c) => c.name === name)?.value

const signIn = (identifier: string) =>
  app.inject({ method: 'POST', url: '/auth/local/login', headers: WEB, payload: JSON.stringify({ identifier, password: PASSWORD }) })

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  const [pref] = await adminPool<{ local_login_enabled: boolean }[]>`
    SELECT local_login_enabled FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`
  priorLocalLogin = pref?.local_login_enabled === true
}, 180_000)

beforeEach(async () => {
  await setStance(false)
  // …the limiter keys this file trips, and only those. `flushdb` takes every other suite's sessions
  // and counters with it — the Valkey is shared across the run.
  for (const sub of subs) await app.valkey.del(`authlocal:id:${sub}`).catch(() => {})
  await app.valkey.del('authlocal:ip:127.0.0.1').catch(() => {})
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

describe('#665: the sign counter', () => {
  it('refuses a counter that went BACKWARDS, and accepts one that stood still', () => {
    // Backwards is the signal the spec exists to give: two devices answering for one credential.
    expect(counterAcceptable(5, 4), 'a clone').toBe(false)
    expect(counterAcceptable(5, 6), 'a normal increment').toBe(true)
    // Standing still is NOT an anomaly. Most platform authenticators report 0 forever, and refusing
    // "did not increase" would shut out every phone in circulation.
    expect(counterAcceptable(0, 0), 'a phone that never counts').toBe(true)
    expect(counterAcceptable(5, 5), 'the same value twice').toBe(true)
  })
})

describe('#665: the options a receipt is given', () => {
  it('name only the credentials made for THIS host, and bank a challenge against the receipt', async () => {
    // A credential from the old host after a domain move cannot answer here; offering it produces a
    // prompt that can only fail (ADR-219 §1 / #664).
    const m = await localMember('opts')
    await givePasskey(m.sub, `here-${STAMP}`, 'dev.localhost')
    await givePasskey(m.sub, `elsewhere-${STAMP}`, 'wiki.acme.com')
    await setStance(true)
    const fsid = cookie(await signIn(m.email), FACTOR_COOKIE)!

    const res = await app.inject({
      method: 'POST', url: '/auth/local/factor/passkey/options',
      headers: { ...WEB, cookie: `${FACTOR_COOKIE}=${fsid}` }, payload: '{}',
    })
    expect(res.statusCode, res.body).toBe(200)
    const { options } = res.json() as { options: { allowCredentials: { id: string }[]; challenge: string } }
    expect(options.allowCredentials.map((c) => c.id)).toEqual([`here-${STAMP}`])

    // one-shot, and keyed by the RECEIPT: there is no session yet, so nothing else can say whose it is
    expect(await takeAuthChallenge(app.valkey, fsid), 'banked against this receipt').toBe(options.challenge)
    expect(await takeAuthChallenge(app.valkey, fsid), 'and it does not come twice').toBeNull()
  }, 120_000)

  it('refuses without a receipt', async () => {
    await setStance(true)
    const res = await app.inject({ method: 'POST', url: '/auth/local/factor/passkey/options', headers: WEB, payload: '{}' })
    expect(res.statusCode).toBe(401)
    expect(res.json<{ code: string }>().code).toBe('factor_session_expired')
  }, 120_000)
})

describe('#665: presenting one at the factor door', () => {
  it('refuses an assertion with no live challenge', async () => {
    const m = await localMember('nochal')
    await givePasskey(m.sub, `nochal-${STAMP}`)
    await setStance(true)
    const fsid = cookie(await signIn(m.email), FACTOR_COOKIE)!

    const res = await app.inject({
      method: 'POST', url: '/auth/local/factor', headers: { ...WEB, cookie: `${FACTOR_COOKIE}=${fsid}` },
      payload: JSON.stringify({ passkey: { id: `nochal-${STAMP}`, rawId: 'x', type: 'public-key', response: {}, clientExtensionResults: {} } }),
    })
    expect(res.statusCode, res.body).toBe(401)
    expect(res.json<{ code: string }>().code).toBe('passkey_invalid')
  }, 120_000)

  it('refuses a credential this member does not hold, the same way', async () => {
    // Not a different error: which ids exist is a fact about somebody else's account.
    const m = await localMember('notmine')
    await givePasskey(m.sub, `mine-${STAMP}`)
    await setStance(true)
    const fsid = cookie(await signIn(m.email), FACTOR_COOKIE)!
    await app.inject({
      method: 'POST', url: '/auth/local/factor/passkey/options',
      headers: { ...WEB, cookie: `${FACTOR_COOKIE}=${fsid}` }, payload: '{}',
    })

    const res = await app.inject({
      method: 'POST', url: '/auth/local/factor', headers: { ...WEB, cookie: `${FACTOR_COOKIE}=${fsid}` },
      payload: JSON.stringify({ passkey: { id: 'somebody-elses', rawId: 'x', type: 'public-key', response: {}, clientExtensionResults: {} } }),
    })
    expect(res.statusCode).toBe(401)
    expect(res.json<{ code: string }>().code).toBe('passkey_invalid')
  }, 120_000)

  it('a member holding ONLY a passkey is still asked for a factor, not let through', async () => {
    // The policy must not read "no TOTP" as "nothing to ask": before #665 the door looked for codes
    // only, so somebody with a passkey and no TOTP would have been stuck at a code box for ever.
    const m = await localMember('onlykey')
    await givePasskey(m.sub, `onlykey-${STAMP}`)
    await setStance(true)
    const res = await signIn(m.email)
    expect(res.json<{ factor: string }>().factor, 'they HAVE a factor, so they are asked to present it')
      .toBe('required')
  }, 120_000)
})
