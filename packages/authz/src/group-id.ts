// #831: ONE formula for a group's authorization-store id, because two of them silently disagreed.
//
// An IdP group's NAME may hold spaces, Japanese or symbols that an FGA object id cannot, so the id is
// a tenant-salted hash of the name. The hash is the whole identity: a grant to "Engineering" and the
// membership sync for "Engineering" have to land on the same string or the grant resolves to nobody.
//
// It lived in `apps/server/src/auth/group-sync.ts` and was COPIED into `infra/openfga/resync.ts`, the
// script that rebuilds a wiped or migrated store. The copy's comment promised "MUST match
// group-sync.ts exactly, or a rebuilt group membership lands on the wrong id and group grants silently
// break" — and it did not match: the original separates the tenant and the name with a NUL byte, the
// copy used a space. Four months, in the one script whose whole job is putting authorization back.
//
// The separator is a NUL because it cannot appear in either half, so no pair of (tenant, name) can be
// confused with another by concatenation. ⚠️ It is written as the escape `\x00` and not as a literal
// byte: a literal one made the file BINARY to git (#744), which is how the copy came to be written
// from a version of this line nobody could read.
//
// Living in `@wikistead/authz` rather than in either caller is the point of the fix. A shared comment
// asking two files to agree is not a mechanism; one function is.
import { createHash } from 'node:crypto'

export function groupFgaId(tenantId: string, name: string): string {
  return createHash('sha256').update(`${tenantId}\x00${name}`).digest('hex').slice(0, 24)
}

/** The FGA grantee string for a group BY NAME (#163 / ADR-053): `group:<id>#member`. */
export function groupGrantee(tenantId: string, name: string): string {
  return `group:${groupFgaId(tenantId, name)}#member`
}
