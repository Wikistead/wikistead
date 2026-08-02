// #573 / #578: THE last-admin predicate, on its own.
//
// It used to live in admin-mapping.ts, which ADR-201 slice 4 deletes — and it must not go with it: the
// question "would removing this member's admin leave none?" is asked by the member console, by member
// removal, and by SCIM deactivation, none of which have anything to do with group mappings. The ADR
// named moving it as a condition of the retirement for exactly that reason.
import type { Sql } from 'postgres'

// Would demoting `sub` leave the tenant with no admin at all? PATCH /members/:sub refuses that case
// (409 "cannot demote the last admin") and so does this: a tenant locked out of its own administration
// cannot be repaired from inside the product. A group edit in the IdP must not be able to do what the
// admin console explicitly forbids. The stale admin is visible (admin_origin='mapping' with no matching
// mapping) rather than silently retained.
// #573: THE predicate. It had two hand-written twins (members.ts's adminCount, this file's own) and
// the SCIM deactivation was about to be a third — where it was simply absent, so deprovisioning the
// last admin at the IdP locked the tenant out of its own administration, the exact thing the comment
// above forbids. One function, every caller (the #536 "two tables become one" discipline).
// NOTE the sub-exclusion: "would REMOVING this member's admin leave none?" — a deactivated admin
// still carries role='admin', so counting rows without excluding them would answer 'no' forever.
export async function isLastAdmin(sql: Sql, sub: string): Promise<boolean> {
  // #573 re-review NEW-3: the handle must be TENANT-SCOPED. Counting on an unscoped pool would see
  // other tenants' admins and answer "not the last one" — fail-OPEN, the exact direction this guard
  // exists to prevent. RLS does the scoping; this asserts the caller actually set it, because the
  // signature (a bare Sql) cannot.
  const [scope] = await sql<{ t: string | null }[]>`SELECT current_setting('app.tenant_id', TRUE) AS t`
  if (!scope?.t) throw new Error('isLastAdmin: the handle is not tenant-scoped (app.tenant_id unset)')
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM members WHERE role = 'admin' AND sub <> ${sub} AND deactivated_at IS NULL`
  return (row?.n ?? 0) === 0
}
