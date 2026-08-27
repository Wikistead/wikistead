// #858 / #959, ADR-259 §3.1: member_identities is how a member gains a second way in without a
// second member being created. This module is the READ side that routes/auth.ts consults at login;
// the WRITE side (linking from account settings, ADR-259 §3.3) landed as #947, below.
import type { TenantDb } from '../db/index.js'

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
 */
export async function linkMemberIdentity(
  db: TenantDb,
  tenantId: string,
  connectionId: string,
  externalSubject: string,
  memberSub: string,
): Promise<void> {
  const [existing] = await db.sql<{ member_sub: string }[]>`
    SELECT member_sub FROM member_identities
    WHERE tenant_id = ${tenantId} AND connection_id = ${connectionId} AND external_subject = ${externalSubject}
    LIMIT 1`
  if (existing && existing.member_sub !== memberSub) {
    throw Object.assign(
      new Error('this sign-in is already linked to a different member of this workspace'),
      { statusCode: 409, code: 'identity_taken' },
    )
  }
  if (existing) return
  await db.sql`
    INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
    VALUES (${tenantId}, ${connectionId}, ${externalSubject}, ${memberSub})`
}
