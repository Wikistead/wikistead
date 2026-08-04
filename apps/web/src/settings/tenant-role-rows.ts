// #579: the member table's role cell, as data.
//
// The screen had two ways to give someone a tenant role: the built-in one was an attribute of the row
// (a Select on the member), the custom one was a separate form above the table with its own member
// search. Same question, two places, and the user found the second one by accident — "oh, THAT's what
// the top half was". The row becomes the only place, which puts an asymmetry on it that the UI has to
// tell the truth about: the built-in role is exactly one (admin XOR member — it is a column on the
// member), while custom roles are a set (each one an assignment row that FGA expands). A single Select
// cannot say that, so the row shows what is held and offers what is not.
//
// The dispatch lives here as pure data, for the reason #536 taught: the bug that granted a role
// to nobody lived in an inline click handler nothing could test. The component executes what these
// functions decide.

export interface TenantAssignment {
  id: string;
  /** null when the row is a BUILT-IN grant (#603 / ADR-207 — a tier has no roles row) */
  roleId: string | null;
  roleName: string;
  /** the tier a built-in grant carries; the MECHANISM, so a custom role named "admin" cannot pass */
  builtin?: string;
  principal: string;
  managed?: boolean;
  groupName?: string;
  groupUnconfirmed?: boolean;
}
export interface TenantRoleDef { id: string; name: string; scope: string; capabilities?: readonly string[] }
export interface RowMember { sub: string; display_name: string | null; email: string | null; role: "admin" | "member"; groups?: string[] | null }

export interface TenantRoleRow {
  sub: string;
  builtin: "admin" | "member";
  /** custom roles this member holds — each keeps its own assignment id, because removal is per
   *  assignment (the server's unassign is reference-counted) and two roles can share a
   *  capability: taking one must not be reported as taking the other. */
  custom: { assignmentId: string; roleId: string; roleName: string; managed: boolean }[];
  /** tenant roles they do NOT hold — the only ones worth offering on this row. */
  addable: TenantRoleDef[];
}

const nameOf = (m: RowMember): string => m.display_name || m.email || m.sub;

/** Filter the member table itself. #557 put a search INSIDE the old assign form; with the form gone
 *  the search belongs to the table, where it also helps every other column. */
export function filterMembers<T extends RowMember>(members: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...members];
  return members.filter((m) => [m.display_name, m.email, m.sub].some((f) => f && f.toLowerCase().includes(q)));
}

export function buildTenantRoleRows(
  members: readonly RowMember[],
  assignments: readonly TenantAssignment[],
  roles: readonly TenantRoleDef[],
): TenantRoleRow[] {
  const tenantRoles = roles.filter((r) => r.scope === "tenant");
  const bySub = new Map<string, TenantAssignment[]>();
  for (const a of assignments) {
    if (!a.principal.startsWith("user:")) continue; // groups are not rows in the member table
    const sub = a.principal.slice("user:".length);
    bySub.set(sub, [...(bySub.get(sub) ?? []), a]);
  }
  return members.map((m) => {
    // a BUILT-IN tenant grant is group-only (#603: a person's tier is their member row), so a user's
    // custom list is exactly the rows that point at a roles entry
    const held = (bySub.get(m.sub) ?? []).filter((a) => a.roleId !== null);
    const heldIds = new Set(held.map((a) => a.roleId));
    return {
      sub: m.sub,
      builtin: m.role,
      custom: held.map((a) => ({ assignmentId: a.id, roleId: a.roleId!, roleName: a.roleName, managed: a.managed === true })),
      // a role they already hold is not addable — assigning it twice is not a second grant, and the
      // server would answer 409 for a question the UI should not have asked
      addable: tenantRoles.filter((r) => !heldIds.has(r.id)),
    };
  });
}

/** Group principals never appear in the member table (there is no member row to hang them on), so the
 *  rows they DO belong to live in their own section — the same split the space screen makes. */
export interface GroupRoleRow { principal: string; label: string; held: { assignmentId: string; roleId: string | null; roleName: string; builtin?: string; managed: boolean }[] }
export function buildGroupRoleRows(
  assignments: readonly TenantAssignment[],
  unknownLabel: string,
  groupSuffix: string,
  // #578 bounce ①: the note for a group the directory has not produced yet. Optional so the two
  // callers that have nothing to say about it read the same as before.
  notSeenLabel?: string,
): GroupRoleRow[] {
  const byPrincipal = new Map<string, GroupRoleRow>();
  for (const a of assignments) {
    if (!a.principal.startsWith("group:")) continue;
    const row = byPrincipal.get(a.principal) ?? {
      principal: a.principal,
      // the server resolves the hash (group-sync.ts is the id authority); an id it cannot name gets
      // the explicit orphan label and keeps its revoke — never the raw hash (#536 ⑥)
      label: a.groupName
        ? `${a.groupName} (${groupSuffix}${a.groupUnconfirmed && notSeenLabel ? `, ${notSeenLabel}` : ""})`
        : `${unknownLabel} (${groupSuffix})`,
      held: [],
    };
    row.held.push({ assignmentId: a.id, roleId: a.roleId, roleName: a.roleName, builtin: a.builtin, managed: a.managed === true });
    byPrincipal.set(a.principal, row);
  }
  return [...byPrincipal.values()];
}

export { nameOf as memberLabel };

// #579 review: the row had TWO controls — a Select for the built-in tier and a separate button
// that opened a second Select for custom roles — and the user asked the same question they asked
// about spaces: why is this two things? The reason given (the tier is exactly one, custom roles are a
// set) is true and is not a reason to split the CONTROL. One picker offers both; what the pick MEANS
// is decided here, so the component executes rather than infers (the #536 rule).
// #582: the built-in tenant tiers, in one place. Their NAMES are proper nouns — not translated, not
// decorated — so every surface renders the same string and a pin can mirror this list instead of
// copying it (the #553 lesson: a hand-written copy rots silently).
export const BUILT_IN_TIERS = ["member", "admin"] as const;

export type RoleChoice =
  | { kind: "tier"; role: "admin" | "member" }
  | { kind: "custom"; roleId: string }
  | { kind: "none" };

/** The picker's value is prefixed by mechanism, so a custom role named "admin" cannot be mistaken for
 *  the built-in tier — the same guard the space picker uses. */
export function resolveRoleChoice(value: string, addable: readonly TenantRoleDef[]): RoleChoice {
  if (value === "tier:admin" || value === "tier:member") {
    return { kind: "tier", role: value.slice("tier:".length) as "admin" | "member" };
  }
  if (value.startsWith("role:")) {
    const roleId = value.slice("role:".length);
    return addable.some((r) => r.id === roleId) ? { kind: "custom", roleId } : { kind: "none" };
  }
  return { kind: "none" };
}

// #579 (2026-08-03 ruling): . The control shows what
// the member IS and changing it replaces — the server converges at tenant scope now, so the UI cannot
// keep pretending otherwise. That makes the option list the WHOLE vocabulary (every tier, every tenant
// role), not "the ones they lack": a picker that hides the current value has nothing to display as its
// value, which is exactly how chips grew here in the first place.
export function roleOptions(allRoles: readonly TenantRoleDef[]): { value: string; label: string; roleCapabilities?: readonly string[] }[] {
  return [
    // #586: a tier carries no capability list — see role-option-tips.tsx for why it stays bare rather
    // than being handed a hand-written one.
    ...BUILT_IN_TIERS.map((tier) => ({ value: `tier:${tier}`, label: tier })),
    ...allRoles.filter((r) => r.scope === "tenant").map((r) => ({ value: `role:${r.id}`, label: r.name, roleCapabilities: r.capabilities })),
  ];
}

/** What the row's control SHOWS: the custom role they hold, else their tier. One value, because there
 *  is one role. A row holding more than one (data from before the convergence) shows the first, and
 *  choosing anything folds the rest — the server sweeps on assign. */
export function currentRoleValue(row: TenantRoleRow): string {
  const held = row.custom[0];
  return held ? `role:${held.roleId}` : `tier:${row.builtin}`;
}

/** The GROUP row's value, in the same mechanism-prefixed shape (#603 / ADR-207: a group holds a tier
 *  now, so its control reads the same vocabulary a person's does — one framework, one prefix rule). */
export function groupRoleValue(row: GroupRoleRow | undefined): string {
  const held = row?.held[0];
  if (!held) return "";
  return held.builtin ? `tier:${held.builtin}` : `role:${held.roleId}`;
}

/** ADR-207 rev3 (#603): the names of the groups that hold `admin` — what the member rows join against
 *  to say "admin (via <group>)". Mechanism, not name: `builtin === "admin"`, never a label match. */
export function adminGroupNames(assignments: readonly TenantAssignment[]): Set<string> {
  const names = new Set<string>();
  for (const a of assignments) {
    if (a.principal.startsWith("group:") && a.builtin === "admin" && a.groupName) names.add(a.groupName);
  }
  return names;
}

// #591 tried the other shape here — a dropdown for the tier and a separate control for adding custom
// roles — and #579's third ruling reverted it: "the row asks two questions" is true, but the answer is
// one picker with a label that does not say "add", not two controls. `tierOptions` and
// `addableRoleOptions` went with it; `pickerOptions` above is what the row uses, and it is the only
// list-builder there is, so a second control cannot quietly grow its own list again.

/**
 *
 * One list. A person and a group are both principals holding a tenant role, and the screen said so with
 * two sections, two shapes and two vocabularies — which is what made the group half look like a
 * different kind of thing with different rules.
 *
 * Pure, so the merge is pinned without a DOM: the ordering, the kind each row carries (what the icon
 * draws), and the fact that a group with no name still gets a row rather than disappearing.
 */
export interface UnifiedRow {
  key: string;
  kind: "user" | "group";
  label: string;
  /** users only — the row's Select needs the member's sub to change their tier */
  sub?: string;
  /** ADR-207 rev3 (#603): the admin-holding groups this person carries. The Select keeps meaning the
   *  row's OWN tier; what a group confers is a marker BESIDE it, named — never a value the control
   *  claims to own (a demotion that changed nothing would be the #596/#536 lie). */
  adminVia?: string[];
  /** groups only — its assignments, tiers included (#603 / ADR-207 overturned ADR-201 §1) */
  group?: GroupRoleRow;
  /** the group's name as typed, if the directory has not produced it yet */
  unconfirmed?: boolean;
}

export function buildUnifiedRows(
  members: readonly RowMember[],
  groups: readonly GroupRoleRow[],
  unconfirmedPrincipals: ReadonlySet<string> = new Set(),
  adminGroups: ReadonlySet<string> = new Set(),
): UnifiedRow[] {
  const rows: UnifiedRow[] = [
    ...members.map((m) => {
      const via = (m.groups ?? []).filter((g) => adminGroups.has(g));
      return {
        key: `user:${m.sub}`,
        kind: "user" as const,
        label: m.display_name || m.email || m.sub,
        sub: m.sub,
        ...(via.length ? { adminVia: via } : {}),
      };
    }),
    ...groups.map((g) => ({
      key: g.principal,
      kind: "group" as const,
      label: g.label,
      group: g,
      unconfirmed: unconfirmedPrincipals.has(g.principal),
    })),
  ];
  // One order for both kinds. Sorting groups to the bottom would rebuild the two sections the ruling
  // removed, only without the headings.
  return rows.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}
