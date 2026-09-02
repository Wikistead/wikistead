// #858 / #959, ADR-259 §3.1: member_identities is how a member gains a second way in without a
// second member being created. This module is the READ side that routes/auth.ts consults at login;
// the WRITE side (linking from account settings, ADR-259 §3.3) landed as #947, below.
import type { TenantDb } from '../db/index.js'
import type { Sql } from 'postgres'

/**
 * The stored link for (tenant, connection, external subject), if one exists.
 *
 * ADR-259 §3.1: "a stored link wins over the deterministic mint." The caller reads this BEFORE
 * applying any connection subject-prefix (or using the raw external subject as-is), and prefers it
 * unconditionally — including when the subject the connection would otherwise mint already belongs to
 * a different, LIVE member (§5's #807 case). Preferring the link only when the minted subject has no
 * member row is the implementation ADR-259 §5 names as wrong: it passes every other case while
 * reproducing the exact defect #807 was raised on.
 */
export async function findMemberIdentityLink(
  db: TenantDb,
  tenantId: string,
  connectionId: string,
  externalSubject: string,
): Promise<string | null> {
  const [row] = await db.sql<{ member_sub: string }[]>`
    SELECT member_sub FROM member_identities
    WHERE tenant_id = ${tenantId} AND connection_id = ${connectionId} AND external_subject = ${externalSubject}
    LIMIT 1`
  return row?.member_sub ?? null
}

/**
 * A member's own links (account settings, #947), and the connection-delete cascade (#960) — the
 * index this reads (`idx_member_identities_member`) was created for exactly these two callers.
 */
export async function listLinkedConnectionIds(db: TenantDb, tenantId: string, memberSub: string): Promise<string[]> {
  const rows = await db.sql<{ connection_id: string }[]>`
    SELECT connection_id FROM member_identities WHERE tenant_id = ${tenantId} AND member_sub = ${memberSub}`
  return rows.map((r) => r.connection_id)
}

/**
 * Write a link (#947 / ADR-259 §3.3). Both `externalSubject` and `memberSub` MUST come from
 * server-verified sources — the callback-verified upstream subject and the `OidcLoginState`'s
 * `linkMemberSub` — never from anything a client supplied; §5 pins that the write cannot be reached
 * any other way.
 *
 * A pre-existing row for (tenant, connection, external subject) naming a DIFFERENT member is refused
 * (409 `identity_taken`) rather than silently left alone: an `ON CONFLICT DO NOTHING` here would tell
 * the caller the link succeeded while the identity stayed bound to whoever already holds it. A row
 * that already names THIS member is a harmless replay (double-click, retried redirect) and no-ops.
 *
 * #961 / ADR-259 §3.7: the INSERT and the display-name-override clear happen in ONE transaction. A
 * member holding any IdP-asserted way in may not override their name (account.ts's restrictive-union
 * guard refuses the WRITE), but an override set before this link existed already persists and would
 * outlive the guard that would now refuse it — so linking clears it here, in the same write, rather
 * than leaving a stale value the guard never sees again.
 */
function identityTaken(): Error {
  return Object.assign(
    new Error('this sign-in is already linked to a different member of this workspace'),
    { statusCode: 409, code: 'identity_taken' },
  )
}

export async function linkMemberIdentity(
  db: TenantDb,
  tenantId: string,
  connectionId: string,
  externalSubject: string,
  memberSub: string,
): Promise<void> {
  try {
    await db.tx(async (tx) => {
      const [existing] = await tx<{ member_sub: string }[]>`
        SELECT member_sub FROM member_identities
        WHERE tenant_id = ${tenantId} AND connection_id = ${connectionId} AND external_subject = ${externalSubject}
        LIMIT 1`
      if (existing && existing.member_sub !== memberSub) throw identityTaken()
      if (existing) return
      await tx`
        INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
        VALUES (${tenantId}, ${connectionId}, ${externalSubject}, ${memberSub})`
      await tx`UPDATE members SET display_name_override = NULL, updated_at = now() WHERE tenant_id = ${tenantId} AND sub = ${memberSub}`
    })
  } catch (e) {
    // #968: a genuine race (the same sign-in linking from two tabs at once) has both calls' SELECT
    // above see no row before either INSERTs — the loser's INSERT hits the UNIQUE constraint as a
    // raw postgres 23505, and that abandons ITS transaction (a Postgres tx that hit an error refuses
    // every further statement until rollback, so the follow-up read below runs OUTSIDE it, once the
    // winner's transaction has already committed). Without this, the loser threw a bare 500 — the
    // route this feeds documents as never answering with JSON (docs/api-reference.md).
    if ((e as { code?: string }).code !== '23505') throw e
    const [winner] = await db.sql<{ member_sub: string }[]>`
      SELECT member_sub FROM member_identities
      WHERE tenant_id = ${tenantId} AND connection_id = ${connectionId} AND external_subject = ${externalSubject}
      LIMIT 1`
    if (!winner || winner.member_sub !== memberSub) throw identityTaken()
    // Same member: the winner's transaction already inserted the row and cleared the override —
    // this call needed nothing further, the same harmless-replay outcome as the existing-row check.
  }
}

/**
 * Remove a member's own link to a connection (#1045 / ADR-259 §3.9). The caller is responsible for
 * everything §3.9 requires BEFORE calling this: re-authentication, and confirming the member has
 * another way in (`memberHasAnotherWayIn` with `excludeLinkOnly` set to this connection, ORed with a
 * `local_credentials` check) — this function only performs the write.
 *
 * Takes a `Sql` (not a `TenantDb`) so the caller can run it INSIDE the same transaction as the audit
 * row `auditIfEntitled` writes — a member-initiated destructive write and the ledger's record of it
 * should not be able to land as two separate facts (one committed, one lost) if the process dies
 * between them.
 *
 * Scoped to `(tenantId, connectionId, memberSub)`, not by row id: the caller never learns a link's
 * internal id (`GET /me/connections` reports linkage as a boolean, per connection), so there is no id
 * to hand back. Returns whether a row actually existed to remove, for the caller's 404.
 *
 * ⚠️ KNOWN GAP, left open on purpose rather than guessed at (review c-a8af, #1045): this does
 * NOT touch `member_connection_groups` or `members.groups`. `group-sync.ts`'s `revokeConnectionGroups`
 * revokes a connection's trust-group-derived roles the moment the STANCE requires it (biting kicks a
 * member who no longer satisfies it out immediately, not on their next sign-in) — whether an ordinary
 * self-service unlink should revoke the SAME slice, or leave it to lapse on the next sign-in the way
 * `identity_source` itself is documented as transitional (§3.9's own "judged by identity_source until
 * they sign in again"), is a policy question ADR-259 §3.9 never asked. Filed as a follow-up rather than
 * decided here.
 */
export async function unlinkMemberIdentity(
  sql: Sql,
  tenantId: string,
  connectionId: string,
  memberSub: string,
): Promise<boolean> {
  const [row] = await sql<{ id: string }[]>`
    DELETE FROM member_identities
    WHERE tenant_id = ${tenantId} AND connection_id = ${connectionId} AND member_sub = ${memberSub}
    RETURNING id`
  return !!row
}
