// #687: at the `required` stage, `kinds` is what THIS member can present — not the tenant's stance.
//
// The screen has no other source. A receipt holder has no session, so `/me/factors` is closed to them
// (the login response says so in its own comment); whatever this field carries is exactly what the door
// can draw. Sending the stance made the screen offer an authenticator app to somebody whose only factor
// was a security key — the lock-out a real YubiKey walked into.
//
// The two stages want different sets and that is the whole fix:
//   required           → `usable` — an instruction the member can actually follow.
//   enrolment-required → the stance — they hold nothing, so the question is what they may install.
//
// ⚠️ Both directions, and the mixed case. A build that swapped the stance for the member's kinds
// EVERYWHERE would pass a one-sided pin and then send an un-enrolled member to install nothing at all.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { startPasskeyEnrolment, startTotpEnrolment, confirmFactor } from '../auth/second-factors.js'
import { storePasskey } from '../auth/passkeys.js'
import { generateTotpSecret } from '../auth/totp.js'
import { hashPassword } from '../auth/password-hash.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const STAMP = Date.now().toString(36)
const HOST = 'dev.localhost'
const PASSWORD = 'a password for the 687 door'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const H = { host: HOST, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }

let app: FastifyInstance
let db: TenantDb
let priorLocalLogin = false
const emails: string[] = []

const setStance = (kinds: string) => admin`
  INSERT INTO tenant_login_prefs (tenant_id, second_factor_required, second_factor_kinds, local_login_enabled)
  VALUES (${T}, ${kinds !== 'off'}, ${kinds}, TRUE)
  ON CONFLICT (tenant_id) DO UPDATE
    SET second_factor_required = ${kinds !== 'off'}, second_factor_kinds = ${kinds}, local_login_enabled = TRUE`

/** A member with a password, made the way `/auth/local/accept` makes one (FGA membership included). */
async function memberWithPassword(name: string): Promise<{ sub: string; email: string }> {
  const sub = `wlocal_p687-${name}-${STAMP}`
  const email = `p687-${name}-${STAMP}@e2e.test`
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

// ⚠️ The credential id is unique per TENANT, and this file's members share one. Keying it on the
// label alone collided the moment a second member got a key (measured on the first run) — a fixture
// failure that reads like a product constraint. The member's sub is what makes it distinct.
let credentialSeq = 0
const givePasskey = async (sub: string, label: string) => {
  const { factorId } = await startPasskeyEnrolment(db, { tenantId: T, memberSub: sub, label })
  await storePasskey(db, {
    tenantId: T, factorId,
    passkey: {
      credentialId: `cred-687-${STAMP}-${credentialSeq++}`,
      publicKey: 'pk', signCount: 0, transports: ['usb'], rpId: HOST,
    },
  })
  await confirmFactor(db, factorId)
}

const giveTotp = async (sub: string) => {
  const { factorId } = await startTotpEnrolment(db, { tenantId: T, memberSub: sub, secret: generateTotpSecret() })
  await confirmFactor(db, factorId)
}

const signIn = (identifier: string) =>
  app.inject({ method: 'POST', url: '/auth/local/login', headers: H, payload: JSON.stringify({ identifier, password: PASSWORD }) })

type Challenge = { ok: false; factor: 'required' | 'enrolment-required'; kinds: string[] }

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(T))
  const [pref] = await admin<{ local_login_enabled: boolean }[]>`
    SELECT local_login_enabled FROM tenant_login_prefs WHERE tenant_id = ${T}`
  priorLocalLogin = pref?.local_login_enabled ?? false
}, 180_000)

beforeEach(async () => { await setStance('off') })

afterAll(async () => {
  await admin`
    UPDATE tenant_login_prefs SET second_factor_required = FALSE, second_factor_kinds = 'off',
      local_login_enabled = ${priorLocalLogin} WHERE tenant_id = ${T}`.catch(() => {})
  // The SEAT outlives everything else and pushes the tenant past its cap in later runs.
  for (const email of emails) {
    const mine = admin`SELECT sub FROM members WHERE tenant_id = ${T} AND email = ${email}`
    await admin`DELETE FROM member_passkeys WHERE factor_id IN (SELECT id FROM member_factors WHERE member_sub IN (${mine}))`.catch(() => {})
    await admin`DELETE FROM member_factors WHERE member_sub IN (${mine})`.catch(() => {})
    await admin`DELETE FROM local_credentials WHERE tenant_id = ${T} AND member_sub IN (${mine})`.catch(() => {})
    await admin`DELETE FROM members WHERE tenant_id = ${T} AND email = ${email}`.catch(() => {})
  }
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 180_000)

describe('#687: the required stage reports what the member can present', () => {
  it('a passkey-only member under `any` is not told about authenticator apps', async () => {
    // THE LOCK-OUT, as a field. Under `any` the stance says both, the member holds one, and the screen
    // drew the code box because the stance is what arrived.
    const { sub, email } = await memberWithPassword('pk-only')
    await givePasskey(sub, 'key')
    await setStance('any')

    const body = (await signIn(email)).json<Challenge>()
    expect(body.factor, 'a member holding a factor is asked to present it').toBe('required')
    expect(body.kinds, 'the door was told to offer a kind this member does not hold').toEqual(['passkey'])
  }, 180_000)

  it('a totp-only member under `any` is told about codes only (the mirror)', async () => {
    // Without this, "always answer ['passkey']" passes the case above — and the mirror-image tenant is
    // exactly where #686's one-sided pin went silent.
    const { sub, email } = await memberWithPassword('totp-only')
    await giveTotp(sub)
    await setStance('any')

    const body = (await signIn(email)).json<Challenge>()
    expect(body.factor).toBe('required')
    expect(body.kinds).toEqual(['totp'])
  }, 180_000)

  it('a member holding both is offered both', async () => {
    // The control for a build that answers with the FIRST usable kind: both cases above would pass.
    const { sub, email } = await memberWithPassword('both')
    await givePasskey(sub, 'key')
    await giveTotp(sub)
    await setStance('any')

    const body = (await signIn(email)).json<Challenge>()
    expect(body.factor).toBe('required')
    expect([...body.kinds].sort(), 'somebody holding two factors may choose').toEqual(['passkey', 'totp'])
  }, 180_000)

  it('the stance still narrows it: a totp holder under `passkey` is sent to ENROL, offered passkeys', async () => {
    // The other half of the field's job (#677's dead end + #686's enrolment prompt): what they may
    // install is the stance, because they hold nothing the tenant accepts. A build that swapped in the
    // member's own kinds everywhere would answer `['totp']` here — an instruction to install the very
    // thing the door refuses.
    const { sub, email } = await memberWithPassword('totp-under-pk')
    await giveTotp(sub)
    await setStance('passkey')

    const body = (await signIn(email)).json<Challenge>()
    expect(body.factor, 'holding an unaccepted kind is holding nothing, here').toBe('enrolment-required')
    expect(body.kinds, 'the enrolment prompt must name what the TENANT accepts').toEqual(['passkey'])
  }, 180_000)

  it('a member holding nothing is offered everything the stance accepts', async () => {
    const { email } = await memberWithPassword('nothing')
    await setStance('any')

    const body = (await signIn(email)).json<Challenge>()
    expect(body.factor).toBe('enrolment-required')
    expect([...body.kinds].sort(), 'the interstitial must offer the full stance').toEqual(['passkey', 'totp'])
  }, 180_000)
})
