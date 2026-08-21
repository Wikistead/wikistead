import type { OpenFgaClient } from '@openfga/sdk'
import type { Sql } from 'postgres'
import { writeTuples, deleteTuples, isAlreadyConverged } from '@wikistead/authz'

// #111 / ADR-046 — wire `members.groups` into FGA `group#member` so group grants resolve and
// group-granted members become @mentionable.

// A deterministic, FGA-id-safe object id for a group (group-id format C). An IdP group NAME may
// contain spaces / Japanese / symbols that are invalid in an FGA object id, so it is hashed
// (hex, tenant-salted): the same (tenant, name) ALWAYS maps to the same id, and the same name in
// two tenants maps to DIFFERENT ids (no cross-tenant collision). The human name stays in
// members.groups for display; FGA only ever sees the hash. The grant side MUST derive the id via
// the SAME function, so a grant to a group by name resolves to its synced members.
//
// #831: the formula MOVED to `@wikistead/authz` and is re-exported here so every caller keeps its
// import. It moved because the rebuild script had copied it with a different separator and nothing
// compared them — see the note on the shared function. Re-exported rather than re-implemented: a
// second definition beside this comment is exactly what went wrong.
import { groupFgaId, groupGrantee } from '@wikistead/authz'
export { groupFgaId, groupGrantee }

// Reverse map for DISPLAY (#163): groupFgaId is one-way (sha256), so a stored `group:<id>#member`
// grantee can't be un-hashed. Build hash→name from the tenant's known group names instead, so the
// grant list can show "Engineering" rather than the opaque id. A grant whose group no longer
// appears in any member's groups (renamed/emptied at the IdP) has no entry → callers fall back to
// the raw grantee.
export function groupNameByFgaId(tenantId: string, names: readonly string[]): Map<string, string> {
  return new Map(names.map((n) => [groupFgaId(tenantId, n), n]))
}

// #536 the reverse map used to be built from members.groups ALONE, so a group that no longer
// appears in anybody's groups — renamed or emptied at the IdP — displayed as "unknown group" even
// when the product could still name it: a group_role_mappings row OWNS that assignment and stores
// the name it was created with. "We cannot resolve this id" and "nobody is in this group right now"
// are different facts, and only the first one deserves the orphan label. Both listings resolve
// through here so they cannot drift apart again.
export async function knownGroupNames(db: { sql: Sql }): Promise<string[]> {
  const rows = await db.sql<{ g: string }[]>`
    SELECT DISTINCT unnest(groups) AS g FROM members WHERE groups IS NOT NULL
    UNION
    SELECT DISTINCT group_name AS g FROM group_role_mappings
    UNION
    SELECT DISTINCT group_name AS g FROM role_assignments WHERE group_name IS NOT NULL`
  return rows.map((r) => r.g)
}

// #578 bounce ①: the names that came from the DIRECTORY — somebody signed in carrying them. Everything
// `knownGroupNames` returns can be displayed; only these are CONFIRMED. A name a manager typed for a
// group the IdP has not produced yet is a real name and must be shown as one, but the two must stay
// distinguishable: "we cannot resolve this id" and "nobody carries this group yet" are different facts,
// and the second one is a normal state on the way to the first.
export async function confirmedGroupNames(db: { sql: Sql }): Promise<Set<string>> {
  const rows = await db.sql<{ g: string }[]>`
    SELECT DISTINCT unnest(groups) AS g FROM members WHERE groups IS NOT NULL`
  return new Set(rows.map((r) => r.g))
}

// Extract the name of a `group:<id>#member` grantee via the reverse map; undefined if not a group
// grantee or the id isn't known.
export function resolveGroupName(grantee: string, byId: Map<string, string>): string | undefined {
  const m = /^group:([^#\s]+)#member$/.exec(grantee)
  return m ? byId.get(m[1]!) : undefined
}

// Sync a member's groups into FGA `group:<id>#member@user:<sub>` by DIFFING old vs new. writeTuples
// is NOT idempotent, so we write only additions and delete only removals; an unchanged re-login
// writes nothing. FGA is the source of truth — members.groups mirrors INTO it (like is_public ↔
// view@user:*). Call this where members.groups is written (the login upsert), inside that tx so an
// FGA failure rolls the row back and the next login re-derives the same diff.
export async function syncMemberGroups(
  fga: OpenFgaClient,
  tenantId: string,
  sub: string,
  prev: readonly string[],
  next: readonly string[],
): Promise<void> {
  const prevSet = new Set(prev)
  const nextSet = new Set(next)
  const tuple = (name: string) => ({ user: `user:${sub}`, relation: 'member', object: `group:${groupFgaId(tenantId, name)}` })
  const added = next.filter((g) => !prevSet.has(g)).map(tuple)
  const removed = prev.filter((g) => !nextSet.has(g)).map(tuple)
  // #608: this diff CONVERGES the store onto `next` — so a tuple that already holds the goal state is
  // success, not failure. The diff is computed against `members.groups`, which is a MIRROR, and a mirror
  // can be stale (measured: a rebuilt store left the row claiming a group whose tuple was gone, and the
  // resulting "cannot delete a tuple which does not exist" failed the whole login — a member locked out
  // of sign-in by a cache). The batch write is kept as the fast path; on failure each tuple converges
  // individually, and only the two already-converged answers are tolerated — a genuine FGA failure
  // (network, authz) still throws and still rolls the login back.
  // #578: the tolerance is asked by CODE, not by matching the store's prose. FGA's sentence no longer
  // reaches this far (it is replaced at the tuple-helper boundary so an admin never reads it), and a
  // substring match against a message somebody else owns is the kind of check that fails silently when
  // that message changes — here, by turning a converged state back into a locked-out login.
  const converge = async (tuples: ReturnType<typeof tuple>[], op: 'write' | 'delete') => {
    if (!tuples.length) return
    const run = (batch: ReturnType<typeof tuple>[]) => op === 'write' ? writeTuples(fga, batch) : deleteTuples(fga, batch)
    try { await run(tuples) } catch {
      for (const t of tuples) {
        try { await run([t]) } catch (e) {
          if (!isAlreadyConverged(e)) throw e
        }
      }
    }
  }
  await converge(added, 'write')
  await converge(removed, 'delete')
}
