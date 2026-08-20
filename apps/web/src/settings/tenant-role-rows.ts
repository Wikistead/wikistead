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
// The dispatch lives here as pure data, for the reason #536taught: the bug that granted a role
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
   *  assignment (the server's unassign is reference-counted,) and two roles can share a
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
      // the explicit orphan label and keeps its revoke — never the raw hash (#536⑥)
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
// is decided here, so the component executes rather than infers (the #536rule).
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

// #579 (2026-08-03 ruling): "add a role" is the wrong idiom — roles cannot be held twice. The control shows what
// the member IS and changing it replaces — the server converges at tenant scope now, so the UI cannot
// keep pretending otherwise. That makes the option list the WHOLE vocabulary (every tier, every tenant
// role), not "the ones they lack": a picker that hides the current value has nothing to display as its
// value, which is exactly how chips grew here in the first place.
/**
 * #582 (review rejection ①): a TIER may now say what it confers, because there is finally something honest
 * to say. `admin` is structural (`… or admin` in the model, true in every tenant) and measured in
 * TENANT_TIER_CAPS. `member` is NOT: `createSpaces` / `issueApiKeys` ride a `tenant#member` tuple that
 * each tenant switches on or off, so a static list would state, in a tenant that turned the switch off,
 * that members can create spaces. That is precisely the "confident falsehood" ADR-203 §4 forbids.
 *
 * So `member`'s list is passed IN by the caller, from the tenant's live defaults. A caller that does not
 * have them passes nothing and the member tier stays bare — absence of a source is what makes the panel
 * absent, rather than a list of exceptions kept somewhere.
 */
export function roleOptions(
  allRoles: readonly TenantRoleDef[],
  tierCaps?: { member?: readonly string[]; admin?: readonly string[] },
): { value: string; label: string; roleCapabilities?: readonly string[] }[] {
  return [
    // #579's round of this landed as #582's (the same reject was filed on both tickets, and that one
    // shipped first). Its shape is kept whole because it is the more careful of the two: `member`'s
    // list comes from the tenant's LIVE defaults rather than the measured constant, so a tenant that
    // switched space creation off does not read "members can create spaces".
    ...BUILT_IN_TIERS.map((tier) => {
      const caps = tierCaps?.[tier as "member" | "admin"];
      return caps ? { value: `tier:${tier}`, label: tier, roleCapabilities: caps } : { value: `tier:${tier}`, label: tier };
    }),
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

/** The grants on a group row this console may take away.
 *
 *  #643: the revocation moved out of the role picker (where choosing the placeholder quietly performed
 *  it) and into the row's ⋯ menu. It is a function rather than an inline filter so the skip travels with
 *  it: a MACHINE-held grant is not this console's to remove (ADR-183 §1 — what a directory writes, the
 *  directory takes back), and that condition is the part a rewrite at the new call site would drop.
 *
 *  It also decides whether the menu appears at all: a group with nothing revocable gets no ⋯, rather
 *  than a menu whose only item could not work (#606's always-failing button). */
export function revocableGroupGrants(row: GroupRoleRow | undefined): GroupRoleRow["held"] {
  return (row?.held ?? []).filter((h) => !h.managed);
}

/**
 * #603 (review rejection 2026-08-05): what each GROUP confers, by name — the member rows join against this
 * to say "<role> (via <group>)".
 *
 * It used to collect only the groups holding `admin`, so a member whose group gave them a custom tenant
 * role held the capability with nothing on screen saying where it came from. Once groups can carry any
 * tenant role, singling out `admin` is the same "one framework, two treatments" this family of rulings
 * keeps removing.
 *
 * Mechanism, not label: a built-in is read from `builtin` (so a custom role NAMED "admin" cannot pass
 * as the tier) and a custom one from its own name.
 */
export interface GroupConferredRole {
  /** what the member gets — a tier name or a custom role's name */
  role: string;
  /** the group that confers it */
  group: string;
  /** the tier, when this is a built-in; absent for a custom role (drives the capability panel) */
  builtin?: string;
  /** the custom role's capabilities, when this is one */
  capabilities?: readonly string[];
}

export function groupConferredRoles(
  assignments: readonly TenantAssignment[],
  // the custom roles' definitions, so a badge can raise the same capability panel a picker option does.
  // Absent is fine: the badge still names the role, it just has nothing extra to reveal.
  roles: readonly TenantRoleDef[] = [],
): GroupConferredRole[] {
  const byId = new Map(roles.map((r) => [r.id, r]));
  const out: GroupConferredRole[] = [];
  for (const a of assignments) {
    if (!a.principal.startsWith("group:") || !a.groupName) continue;
    if (a.builtin) { out.push({ role: a.builtin, group: a.groupName, builtin: a.builtin }); continue; }
    const caps = a.roleId ? byId.get(a.roleId)?.capabilities : undefined;
    out.push({ role: a.roleName, group: a.groupName, ...(caps ? { capabilities: caps } : {}) });
  }
  return out;
}

// #591 tried the other shape here — a dropdown for the tier and a separate control for adding custom
// roles — and #579's third ruling reverted it: "the row asks two questions" is true, but the answer is
// one picker with a label that does not say "add", not two controls. `tierOptions` and
// `addableRoleOptions` went with it; `pickerOptions` above is what the row uses, and it is the only
// list-builder there is, so a second control cannot quietly grow its own list again.

/**
 * #579 (ruling ①, 2026-08-03): no separate "group roles" section — fold groups into the Members list,
 * so user names and group names sit side by side as peers.
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
  /** #603: every role a group confers on this member — one badge each, so two groups giving two roles
   *  read as two facts rather than one badge with a comma in it. */
  groupRoles?: GroupConferredRole[];
  /** groups only — its assignments, tiers included (#603 / ADR-207 overturned ADR-201 §1) */
  group?: GroupRoleRow;
  /** the group's name as typed, if the directory has not produced it yet */
  unconfirmed?: boolean;
}

export function buildUnifiedRows(
  members: readonly RowMember[],
  groups: readonly GroupRoleRow[],
  unconfirmedPrincipals: ReadonlySet<string> = new Set(),
  conferred: readonly GroupConferredRole[] = [],
): UnifiedRow[] {
  const rows: UnifiedRow[] = [
    ...members.map((m) => {
      const carried = new Set(m.groups ?? []);
      // one badge per (role, group) pair the member's groups confer — not one badge listing groups,
      // which had nowhere to put a second ROLE
      const groupRoles = conferred.filter((c) => carried.has(c.group));
      return {
        key: `user:${m.sub}`,
        kind: "user" as const,
        label: m.display_name || m.email || m.sub,
        sub: m.sub,
        ...(groupRoles.length ? { groupRoles } : {}),
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
