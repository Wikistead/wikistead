// #650 / ADR-226 rev2 — recovery codes, and the predicate that must never come back.
//
// The owner rejected rev1 for making the codes depend on the workspace's size ("member count == 1"),
// and the acceptance list they wrote starts with the proof that the predicate is gone rather than with
// the happy path. That ordering is deliberate and is kept here: a set that quietly stops working when
// a colleague joins, or when somebody is demoted, is a set nobody can rely on — and the failure would
// be invisible until the day somebody actually needed it.
//
// The rest is the security shape: one use per code, a use revokes the rest, re-minting kills the old
// set, and the door is not an oracle — a wrong code, no set, a revoked set and the switch being off
// are byte-identical.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/tenant-db.js'
import {
  mintRecoveryCodes, spendRecoveryCode, recoveryCodesUsable, recoverySetStatus,
  normalizeCode, RECOVERY_CODE_COUNT,
} from '../auth/recovery-codes.js'
import { privateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const USER = 'dev-user'
const OTHER = 'rec650-colleague'

let db: TenantDb
let TENANT: string
let dispose: () => Promise<void>

beforeAll(async () => {
  const t = await privateTenant(admin, 'rec650')
  TENANT = t.id
  dispose = t.dispose
  db = await acquireTenantDb({ id: TENANT, slug: t.slug, plan: 'free', isolation: 'logical' } as never)
}, 120_000)

afterAll(async () => {
  await admin`DELETE FROM member_recovery_codes WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db?.release()
  await dispose?.()
  await admin.end()
  await pool.end()
})

beforeEach(async () => {
  await admin`DELETE FROM member_recovery_codes WHERE tenant_id = ${TENANT}`
  await admin`DELETE FROM member_factors WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${TENANT} AND sub <> 'dev-user'`
})

/** Put `n` extra members in the tenant, so the tenant's SIZE changes under the codes. */
async function seedColleagues(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await admin`
      INSERT INTO members (tenant_id, sub, email, role)
      VALUES (${TENANT}, ${`${OTHER}-${i}`}, ${`c${i}@rec650.test`}, 'member')
      ON CONFLICT (tenant_id, sub) DO NOTHING`
  }
}

describe('#650the workspace\'s shape never decides whether codes work', () => {
  it('stays usable through one member, five members, and back to one', async () => {
    const codes = await mintRecoveryCodes(db, { tenantId: TENANT, memberSub: USER })
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT)
    expect(await recoveryCodesUsable(db, USER), 'alone in the workspace').toBe(true)

    await seedColleagues(4)
    expect(await recoveryCodesUsable(db, USER), 'a colleague joining does not take the codes away').toBe(true)

    // …and the code itself still opens the door, which is the half a boolean cannot prove.
    await admin`DELETE FROM members WHERE tenant_id = ${TENANT} AND sub <> 'dev-user'`
    expect(await recoveryCodesUsable(db, USER), 'and back to one, unchanged').toBe(true)
    const spent = await spendRecoveryCode(db, { memberSub: USER, code: codes[0]! })
    expect(spent.ok, 'the code works regardless of how many people are in the workspace').toBe(true)
  }, 300_000)

  it('does not change when the member is demoted from admin', async () => {
    await mintRecoveryCodes(db, { tenantId: TENANT, memberSub: USER })
    expect(await recoveryCodesUsable(db, USER), 'as an admin').toBe(true)
    await admin`UPDATE members SET role = 'member' WHERE tenant_id = ${TENANT} AND sub = ${USER}`
    try {
      expect(await recoveryCodesUsable(db, USER), 'losing your role does not lose your way back in').toBe(true)
    } finally {
      await admin`UPDATE members SET role = 'admin' WHERE tenant_id = ${TENANT} AND sub = ${USER}`
    }
  }, 300_000)
})

describe('#650: one use, and the rest of the set goes with it', () => {
  it('spends a code once, revokes its siblings, and wipes the factors', async () => {
    const codes = await mintRecoveryCodes(db, { tenantId: TENANT, memberSub: USER })
    await admin`
      INSERT INTO member_factors (tenant_id, member_sub, kind, label, confirmed_at)
      VALUES (${TENANT}, ${USER}, 'totp', 'phone', now())`

    const first = await spendRecoveryCode(db, { memberSub: USER, code: codes[0]! })
    expect(first.ok).toBe(true)
    expect(first.ok && first.factorsRemoved, 'using a code resets the factors — it is not a sign-in shortcut').toBe(1)

    // The same code again, and every sibling: all refused, because the point of using one is that the
    // authenticator is gone and nine live codes left lying about is a credential nobody tracks.
    expect((await spendRecoveryCode(db, { memberSub: USER, code: codes[0]! })).ok, 'a code is spent once').toBe(false)
    for (const sibling of codes.slice(1, 4)) {
      expect((await spendRecoveryCode(db, { memberSub: USER, code: sibling })).ok, 'siblings die with it').toBe(false)
    }
    expect(await recoveryCodesUsable(db, USER), 'the set is gone').toBe(false)
    expect((await recoverySetStatus(db, USER)).remaining).toBe(0)
  }, 300_000)

  it('re-minting invalidates every code of the previous set', async () => {
    const old = await mintRecoveryCodes(db, { tenantId: TENANT, memberSub: USER })
    const fresh = await mintRecoveryCodes(db, { tenantId: TENANT, memberSub: USER })
    expect((await recoverySetStatus(db, USER)).remaining, 'exactly one live set').toBe(RECOVERY_CODE_COUNT)
    for (const code of old.slice(0, 3)) {
      expect((await spendRecoveryCode(db, { memberSub: USER, code })).ok, 'a printout you replaced is worthless').toBe(false)
    }
    expect((await spendRecoveryCode(db, { memberSub: USER, code: fresh[0]! })).ok).toBe(true)
  }, 300_000)
})

describe('#650 §4: the door is not an oracle', () => {
  it('refuses another member\'s code, and does not spend it either', async () => {
    await seedColleagues(1)
    const theirs = await mintRecoveryCodes(db, { tenantId: TENANT, memberSub: `${OTHER}-0` })
    // A code is a credential for ONE account. Matching by hash alone would let it open whichever
    // account minted it — the caller here has proved the password for a DIFFERENT member.
    const stolen = await spendRecoveryCode(db, { memberSub: USER, code: theirs[0]! })
    expect(stolen.ok, 'a code cannot be redeemed against somebody else\'s account').toBe(false)
    expect(await recoveryCodesUsable(db, `${OTHER}-0`), 'and the attempt did not burn their code either').toBe(true)
  }, 300_000)

  it('answers a wrong code, an absent set and a revoked set identically', async () => {
    const none = await spendRecoveryCode(db, { memberSub: USER, code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' })
    const codes = await mintRecoveryCodes(db, { tenantId: TENANT, memberSub: USER })
    const wrong = await spendRecoveryCode(db, { memberSub: USER, code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' })
    await spendRecoveryCode(db, { memberSub: USER, code: codes[0]! }) // revokes the rest
    const revoked = await spendRecoveryCode(db, { memberSub: USER, code: codes[1]! })
    // Same shape, same fields: nothing distinguishes "you guessed wrong" from "there is nothing here".
    expect([none, wrong, revoked]).toEqual([{ ok: false }, { ok: false }, { ok: false }])
  }, 300_000)

  it('the deployment switch refuses without consuming anything', async () => {
    const codes = await mintRecoveryCodes(db, { tenantId: TENANT, memberSub: USER })
    process.env.SECOND_FACTOR_RECOVERY = 'off'
    try {
      expect((await spendRecoveryCode(db, { memberSub: USER, code: codes[0]! })).ok, 'off means off').toBe(false)
      expect(await recoveryCodesUsable(db, USER), 'and the predicate agrees').toBe(false)
    } finally {
      delete process.env.SECOND_FACTOR_RECOVERY
    }
    // ⚠️ …and the refused attempt must not have SPENT the code: an operator turning the switch back on
    // would otherwise find the member's set quietly eaten by attempts that were never honoured.
    expect(await recoveryCodesUsable(db, USER), 'the switch back on finds the set intact').toBe(true)
    expect((await spendRecoveryCode(db, { memberSub: USER, code: codes[0]! })).ok).toBe(true)
  }, 300_000)
})

describe('#650 §3: the code itself', () => {
  it('is 80 bits, grouped for a human, and read back case- and dash-insensitively', async () => {
    const codes = await mintRecoveryCodes(db, { tenantId: TENANT, memberSub: USER })
    expect(new Set(codes).size, 'ten distinct codes').toBe(RECOVERY_CODE_COUNT)
    for (const c of codes) {
      expect(c, 'four groups of four').toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/)
      // No I, L, O or U: these are typed by somebody who has just lost their phone.
      expect(c).not.toMatch(/[ILOU]/)
    }
    expect(normalizeCode(' abcd-efgh ijkl-mnpq ')).toBe('ABCDEFGHIJKLMNPQ')
    const messy = codes[0]!.toLowerCase().replace(/-/g, ' ')
    expect((await spendRecoveryCode(db, { memberSub: USER, code: messy })).ok, 'typed loosely, still accepted').toBe(true)
  }, 300_000)
})
