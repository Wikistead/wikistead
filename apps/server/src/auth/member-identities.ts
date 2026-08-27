// #858 / #959, ADR-259 §3.1: member_identities is how a member gains a second way in without a
// second member being created. This module is the READ side that routes/auth.ts consults at login;
// the WRITE side (linking from account settings, ADR-259 §3.3) is a separate ticket (#947).
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
