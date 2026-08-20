// #536 review point 7: what the merged picker DOES when Add is clicked, as a value.
//
// The group bug lived inside the click handler: a principal string was assembled inline, it was
// well-formed, and nothing could test it short of driving the whole component — which this repo has no
// harness for (component-testing would be a new dependency, i.e. a license-gated decision). So the
// decision is separated from its execution: this resolves a picker state to the ACTION the handler will
// take, and the handler only executes it. The four combinations (user/group × built-in/custom) become
// plain values a test can hold.
//
// The group rule is structural here: a group action carries the NAME, never a principal. The FGA id is a
// tenant-salted hash only the server can derive (`groupGrantee`); the one time this file's caller built
// `group:<name>#member` itself, the write succeeded, the toast said so, and nobody gained anything.

export type GrantTarget =
  | { kind: "user"; principal: string }
  | { kind: "group"; groupName: string };

export type GrantAction =
  | { path: "grant"; capability: string; target: GrantTarget }
  // #553 / ADR-199 §2: the editor NOUN is a composite — N single-capability built-in grants in one
  // server transaction (the wire's `relations` array). Only where the noun is offered; every other
  // built-in stays the single-capability grant it always was.
  | { path: "grant-composite"; capabilities: string[]; target: GrantTarget }
  | { path: "assign"; roleId: string; target: GrantTarget }
  | { path: "none" };

// The noun → bundle table. editor is the one built-in whose display bundle exceeds what its single
// capability delivers post-ADR-199 (comment is the severed implication; view/publish still flow from
// the edit chain in the model).
export const COMPOSITE_BUILTINS: Record<string, string[]> = { edit: ["edit", "comment"] };


// #607 (user ruling): "Dev User" appeared twice, which reads as a bug. The roster answers one row per
// CAPABILITY, and the screen drew them straight through — so the space's owner appeared twice, once as
// manager and once as viewer. "1 principal = 1 role" (#536 / #579) is the settled shape of this product;
// a screen that shows one person wearing two is showing the thing those rulings removed.
//
// This is the editor fold above, generalised: that one already merged a principal's `edit` and `comment`
// arms into a single row whose revoke takes both. The same rule now applies to whatever else a principal
// holds, so there is one mechanism rather than a special case for one pair.
//
// Strongest first. `manage` subsumes everything (it is the built-in superset, and the owner's structural
// mark). The severable admin-class verbs come next — each confers something `edit` does not, and none is
// implied by another. The tail is the model's own implication chain, moderate → edit → comment → view.
const CAP_STRENGTH = ["manage", "moderate", "manageAccess", "delete", "share", "settings", "edit", "comment", "view"];
const strength = (cap: string): number => {
  const i = CAP_STRENGTH.indexOf(cap);
  return i === -1 ? CAP_STRENGTH.length : i; // an unknown capability sorts last rather than winning
};

/** One entry per principal: the row that represents them, and everything it stands for. */
export function foldGrantsByPrincipal<T extends { grantee: string; capability: string }>(
  grants: readonly T[],
): { row: T; foldedCaps: string[] }[] {
  const byPrincipal = new Map<string, T[]>();
  for (const g of grants) byPrincipal.set(g.grantee, [...(byPrincipal.get(g.grantee) ?? []), g]);
  return [...byPrincipal.values()].map((held) => {
    const ordered = [...held].sort((a, b) => strength(a.capability) - strength(b.capability));
    // The revoke set is everything this row now stands for — otherwise folding would quietly make the
    // weaker grants unremovable, which is the failure the editor fold was written to avoid.
    return { row: ordered[0]!, foldedCaps: ordered.map((g) => g.capability) };
  });
}

// The revoke set for a rendered grant row: a folded editor row revokes what the noun granted.
export function revokeCapsForRow(row: { capability: string; foldedCaps?: string[] }): string[] {
  return row.foldedCaps ?? [row.capability];
}

export function resolveGrantDispatch(args: {
  pick: string; // "builtin:<capability>" | "role:<roleId>" — the merged picker's value
  mode: "user" | "group";
  picked: { grantee: string } | null; // member mode: the chosen member, principal ALREADY formed upstream
  groupName: string; // group mode: the raw name the server derives the id from
  // #582 / ADR-202 §1: the PAGE grant route takes one relation per call where the space route takes an
  // array, and ADR-199 settled which surface carries the noun — "Space scope only — the page dialog
  // offers bare capabilities, no role noun". So the fold is suppressed here rather than silently
  // dropping `comment` from a composite the caller cannot execute.
  noComposite?: boolean;
}): GrantAction {
  const target: GrantTarget | null =
    args.mode === "group"
      ? (args.groupName ? { kind: "group", groupName: args.groupName } : null)
      : (args.picked ? { kind: "user", principal: args.picked.grantee } : null);
  if (!target) return { path: "none" };

  if (args.pick.startsWith("role:")) {
    const roleId = args.pick.slice("role:".length);
    return roleId ? { path: "assign", roleId, target } : { path: "none" };
  }
  if (args.pick.startsWith("builtin:")) {
    const capability = args.pick.slice("builtin:".length);
    if (!capability) return { path: "none" };
    const bundle = args.noComposite ? undefined : (Object.hasOwn(COMPOSITE_BUILTINS, capability) ? COMPOSITE_BUILTINS[capability] : undefined);
    if (bundle) return { path: "grant-composite", capabilities: bundle, target };
    return { path: "grant", capability, target };
  }
  // an unrecognised value grants nothing rather than guessing a mechanism
  return { path: "none" };
}

// #497 (088): the same decision-as-a-value rule for the space MAPPING picker. A mapping confers either
// a built-in (space scope, four nouns — no commenter, the ruling lives server-side too) or a
// custom role; the wire carries builtinCapability XOR roleId. An unrecognised value maps nothing.
export type MappingAction =
  | { kind: "builtin"; builtinCapability: string }
  | { kind: "role"; roleId: string }
  | { kind: "none" };

export function resolveMappingDispatch(pick: string): MappingAction {
  if (pick.startsWith("builtin:")) {
    const builtinCapability = pick.slice("builtin:".length);
    return builtinCapability ? { kind: "builtin", builtinCapability } : { kind: "none" };
  }
  if (pick.startsWith("role:")) {
    const roleId = pick.slice("role:".length);
    return roleId ? { kind: "role", roleId } : { kind: "none" };
  }
  return { kind: "none" };
}
