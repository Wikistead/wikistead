// Self-service password reset (#568 / ADR-198 §6).
//
// Two halves, and the dangerous parts are in different places.
//
// REQUESTING is an unauthenticated endpoint that takes an email address, so its whole job is to say
// nothing. It answers identically whether the address belongs to a local member, to an OIDC member,
// or to nobody at all — and it must not become an email-bombing lever, hence the rate limits.
//
// COMPLETING may only ever UPDATE a credential row that already exists. This is the hole ADR-198's
// rev2 shipped and the review caught: keying off the member's EMAIL let a reset create a credential
// for an `identity_source='oidc'` member, growing a password door on a tenant that had deliberately
// standardised on SSO. A reset can restore access to a password account; it can never invent one.
//
// The token is minted at SEND time (rev3): the email outbox stores a pointer, not a body, so a link
// cannot be reconstructed from a queued row — which also fixes the TTL's origin at the moment the
// mail is actually produced.
import { createHash, randomBytes } from 'node:crypto'
import type { Sql } from 'postgres'
import type { TenantDb } from '../db/index.js'
import { hashPassword } from './password-hash.js'
import { validatePasswordPolicy } from './password-policy.js'
import { localLoginEnabled } from './login-methods.js'
import { auditIfEntitled } from '../audit/sink.js'

// Short: a reset link is a bearer credential for an account, and the person asked for it seconds ago.
export const RESET_TTL_MS = 60 * 60 * 1000

const hashToken = (plaintext: string) => createHash('sha256').update(plaintext).digest('hex')

// Mint a reset for `identifier`, or DON'T — and answer the same either way. The caller emails the
// token when it gets one and says nothing when it does not.
export async function mintPasswordReset(db: TenantDb, tenant: { plan: string }, identifier: string): Promise<{ token: string; email: string; memberSub: string } | null> {
  if (!(await localLoginEnabled(db))) return null
  const id = identifier.trim().toLowerCase()
  if (!id) return null
  // The credential row is the gate, not the member's email: a member with no row is not a password
  // account, and this is the only lookup that cannot be tricked into treating one as if it were.
  const [cred] = await db.sql<{ member_sub: string }[]>`
    SELECT member_sub FROM local_credentials WHERE identifier = ${id}`
  if (!cred) return null
  // #605 / ADR-210 §4 row 4: while the stance bites, only an EXEMPT member may be handed a reset link.
  // The route's uniform 204 already says nothing either way, so the refusal is indistinguishable.
  const { stanceBlocksLocalFor } = await import('./sso-stance.js')
  if (await stanceBlocksLocalFor(db, tenant, cred.member_sub)) return null
  const token = `pwr_${randomBytes(32).toString('base64url')}`
  await db.sql`
    INSERT INTO password_resets (tenant_id, member_sub, token_hash, expires_at)
    SELECT tenant_id, ${cred.member_sub}, ${hashToken(token)}, now() + ${`${RESET_TTL_MS} milliseconds`}::interval
    FROM local_credentials WHERE member_sub = ${cred.member_sub}`
  return { token, email: id, memberSub: cred.member_sub }
}

/**
 * #606 / ADR-205 §2 (ruled option A): give an EXISTING member a password entrance.
 *
 * The reset above is for somebody who already has one — its credential-row lookup is deliberately the
 * gate, so a member with no row is not a password account and cannot be treated as one. That is exactly
 * the person this mints for: somebody who arrived by SCIM or an IdP sign-in and therefore has no way to
 * hold a password at all, which is what made #605's break-glass unbuildable.
 *
 * Admin-initiated (the route gates it), so no lookup by address: the member is named by their sub. The
 * tenant's `local_login_enabled` still gates it — the same door the invite uses.
 *
 * #614 (review rejection, 2026-08-05): a member who already HAS a credential used to be refused here, on
 * the reasoning that changing an existing password is a reset and a reset is somebody else's function.
 * That reasoning left the reset with EXACTLY ONE delivery route — email — while the invite has always
 * had a copy-link fallback for a tenant with no SMTP. So an admin could not help somebody who had
 * forgotten their password and could not read mail, which is the person #605's break-glass exists for:
 * under `sso_required` the exempt member's password IS the way back in.
 *
 * So "they already have one" is no longer a refusal. It is the case the caller most wants. `reissue`
 * says which of the two happened, so the audit line and the wording can differ without a second
 * mechanism: the token is the same `pwr_` reset token, one hour, single use.
 */
export async function mintPasswordSetup(
  db: TenantDb,
  memberSub: string,
): Promise<{ token: string; email: string; reissue: boolean } | null> {
  if (!(await localLoginEnabled(db))) return null
  const [member] = await db.sql<{ email: string | null }[]>`
    SELECT email FROM members WHERE sub = ${memberSub}`
  const email = (member?.email ?? '').trim().toLowerCase()
  if (!email) return null // no address is no sign-in name; the route answers 400
  const [existing] = await db.sql`SELECT 1 FROM local_credentials WHERE member_sub = ${memberSub}`
  // The address must not already be SOMEBODY ELSE's sign-in name (the same collision the invite
  // acceptance checks; two people cannot share one identifier). Their own row is not a collision —
  // that is the reissue case — so the check excludes it rather than the whole table.
  const [taken] = await db.sql`
    SELECT 1 FROM local_credentials WHERE identifier = ${email} AND member_sub <> ${memberSub}`
  if (taken) return null
  const token = `pwr_${randomBytes(32).toString('base64url')}`
  await db.sql`
    INSERT INTO password_resets (tenant_id, member_sub, token_hash, expires_at)
    SELECT tenant_id, ${memberSub}, ${hashToken(token)}, now() + ${`${RESET_TTL_MS} milliseconds`}::interval
    FROM members WHERE sub = ${memberSub}`
  return { token, email, reissue: Boolean(existing) }
}

// Complete a reset. Returns the member whose password changed, or null for every failure — an
// unknown, expired, consumed token and a tenant that has switched password sign-in off are one
// answer, for the same reason the invite acceptance path gives one.
export async function completePasswordReset(
  // review F1: the tenant travels so the audit line can be written INSIDE the transaction that
  // changes the password. auditIfEntitled queues through the outbox exactly so a ledger entry
  // exists when — and only when — the change it describes committed.
  db: TenantDb, tenant: { id: string; plan: string }, token: string, newPassword: string,
): Promise<{ memberSub: string } | null> {
  if (!(await localLoginEnabled(db))) return null
  if (!validatePasswordPolicy(newPassword)) {
    throw Object.assign(new Error('password does not meet the policy'), { statusCode: 400, code: 'weak_password' })
  }
  // Hash OUTSIDE the transaction — 60ms of CPU is not a reason to hold a database connection.
  const hash = await hashPassword(newPassword)
  return db.tx(async (tx: Sql) => {
    // #605 / ADR-210 §4 row 5: the stance gate needs the MEMBER, who is unknown until the row is read —
    // so PEEK first (no write), ask about that member, and only then run the unchanged consume-once
    // UPDATE. A refusal must NOT consume the link: an admin who grants the exemption after the member
    // clicked must find the link still alive, in the middle of the outage this exists for. Peeking
    // discloses nothing — holding the token IS the capability (the /auth/invite-kind reasoning).
    const [peek] = await tx<{ member_sub: string }[]>`
      SELECT member_sub FROM password_resets
       WHERE token_hash = ${hashToken(token)} AND used_at IS NULL AND expires_at > now()`
    if (!peek) return null
    const { stanceBlocksLocalFor } = await import('./sso-stance.js')
    if (await stanceBlocksLocalFor(db, tenant, peek.member_sub)) return null
    // Consume-once: one UPDATE decides it, so two simultaneous uses of the same link cannot both win.
    const claimed = await tx<{ member_sub: string }[]>`
      UPDATE password_resets SET used_at = now()
       WHERE token_hash = ${hashToken(token)} AND used_at IS NULL AND expires_at > now()
      RETURNING member_sub`
    if (claimed.length === 0) return null
    const memberSub = claimed[0]!.member_sub
    // UPDATE, never INSERT — for a RESET. If the row vanished between minting and completing (the
    // member was removed), this writes nothing and the reset answers as a dead link rather than
    // resurrecting a credential for someone who is gone.
    const written = await tx<{ member_sub: string }[]>`
      UPDATE local_credentials SET password_hash = ${hash}, updated_at = now()
       WHERE member_sub = ${memberSub}
      RETURNING member_sub`
    if (written.length === 0) {
      // #606 (ruled option A): a SETUP link has no row to update — that is its whole point. It may
      // create one, but only for a member who still exists (a removed member's token must stay a dead
      // link, which is the rule the UPDATE above encodes) and only if the address is still free.
      const [member] = await tx<{ email: string | null }[]>`SELECT email FROM members WHERE sub = ${memberSub}`
      const email = (member?.email ?? '').trim().toLowerCase()
      if (!email) return null
      const [taken] = await tx`SELECT 1 FROM local_credentials WHERE identifier = ${email}`
      if (taken) return null
      await tx`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
               SELECT tenant_id, ${memberSub}, ${email}, ${hash} FROM members WHERE sub = ${memberSub}`
    }
    // Every OTHER live reset for this member dies with the one that was used: someone who requested
    // three links and had one stolen should not be leaving two more live.
    await tx`UPDATE password_resets SET used_at = now() WHERE member_sub = ${memberSub} AND used_at IS NULL`
    // The person completing a reset is not signed in, so the actor is the member the reset was for
    // — which is what the link proved control of.
    await auditIfEntitled(tx, tenant, {
      actor: `user:${memberSub}`, action: 'member.password_reset_completed', target: `member:${memberSub}`,
    })
    return { memberSub }
  })
}
