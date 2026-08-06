// #656 / ADR-219 §7: where a second factor is kept.
//
// The interesting assertions are not the round-trips. A store that never calls `encryptSecret` at all
// round-trips perfectly — write the secret, read it back, identical — and the only thing that catches
// it is looking at the column with a connection that does not go through this module. So the test that
// matters here reads the raw row and asserts the plaintext is NOT in it.
//
// Likewise "an unconfirmed factor is not a factor": the row exists, `listFactors` and
// `hasConfirmedFactor` must both refuse to see it, and a test that only ever confirms would never know.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import {
  startTotpEnrolment, totpSecretFor, confirmFactor, listFactors, hasConfirmedFactor,
  spendTotpCounter, markFactorUsed, deleteFactor, deleteAllFactors,
} from '../auth/second-factors.js'
import { generateTotpSecret } from '../auth/totp.js'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const OTHER = 'tenant_acme'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)

let db: TenantDb
let other: TenantDb
const subs: string[] = []

/** A seated member, because a factor's FK will not let it belong to nobody. */
async function member(tenantId: string, name: string): Promise<string> {
  const sub = `f656-${name}-${STAMP}`
  subs.push(sub)
  await adminPool`
    INSERT INTO members (tenant_id, sub, email, role)
    VALUES (${tenantId}, ${sub}, ${`${sub}@e2e.test`}, 'member')
    ON CONFLICT DO NOTHING`
  return sub
}

beforeAll(async () => {
  db = await acquireTenantDb(asTenant(TENANT))
  other = await acquireTenantDb(asTenant(OTHER))
}, 120_000)

afterAll(async () => {
  // Factors cascade with the member, but the member row is this file's litter and outlives it —
  // and a stray seat is what pushed `tenant_dev` past its cap and reddened two unrelated files.
  for (const sub of subs) {
    await adminPool`DELETE FROM member_factors WHERE member_sub = ${sub}`.catch(() => {})
    await adminPool`DELETE FROM members WHERE sub = ${sub}`.catch(() => {})
  }
  await db.release(); await other.release(); await adminPool.end(); await pool.end()
}, 120_000)

describe('#656: the secret is encrypted at rest', () => {
  it('does not put the plaintext in the column', async () => {
    // Read with the ADMIN pool, not through the module: a store that forgot to encrypt would pass
    // every round-trip test in this file and fail only this one.
    const sub = await member(TENANT, 'enc')
    const secret = generateTotpSecret()
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: sub, secret })

    const [raw] = await adminPool<{ secret_enc: string }[]>`
      SELECT secret_enc FROM member_totp_secrets WHERE factor_id = ${factorId}`
    expect(raw, 'the row is there to look at').toBeTruthy()
    expect(raw!.secret_enc, 'the secret is not sitting in the column').not.toBe(secret)
    expect(raw!.secret_enc, 'nor is it a substring of whatever is').not.toContain(secret)
    // …and it is not merely encoded: base64 of the plaintext would also fail the two above
    expect(Buffer.from(raw!.secret_enc, 'base64').toString('utf8'), 'not just base64').not.toContain(secret)
  }, 120_000)

  it('and gives it back, because verification needs it', async () => {
    // The opposite of the password rule next door. Both are true and they are easy to swap.
    const sub = await member(TENANT, 'roundtrip')
    const secret = generateTotpSecret()
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: sub, secret })
    expect(await totpSecretFor(db, factorId)).toBe(secret)
  }, 120_000)

  it('two enrolments of the same secret do not produce the same ciphertext', async () => {
    // AES-GCM with a fresh IV each time. Identical ciphertext would say the IV is fixed, which turns
    // the column into an oracle for "these two people enrolled the same secret".
    const a = await member(TENANT, 'iv-a')
    const b = await member(TENANT, 'iv-b')
    const secret = generateTotpSecret()
    const one = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: a, secret })
    const two = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: b, secret })
    const rows = await adminPool<{ secret_enc: string }[]>`
      SELECT secret_enc FROM member_totp_secrets WHERE factor_id IN (${one.factorId}, ${two.factorId})`
    expect(rows.length).toBe(2)
    expect(rows[0]!.secret_enc).not.toBe(rows[1]!.secret_enc)
  }, 120_000)

  it('missing factor answers null rather than throwing', async () => {
    expect(await totpSecretFor(db, '00000000-0000-0000-0000-000000000000')).toBeNull()
  }, 120_000)
})

describe('#656: an unconfirmed enrolment is not a factor', () => {
  it('is listed as unfinished, and counts for nothing a policy asks', async () => {
    // REWRITTEN by #653's review. This asserted the row was INVISIBLE, which was half of a trap:
    // the enrolment cap counts pending rows, so hiding them produced "you can create it, you cannot see
    // it, and because you cannot see it you cannot delete it" — three closed tabs and the account could
    // never enrol again. The property worth keeping is the one about POLICY, not about visibility.
    const sub = await member(TENANT, 'pending')
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: sub, secret: generateTotpSecret() })

    const listed = await listFactors(db, sub)
    expect(listed.map((f) => f.id), 'visible, so it can be cleared').toEqual([factorId])
    expect(listed[0]!.confirmedAt, '…and marked as unfinished').toBeNull()
    expect(await hasConfirmedFactor(db, sub), 'and nothing a policy may count').toBe(false)
  }, 120_000)

  it('…and becomes one once confirmed', async () => {
    const sub = await member(TENANT, 'confirmed')
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: sub, secret: generateTotpSecret(), label: 'work phone' })

    expect(await confirmFactor(db, factorId)).toBe(true)
    expect(await hasConfirmedFactor(db, sub)).toBe(true)
    const list = await listFactors(db, sub)
    expect(list.length).toBe(1)
    expect(list[0]!.kind).toBe('totp')
    expect(list[0]!.label, 'the name the member gave it').toBe('work phone')
    expect(list[0]!.confirmedAt).toBeTruthy()
  }, 120_000)

  it('confirming twice is refused, so the ledger keeps its first answer', async () => {
    // "When did this account get its factor" has one answer, and a second confirm would move it.
    const sub = await member(TENANT, 'twice')
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: sub, secret: generateTotpSecret() })
    expect(await confirmFactor(db, factorId)).toBe(true)
    const [first] = await adminPool<{ confirmed_at: Date }[]>`
      SELECT confirmed_at FROM member_factors WHERE id = ${factorId}`

    expect(await confirmFactor(db, factorId), 'the second one has nothing to do').toBe(false)
    const [again] = await adminPool<{ confirmed_at: Date }[]>`
      SELECT confirmed_at FROM member_factors WHERE id = ${factorId}`
    expect(again!.confirmed_at.getTime()).toBe(first!.confirmed_at.getTime())
  }, 120_000)

  it('one person holds several — which is why this is not a column on local_credentials', async () => {
    const sub = await member(TENANT, 'several')
    for (const label of ['phone', 'yubikey', 'laptop']) {
      const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: sub, secret: generateTotpSecret(), label })
      await confirmFactor(db, factorId)
    }
    expect((await listFactors(db, sub)).map((f) => f.label)).toEqual(['phone', 'yubikey', 'laptop'])
  }, 120_000)
})

describe('#656: spending a counter refuses a replay', () => {
  it('the same step cannot be spent twice, and an older one cannot be spent after a newer', async () => {
    // The comparison and the write are one statement precisely so this holds under a race; the test
    // can only show the sequential half, which is why the SQL says what it says.
    const sub = await member(TENANT, 'replay')
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: sub, secret: generateTotpSecret() })

    expect(await spendTotpCounter(db, factorId, 100), 'the first use').toBe(true)
    expect(await spendTotpCounter(db, factorId, 100), 'the same code again').toBe(false)
    expect(await spendTotpCounter(db, factorId, 99), 'a code from the step before').toBe(false)
    expect(await spendTotpCounter(db, factorId, 101), 'the next step').toBe(true)
  }, 120_000)

  it('records use without gating on it', async () => {
    const sub = await member(TENANT, 'used')
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: sub, secret: generateTotpSecret() })
    await confirmFactor(db, factorId)
    expect((await listFactors(db, sub))[0]!.lastUsedAt, 'nothing yet').toBeNull()
    await markFactorUsed(db, factorId)
    expect((await listFactors(db, sub))[0]!.lastUsedAt).toBeTruthy()
  }, 120_000)
})

describe('#656: removal', () => {
  it('takes the secret with it', async () => {
    const sub = await member(TENANT, 'remove')
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: sub, secret: generateTotpSecret() })
    expect(await deleteFactor(db, sub, factorId)).toBe(true)

    const detail = await adminPool`SELECT 1 FROM member_totp_secrets WHERE factor_id = ${factorId}`
    expect(detail.length, 'the detail row cascaded').toBe(0)
  }, 120_000)

  it('will not remove somebody else\'s by id', async () => {
    // An id is a bearer token for a row without this. The member's own "remove" must be their own.
    const mine = await member(TENANT, 'mine')
    const theirs = await member(TENANT, 'theirs')
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: theirs, secret: generateTotpSecret() })

    expect(await deleteFactor(db, mine, factorId), 'guessing an id is not enough').toBe(false)
    expect(await adminPool`SELECT 1 FROM member_factors WHERE id = ${factorId}`).toHaveLength(1)
  }, 120_000)

  it('removes all of them at once, which is what a reset and a deletion both do', async () => {
    const sub = await member(TENANT, 'all')
    for (let i = 0; i < 3; i++) {
      await startTotpEnrolment(db, { tenantId: TENANT, memberSub: sub, secret: generateTotpSecret() })
    }
    expect(await deleteAllFactors(db, sub)).toBe(3)
    expect(await hasConfirmedFactor(db, sub)).toBe(false)
  }, 120_000)
})

describe('#656: tenant isolation', () => {
  it('another tenant cannot see or delete a factor', async () => {
    const sub = await member(TENANT, 'iso')
    const { factorId } = await startTotpEnrolment(db, { tenantId: TENANT, memberSub: sub, secret: generateTotpSecret() })
    await confirmFactor(db, factorId)

    // The same sub, asked through the other tenant's connection. RLS is what answers, not a WHERE the
    // caller remembered to write — which is why the query is by sub and not by tenant.
    expect(await listFactors(other, sub), 'not visible from tenant_acme').toEqual([])
    expect(await hasConfirmedFactor(other, sub)).toBe(false)
    expect(await totpSecretFor(other, factorId), 'nor is the secret').toBeNull()
    expect(await deleteFactor(other, sub, factorId), 'nor can it be deleted').toBe(false)

    expect(await hasConfirmedFactor(db, sub), 'and it is still there for its own tenant').toBe(true)
  }, 120_000)
})
