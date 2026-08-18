// Storage for second factors (#656 / ADR-219 §7). Migration 117.
//
// The read/write layer only — no endpoints, no policy, no enrolment flow. Those are #657 and #652, and
// putting any of them here would add branches nothing can reach yet.
//
// Two rules this file exists to hold, both of which are easy to get wrong at a call site:
//
//   1. The TOTP secret is ENCRYPTED, never hashed. Verification recomputes the code from it, so it has
//      to come back — which is the opposite of the password rule next door in `password-hash.ts`, and
//      the reason both live behind functions instead of raw SQL scattered through routes.
//   2. An UNCONFIRMED factor is not a factor. `confirmed_at` is NULL until somebody proves they can
//      produce a code from it, and every question of the form "does this member have a factor" reads
//      only confirmed rows. Counting an abandoned enrolment would let a policy be satisfied by starting
//      one and walking away, and would let the last admin "hold" a factor they cannot use.
import type { TenantDb } from '../db/index.js'
import { encryptSecret, decryptSecret } from './secret-crypto.js'

/**
 * The kinds of second factor this product ships, as a RUNTIME value (#734 / ADR-237 §2.1).
 *
 * It was a type and a database CHECK constraint, which meant nothing could walk it: a type does not
 * exist at run time, so the documentation ledger had no way to ask "what factors are there?" and a
 * third kind could ship undocumented. Same move #729 made for the importer's dialects — one constant,
 * and the type derived from it so the two cannot drift apart.
 *
 * The recovery path (ADR-226) is not a kind — it is how a member gets back when every kind is gone —
 * so it is enumerated beside these rather than inside them (see RECOVERY_CAPABILITY_ID).
 */
export const SECOND_FACTOR_KINDS = ['totp', 'passkey'] as const
export type FactorKind = (typeof SECOND_FACTOR_KINDS)[number]

/** A factor as the member's own list shows it. Deliberately carries no secret. */
export type MemberFactor = {
  id: string
  kind: FactorKind
  label: string
  createdAt: Date
  confirmedAt: Date | null
  lastUsedAt: Date | null
}

type FactorRow = {
  id: string
  kind: FactorKind
  label: string
  created_at: Date
  confirmed_at: Date | null
  last_used_at: Date | null
}

const toFactor = (r: FactorRow): MemberFactor => ({
  id: r.id,
  kind: r.kind,
  label: r.label,
  createdAt: r.created_at,
  confirmedAt: r.confirmed_at,
  lastUsedAt: r.last_used_at,
})

/**
 * Begin a TOTP enrolment: a factor row and its encrypted secret, UNCONFIRMED.
 *
 * Both rows in one transaction. A header with no secret is a factor that can never be confirmed and
 * shows up in the member's list as something they cannot use or explain; a secret with no header is
 * unreachable. Neither is recoverable by the code that reads them, so neither is allowed to exist.
 */
export async function startTotpEnrolment(
  db: TenantDb,
  args: { tenantId: string; memberSub: string; secret: string; label?: string },
): Promise<{ factorId: string }> {
  // `db.tx`, not `db.sql.begin`: the driver owns the isolation dispatch (tenant-db.ts), and a
  // namespace-promoted tenant needs its search_path set on the transaction's own connection. Reaching
  // past the interface here would work on a logical tenant and read `public.*` on a promoted one.
  return db.tx(async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO member_factors (tenant_id, member_sub, kind, label)
      VALUES (${args.tenantId}, ${args.memberSub}, 'totp', ${args.label ?? ''})
      RETURNING id`
    const factorId = row!.id
    await sql`
      INSERT INTO member_totp_secrets (factor_id, tenant_id, secret_enc)
      VALUES (${factorId}, ${args.tenantId}, ${encryptSecret(args.secret)})`
    return { factorId }
  })
}

/**
 * Begin a PASSKEY enrolment: a header row and nothing else.
 *
 * No detail row yet, and that asymmetry with TOTP is the format's, not an oversight — a passkey's
 * material does not exist until the authenticator has made it, so there is nothing to write until the
 * browser comes back. The row is unconfirmed either way, so an abandoned one behaves identically.
 */
export async function startPasskeyEnrolment(
  db: TenantDb,
  args: { tenantId: string; memberSub: string; label?: string },
): Promise<{ factorId: string }> {
  const [row] = await db.sql<{ id: string }[]>`
    INSERT INTO member_factors (tenant_id, member_sub, kind, label)
    VALUES (${args.tenantId}, ${args.memberSub}, 'passkey', ${args.label ?? ''})
    RETURNING id`
  return { factorId: row!.id }
}

/**
 * The secret, decrypted, for a factor that exists.
 *
 * Returns null rather than throwing on a missing row: the caller's next line is "then the code is
 * wrong", and a factor that vanished between two requests is not an exceptional condition.
 */
export async function totpSecretFor(db: TenantDb, factorId: string): Promise<string | null> {
  const [row] = await db.sql<{ secret_enc: string }[]>`
    SELECT secret_enc FROM member_totp_secrets WHERE factor_id = ${factorId}`
  return row ? decryptSecret(row.secret_enc) : null
}

/**
 * Confirm an enrolment. Returns false when there was nothing pending to confirm.
 *
 * `confirmed_at IS NULL` is in the WHERE on purpose: confirming twice would move the timestamp, which
 * is the one thing the audit ledger reads to answer "when did this account get its factor".
 */
export async function confirmFactor(db: TenantDb, factorId: string): Promise<boolean> {
  const rows = await db.sql`
    UPDATE member_factors SET confirmed_at = now()
    WHERE id = ${factorId} AND confirmed_at IS NULL
    RETURNING id`
  return rows.length > 0
}

/**
 * What the member's own list shows — EVERY row of theirs, confirmed or not, oldest first.
 *
 * It used to return confirmed rows only, and that read as the right answer: an abandoned enrolment is
 * not a factor, and showing it as one would be a lie. But the cap counts pending rows (deliberately —
 * an uncapped start is an unbounded write), so hiding them made "you can create it, you cannot see it,
 * and because you cannot see it you cannot delete it". Measured on the review: three abandoned
 * starts, a list showing nothing, and the eighth CONFIRMED enrolment refused with the cap reached.
 *
 * Two rules were each right and their conjunction was a trap. What the cap counts and what the reader
 * can remove now agree; `confirmedAt` is null on the ones that are not factors yet, and the screen says
 * so rather than pretending they are.
 */
export async function listFactors(db: TenantDb, memberSub: string): Promise<MemberFactor[]> {
  const rows = await db.sql<FactorRow[]>`
    SELECT id, kind, label, created_at, confirmed_at, last_used_at
    FROM member_factors
    WHERE member_sub = ${memberSub}
    ORDER BY created_at`
  return rows.map(toFactor)
}

/**
 * Drop this member's UNCONFIRMED rows. Called when a new enrolment starts.
 *
 * Belt to the list's braces: a reader who abandons an enrolment and comes back to try again should not
 * have to tidy up after themselves before they are allowed to. Only pending rows, so nothing anybody
 * has ever proved is touched.
 */
export async function discardPendingFactors(db: TenantDb, memberSub: string): Promise<number> {
  const rows = await db.sql`
    DELETE FROM member_factors WHERE member_sub = ${memberSub} AND confirmed_at IS NULL RETURNING id`
  return rows.length
}

/**
 * Whether this member holds ANY confirmed factor — no kind, no host.
 *
 * ⚠️ NOT the question a policy check asks, and its docstring used to say it was. ADR-222 §3 names this
 * function as the one that built a dead end: burnt into the factor receipt as `enrolled`, it told a
 * member holding only an authenticator app under a passkey stance to present the factor they held, and
 * then refused them enrolment for holding it. What a door wants is `presentableKinds` — could they
 * offer something THIS TENANT ACCEPTS, at THIS HOST.
 *
 * Kept because "do they have anything at all" is still a real question for surfaces that are not about
 * getting in (the members list's has-a-factor mark). A caller reaching for it to decide access is the
 * mistake, and this comment is the sign on it.
 */
export async function hasConfirmedFactor(db: TenantDb, memberSub: string): Promise<boolean> {
  const [row] = await db.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM member_factors
    WHERE member_sub = ${memberSub} AND confirmed_at IS NOT NULL`
  return (row?.n ?? 0) > 0
}

/**
 * Spend a counter, refusing one already spent.
 *
 * The comparison and the write are ONE statement. Reading `last_counter` and then updating it would
 * let two requests carrying the same code both read the old value and both proceed — which is exactly
 * the replay this exists to refuse, arriving as a race instead of as a retry.
 *
 * `>` and not `>=`: the same step may be spent once. `IS NULL` covers the first use.
 */
export async function spendTotpCounter(db: TenantDb, factorId: string, counter: number): Promise<boolean> {
  const rows = await db.sql`
    UPDATE member_totp_secrets SET last_counter = ${counter}
    WHERE factor_id = ${factorId} AND (last_counter IS NULL OR last_counter < ${counter})
    RETURNING factor_id`
  return rows.length > 0
}

/** Note that a factor was used. Best-effort display data, never a gate. */
export async function markFactorUsed(db: TenantDb, factorId: string): Promise<void> {
  await db.sql`UPDATE member_factors SET last_used_at = now() WHERE id = ${factorId}`
}

/**
 * Remove one factor. The detail row goes with it through ON DELETE CASCADE.
 *
 * Scoped by `member_sub` as well as by id: an id is a bearer token for a row otherwise, and the caller
 * that removes "my factor" must not be able to remove somebody else's by guessing one.
 */
export async function deleteFactor(db: TenantDb, memberSub: string, factorId: string): Promise<boolean> {
  const rows = await db.sql`
    DELETE FROM member_factors WHERE id = ${factorId} AND member_sub = ${memberSub} RETURNING id`
  return rows.length > 0
}

/**
 * Remove every factor a member holds. This is what a member deletion and an administrator reset
 * (ADR-219 §4) both do; #654 wires it to the paths that already remove credentials.
 */
export async function deleteAllFactors(db: TenantDb, memberSub: string): Promise<number> {
  const rows = await db.sql`DELETE FROM member_factors WHERE member_sub = ${memberSub} RETURNING id`
  return rows.length
}
