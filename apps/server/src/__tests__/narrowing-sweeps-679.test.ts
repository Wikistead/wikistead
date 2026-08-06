// #679 / ADR-222 §4: NARROWING the stance signs out the people the narrowed stance refuses — not just
// the people who hold nothing.
//
// `any → passkey` is the case. Somebody with an authenticator app and no key satisfied the old stance
// and does not satisfy the new one, so the door will refuse them from now on. Their session was opened
// under the old rule and, left alone, keeps working: a policy that starts tomorrow, which ADR-219 §2
// rejected in the on/off axis and which comes straight back on the kinds axis.
//
// Measured because it was not. The write path takes the sweep set from `membersUnsatisfiedBy(stance)`;
// replacing that argument with the old question (`'any'` — holds anything at all) left thirty-two
// server assertions and four browser ones green. The behaviour was right and nothing was watching it,
// which is the same shape as #666's suite staying green with its bug reinstated.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import { storePasskey } from '../auth/passkeys.js'
import { startPasskeyEnrolment, startTotpEnrolment, confirmFactor } from '../auth/second-factors.js'
import { generateTotpSecret } from '../auth/totp.js'
import { membersUnsatisfiedBy } from '../auth/factor-policy.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const STAMP = Date.now().toString(36)
const HOST = 'dev.localhost'
const ELSEWHERE = 'moved.example' // where the tenant used to live, before a #664 domain move

let db: TenantDb
const subs: string[] = []

async function member(name: string, kind: 'passkey' | 'totp' | 'none', rpId = HOST): Promise<string> {
  const sub = `sw679-${name}-${STAMP}`
  subs.push(sub)
  await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${T}, ${sub}, ${`${sub}@e2e.test`}, 'member')
              ON CONFLICT (tenant_id, sub) DO NOTHING`
  if (kind === 'none') return sub
  if (kind === 'passkey') {
    const { factorId } = await startPasskeyEnrolment(db, { tenantId: T, memberSub: sub, label: name })
    await storePasskey(db, { tenantId: T, factorId,
      passkey: { credentialId: `sw-${name}-${STAMP}`, publicKey: 'pk', signCount: 0, transports: [], rpId } })
    await confirmFactor(db, factorId)
    return sub
  }
  const { factorId } = await startTotpEnrolment(db, { tenantId: T, memberSub: sub, secret: generateTotpSecret(), label: name })
  await confirmFactor(db, factorId)
  return sub
}

beforeAll(async () => {
  db = await acquireTenantDb({ id: T, slug: T, plan: 'business', isolation: 'logical' } as Tenant)
}, 180_000)

afterAll(async () => {
  for (const s of subs) {
    await admin`DELETE FROM member_factors WHERE member_sub = ${s}`.catch(() => {})
    await admin`DELETE FROM members WHERE tenant_id = ${T} AND sub = ${s}`.catch(() => {})
  }
  await db.release(); await admin.end(); await pool.end()
}, 180_000)

describe('#679: narrowing sweeps the people the NEW stance refuses', () => {
  it('a TOTP holder is swept by `passkey`, and not by `any`', async () => {
    // THE case. Under `any` they are satisfied and must be left alone — the control is what makes the
    // first half a finding rather than "this function returns everybody".
    const coded = await member('coded', 'totp')
    const keyed = await member('keyed', 'passkey')

    const byPasskey = await membersUnsatisfiedBy(db, 'passkey', HOST)
    expect(byPasskey, 'an authenticator app satisfies a passkey-only stance').toContain(coded)
    expect(byPasskey, 'a key holder was swept by the stance their key satisfies').not.toContain(keyed)

    const byAny = await membersUnsatisfiedBy(db, 'any', HOST)
    expect(byAny, 'the old question would have left them alone — and it must').not.toContain(coded)
    expect(byAny, '…and the key holder too').not.toContain(keyed)
  }, 180_000)

  it('…and the mirror: a key holder is swept by `totp`', async () => {
    // Both directions, because a sweep written for one narrowing is easy to write as "not a passkey".
    const keyed = await member('keyed2', 'passkey')
    const coded = await member('coded2', 'totp')
    const byTotp = await membersUnsatisfiedBy(db, 'totp', HOST)
    expect(byTotp, 'a key does not satisfy an authenticator-app stance').toContain(keyed)
    expect(byTotp, 'an authenticator app does').not.toContain(coded)
  }, 180_000)

  it('a key made on the OLD host is swept, because no door will take it', async () => {
    // #675's host half, on this path. After a domain move the row is still there and cannot answer at
    // any door, so its holder is exactly who the sweep is for — and a sweep that counted rows would
    // leave them holding a session nothing will renew.
    const stranded = await member('stranded', 'passkey', ELSEWHERE)
    expect(await membersUnsatisfiedBy(db, 'passkey', HOST),
      'a key that cannot be presented here still satisfied the stance').toContain(stranded)
    // …and at the host it was made for, the same row satisfies it. The control that says the case above
    // is about the HOST rather than about that member being broken.
    expect(await membersUnsatisfiedBy(db, 'passkey', ELSEWHERE),
      'the same key, at its own host, does not need sweeping').not.toContain(stranded)
  }, 180_000)

  it('`off` sweeps nobody at all', async () => {
    // ADR-222 §1: `off` is not the empty set of kinds, it is the absence of a demand. A sweep reading it
    // as "accepts nothing" would sign out the entire tenant the moment somebody turned the requirement
    // off — the opposite of what that switch means.
    await member('nothing', 'none')
    expect(await membersUnsatisfiedBy(db, 'off', HOST)).toEqual([])
  }, 180_000)

  it('somebody holding nothing is swept by every stance that asks for something', async () => {
    // The case the old question DID cover, kept: narrowing must not have traded one population for
    // another.
    const bare = await member('bare', 'none')
    for (const stance of ['any', 'passkey', 'totp'] as const) {
      expect(await membersUnsatisfiedBy(db, stance, HOST), `${stance} left somebody with nothing signed in`)
        .toContain(bare)
    }
  }, 180_000)
})
