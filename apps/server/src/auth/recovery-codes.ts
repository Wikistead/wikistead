// #650 / ADR-226 rev2 — second-factor recovery codes.
//
// WHAT THIS IS FOR: a member whose authenticator is gone gets back into their OWN account, without
// needing another human. The administrator reset (#644 §10a) covers "somebody else can help"; this
// covers the case where nobody can — which is not a property of the workspace's size, so nothing here
// counts members. The owner's ruling on rev1 was explicit about that: a set that stops working when a
// colleague joins is a set nobody can rely on, so the state is "holds a set" or "does not", and role
// changes never move it either.
//
// WHAT THIS IS NOT: a way past the second factor. Using a code WIPES the member's factors and ends
// every session — it is the self-service form of the administrator reset, not a sign-in shortcut. The
// difference matters: a door that let a code stand IN PLACE OF a factor would make the factor
// optional for anyone who ever saw a code.
import { randomBytes, createHash } from 'node:crypto'
import type { TenantDb } from '../db/index.js'

/** Codes per set. Ten is the industry's shape and the number the mint response promises. */
export const RECOVERY_CODE_COUNT = 10
/** 80 bits, so an offline guess is out of reach with no KDF at all (ADR-226 §3). */
const CODE_BYTES = 10
// Crockford base32 without the ambiguous glyphs: no I, L, O or U. These get read off a screen and
// typed by somebody who has just lost their phone, which is the worst possible moment to be deciding
// whether a character is a one or an ell.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * The deployment switch. ON by default, including self-hosted (owner's ruling): a default of off puts
 * every self-hoster one lost phone away from the lockout this feature exists to prevent. The switch
 * stays so an operator can deliberately refuse self-recovery.
 *
 * ⚠️ Read HERE and nowhere else (§4.1). A route that reads the env for itself is a second answer to
 * the same question, which is how the two drift apart.
 */
export function recoveryEnabled(): boolean {
  return (process.env.SECOND_FACTOR_RECOVERY ?? 'on').toLowerCase() !== 'off'
}

/** Normalise what a human typed: case, spaces and the grouping dashes are all noise. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '')
}

export function hashCode(normalized: string): Buffer {
  return createHash('sha256').update(normalized).digest()
}

/** `xxxx-xxxx-xxxx-xxxx` — grouped for reading, dashes stripped again on the way in. */
function formatCode(raw: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of raw) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return (out.slice(0, 16).match(/.{1,4}/g) ?? []).join('-')
}

/**
 * ONE predicate, in one place (§4.1): may this member use recovery codes right now?
 *
 * The mint route, the door and the settings surface all ask this. It reads the switch and the member's
 * own rows — and NOTHING about the tenant. The acceptance tests for this ticket exist to prove that a
 * member-count check has not crept back in.
 */
export async function recoveryCodesUsable(db: TenantDb, memberSub: string): Promise<boolean> {
  if (!recoveryEnabled()) return false
  const [row] = await db.sql<[{ live: string }]>`
    SELECT count(*)::text AS live FROM member_recovery_codes
    WHERE member_sub = ${memberSub} AND used_at IS NULL AND revoked_at IS NULL`
  return Number(row?.live ?? 0) > 0
}

export interface RecoverySetStatus {
  /** Codes still usable. Zero means "no live set" — the surface says that, never the codes. */
  remaining: number
  mintedAt: Date | null
}

/** What the settings screen may know: how many are left and when they were minted. Never a code. */
export async function recoverySetStatus(db: TenantDb, memberSub: string): Promise<RecoverySetStatus> {
  const [row] = await db.sql<[{ remaining: string; minted: Date | null }]>`
    SELECT count(*) FILTER (WHERE used_at IS NULL AND revoked_at IS NULL)::text AS remaining,
           max(created_at) FILTER (WHERE used_at IS NULL AND revoked_at IS NULL) AS minted
    FROM member_recovery_codes WHERE member_sub = ${memberSub}`
  return { remaining: Number(row?.remaining ?? 0), mintedAt: row?.minted ?? null }
}

/**
 * Mint a fresh set, revoking whatever the member had.
 *
 * There is never more than one live set (§4): re-minting is how somebody who thinks their printout
 * leaked makes it worthless, and that only works if the old codes stop the moment the new ones exist.
 * Returns the PLAINTEXT — the only time it exists — for a response the caller shows once.
 */
export async function mintRecoveryCodes(
  db: TenantDb,
  args: { tenantId: string; memberSub: string },
): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => formatCode(randomBytes(CODE_BYTES)))
  await db.tx(async (sql) => {
    await sql`
      UPDATE member_recovery_codes SET revoked_at = now()
      WHERE member_sub = ${args.memberSub} AND used_at IS NULL AND revoked_at IS NULL`
    for (const code of codes) {
      await sql`
        INSERT INTO member_recovery_codes (tenant_id, member_sub, code_hash)
        VALUES (${args.tenantId}, ${args.memberSub}, ${hashCode(normalizeCode(code))})`
    }
  })
  return codes
}

/**
 * Take the member's live set out of service without deleting the history.
 *
 * Called wherever the FACTORS are cleared by somebody other than the door: the administrator reset
 * (#644 §10a) and the password take-away. Leaving a set alive across those would be the printout in a
 * drawer still able to wipe the factor the member enrols tomorrow — a reset that resets less than it
 * appears to. Returns how many were still live, so the caller can decide whether anything happened.
 */
export async function revokeRecoveryCodes(db: TenantDb, memberSub: string): Promise<number> {
  const rows = await db.sql<{ id: string }[]>`
    UPDATE member_recovery_codes SET revoked_at = now()
    WHERE member_sub = ${memberSub} AND used_at IS NULL AND revoked_at IS NULL
    RETURNING id`
  return rows.length
}

export type RecoveryOutcome =
  | { ok: true; memberSub: string; factorsRemoved: number }
  | { ok: false }

/**
 * Spend a code at the door.
 *
 * ⚠️ THE WORK IS THE SAME WHATEVER HAPPENS. A wrong code, no set, a revoked set and the switch being
 * off all do one sha256 and one indexed lookup and answer the same failure — the availability read is
 * performed rather than short-circuited, so no branch is cheaper than another. Nothing here tells a
 * caller whether an account exists, holds codes, or is even the account they think it is.
 *
 * The decision point IS the update: `WHERE used_at IS NULL AND revoked_at IS NULL` means two racing
 * attempts with the same code cannot both win (the `password_resets` discipline). The factor wipe and
 * the revocation of the rest of the set ride the same transaction — a code that has been spent must
 * never leave the account half-reset.
 */
export async function spendRecoveryCode(
  db: TenantDb,
  args: {
    memberSub?: string
    code: string
    /**
     * Runs INSIDE the spending transaction, once, only when a code was actually spent. The ledger entry
     * for "this account's factors were wiped" must not be able to survive a rollback of the wipe, nor
     * the wipe survive a failure to record it — ADR-226 §5's "in-transaction, like their §10a siblings".
     */
    inTx?: (sql: TenantDb['sql']) => Promise<void>
  },
): Promise<RecoveryOutcome> {
  const enabled = recoveryEnabled()
  const normalized = normalizeCode(args.code ?? '')
  const digest = hashCode(normalized)
  return db.tx(async (sql) => {
    // Scoped to the member the factor session names: a code is a credential for ONE account, and a
    // lookup by hash alone would let one member's code open whichever account minted it.
    const rows = await sql<{ id: string; member_sub: string }[]>`
      UPDATE member_recovery_codes SET used_at = now()
      WHERE code_hash = ${digest}
        AND used_at IS NULL AND revoked_at IS NULL
        AND (${args.memberSub ?? null}::text IS NULL OR member_sub = ${args.memberSub ?? null})
      RETURNING id, member_sub`
    if (!enabled || rows.length === 0 || normalized.length === 0) {
      // Roll the (possibly successful) spend back when the switch is off, so turning it on later does
      // not find codes silently consumed by attempts that were refused.
      if (!enabled && rows.length > 0) await sql`UPDATE member_recovery_codes SET used_at = NULL WHERE id = ${rows[0]!.id}`
      return { ok: false }
    }
    const memberSub = rows[0]!.member_sub
    // The rest of the set goes with it: the point of using one is that the authenticator is gone, and
    // leaving nine live codes lying around after a rescue is a credential nobody is tracking.
    await sql`
      UPDATE member_recovery_codes SET revoked_at = now()
      WHERE member_sub = ${memberSub} AND used_at IS NULL AND revoked_at IS NULL`
    const removed = await sql<{ id: string }[]>`DELETE FROM member_factors WHERE member_sub = ${memberSub} RETURNING id`
    await args.inTx?.(sql as unknown as TenantDb['sql'])
    return { ok: true, memberSub, factorsRemoved: removed.length }
  })
}
