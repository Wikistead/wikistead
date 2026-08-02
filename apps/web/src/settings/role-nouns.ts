// #582 bounce (user, on the device): " 1 ".
//
// A built-in grant and a custom role are one thing to the person reading a permissions surface: somebody
// wearing a role. The space Members tab has said so since #445 — it renders the capability as the NOUN
// the role is called (view→viewer, manage→manager) beside custom role names, in one picker and one row
// shape. The page dialog moved half of that over in #582 §1 (custom roles in the picker) and left the
// other half behind, so its picker said (a translated verb) while its rows said "manage" (a raw
// wire value) and its role badges shouted "KAKUNIN-582".
//
// The nouns live here so both screens IMPORT the same table. Two hand-written copies is how the last
// three copy pins rotted (#553's GRANTABLE is the fix that worked).
//
// Translation, per the 2026-08-02 ruling: a ROLE NAME is a proper noun and is never translated or
// case-shifted — not the built-ins, not a tenant's own role. A CAPABILITY (what a role may do) IS
// translated, and that vocabulary belongs on the surface that EDITS a role definition, not on one that
// says who holds which role.
export type RoleNounKey = "view" | "comment" | "edit" | "moderate" | "manage";

export const CAP_NOUN: Record<RoleNounKey, string> = {
  view: "viewer",
  comment: "commenter",
  edit: "editor",
  moderate: "moderator",
  manage: "manager",
};

/** The noun for a wire capability; unknown values pass through unchanged (a role name is already one). */
export const capNoun = (c: string): string => CAP_NOUN[c as RoleNounKey] ?? c;

// #586 / ADR-203 §4: what each built-in noun ACTUALLY confers on a page.
//
// Not the bundle its grant writes — the closure the model produces from it. The two differ, and the
// difference is not decoration: `BUILT_IN_ROLES` declares `manager` without `manage` or `moderate` and
// `moderator` as `moderate` alone, because those arrive through leaves (`space#moderator = … or
// manager`) rather than through the grant. The Roles tab renders that declaration today and therefore
// ships one of the errors on screen — a manager with `moderate` unticked.
//
// Replacing a hedge ("editor can also comment") with a confident falsehood is worse than the hedge, so
// this table is MEASURED, not written: `role-capability-truth-586.test.ts` grants each noun in a real
// OpenFGA store and reads back every verb it resolves to, then compares the result with this object. If
// the model changes, that test fails with the new set in the message — the table is a cache of the
// store's answer, and the test is what keeps it honest.
//
// The verbs are page-scoped because that is what these surfaces are about: what this person can do to
// the things in this space. (A moderator's page `edit` is the moderation bypass, not the edit grant
// they have it on a page while not being a space editor, which is precisely the kind of fact a static
// bundle cannot express.)
export const BUILTIN_EFFECTIVE_CAPS: Record<RoleNounKey, readonly string[]> = {
  view: ["view"],
  comment: ["view", "comment"],
  edit: ["view", "comment", "edit", "publish"],
  moderate: ["view", "comment", "edit", "moderate", "publish"],
  manage: ["view", "comment", "edit", "moderate", "publish", "delete", "share", "manage"],
};

/** What to list for a row: a built-in noun's measured closure, or a custom role's own capabilities. */
export const effectiveCaps = (args: { builtinCapability?: string | null; roleCapabilities?: readonly string[] | null }): readonly string[] =>
  args.roleCapabilities?.length
    ? args.roleCapabilities
    : BUILTIN_EFFECTIVE_CAPS[args.builtinCapability as RoleNounKey] ?? (args.builtinCapability ? [args.builtinCapability] : []);
