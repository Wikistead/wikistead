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
export type RoleNounKey = "view" | "comment" | "edit" | "moderate" | "manage" | "manageAccess";

export const CAP_NOUN: Record<RoleNounKey, string> = {
  view: "viewer",
  comment: "commenter",
  edit: "editor",
  moderate: "moderator",
  manage: "manager",
  // ADR-209 (#607): the membership verb (user ruling: noun `access-manager`, wire `manageAccess`)
  manageAccess: "access-manager",
};

/**
 * The capability a built-in ROLE NAME stands for — the inverse of `CAP_NOUN`, derived from it so the two
 * cannot drift. A surface that has a built-in's NAME (the roles list gets `manager`, not `manage`) needs
 * this to reach the measured tables below.
 */
const NOUN_CAP = Object.fromEntries(Object.entries(CAP_NOUN).map(([cap, noun]) => [noun, cap])) as Record<string, RoleNounKey>;
export const nounCapability = (roleName: string): RoleNounKey | undefined => NOUN_CAP[roleName];

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
  // `settings` measured in (#586): the grid draws a settings column, and a manager settles pages
  // (`page#settings: manage or …`) — a column the measurement did not cover was a lie waiting to be drawn.
  manage: ["view", "comment", "edit", "moderate", "publish", "delete", "share", "settings", "manage"],
  // ADR-209 (#607,bounce): view is the page-axis answer (the space viewer arm); manageAccess is
  // the verb ITSELF, measured on the space axis where the grant lives. Every row here is reflexive
  // `manage` lists manage — and this one drew as view-only because the page loop cannot see a
  // space-only verb: the role that exists to hand out membership looked identical to `viewer` in the
  // very picker that hands it out.
  manageAccess: ["view", "manageAccess"],
};

// #586 review ①: what a PAGE grant of a single relation confers — a different question, so a different
// table.
//
// The page dialog grants ONE capability per row (`grantPageAccess` writes `capabilities: [relation]`),
// so its rows are single arms, all of them. Reading their badge out of the noun table above said a page
// `edit` grant could comment; the store says it cannot, and `role-capability-truth-586` pins exactly
// that. Replacing a hedge with a confident falsehood is the landing ADR-203 §4 named as the worst one,
// and this was a live instance of it.
//
// Measured, like its sibling: the same test grants each relation on a real page in a real store and
// reads back every verb, then compares. Both tables are caches of the store's answer.
export const PAGE_GRANT_CAPS: Record<RoleNounKey, readonly string[]> = {
  view: ["view"],
  comment: ["view", "comment"],
  // no `comment`: the arm the review caught. Its sibling above lists one, because a space editor is a
  // composite that includes the comment arm.
  edit: ["view", "edit", "publish"],
  moderate: ["view", "comment", "edit", "moderate", "publish"],
  // no `moderate` either, and that one is a surprise: the space MANAGER noun moderates (it arrives
  // through `space#moderator = … or manager`), but a page manage grant does not reach that leaf.
  manage: ["view", "comment", "edit", "publish", "delete", "share", "settings", "manage"],
  // #607: a PAGE has no manageAccess grant — the verb is space-only. The row exists because the type is
  // total; a page surface can never draw it (grantPageAccess refuses the relation).
  manageAccess: [],
};

// #586what the TENANT TIERS confer.ruled "no table without a measurement", and back then
// there was nothing to measure — two independent leaves. #604 changed the premise by carving verbs out of
// `admin` as `… or admin` unions, so what `admin` confers is a closure again, and the roles list was
// still drawing the two-leaf declaration. Measured like its siblings: role-capability-truth-586 grants
// each tier in a real store and reads back every tenant verb.
export const TENANT_TIER_CAPS: Record<"admin" | "member", readonly string[]> = {
  admin: ["createSpaces", "issueApiKeys", "manageConnections", "manageRoles", "viewAudit"],
  // Measured, with a precision that matters: this is NOT the tier's own structure. `space_creator`
  // accepts a `tenant#member` TUPLE — a per-tenant policy switch, seeded on by default — so what the
  // member tier confers depends on configuration, and this row records the default. The admin row above
  // IS structural (`… or admin` in the model, true in every tenant).
  member: ["createSpaces"],
};

/** Display order, so the same set reads the same wherever it appears. */
const CAP_ORDER = ["view", "comment", "edit", "moderate", "publish", "delete", "share", "settings", "manage"];

/**
 * What a held set really confers: each capability plus everything it subsumes, per the measured table
 * for that scope.
 *
 * #586 review ②: a custom role used to be listed as its DECLARED capabilities, while the role editor
 * showed the closure — so a `moderate`-only role read as one line in a tooltip and as five ticked boxes
 * in the editor. Same role, two answers, depending on which screen you were standing on. One function
 * now, so there is one answer.
 */
export function closureOf(held: readonly string[], table: Record<string, readonly string[]> = BUILTIN_EFFECTIVE_CAPS): readonly string[] {
  const out = new Set<string>();
  for (const h of held) {
    out.add(h);
    for (const c of table[h] ?? []) out.add(c);
  }
  return [...CAP_ORDER.filter((c) => out.has(c)), ...[...out].filter((c) => !CAP_ORDER.includes(c))];
}

/**
 * What to list for a row.
 *
 * `scope` decides WHICH measured table answers, and it is not a detail: a space row holds a built-in
 * NOUN (a composite), a page row holds a single ARM. Looking a page row up in the noun table told a
 * reader that a page `edit` grant could comment — the store says otherwise, and the review caught it.
 */
export const effectiveCaps = (args: {
  builtinCapability?: string | null;
  roleCapabilities?: readonly string[] | null;
  scope?: "space" | "page" | "tenant";
}): readonly string[] => {
  // TENANT capabilities (createSpaces / issueApiKeys) are independent leaves — one capability, one
  // relation, nothing subsumed. `tenant-role-converges-579` measures that 1:1 in a real store. So the
  // closure is the empty table rather than the space one: borrowing a table from another scope is how
  // the page rows came to claim `comment` (review ①).
  const table: Record<string, readonly string[]> = args.scope === "tenant" ? {} : args.scope === "page" ? PAGE_GRANT_CAPS : BUILTIN_EFFECTIVE_CAPS;
  if (args.roleCapabilities?.length) return closureOf(args.roleCapabilities, table);
  if (!args.builtinCapability) return [];
  return table[args.builtinCapability as RoleNounKey] ?? [args.builtinCapability];
};

/**
 * What the roles list should TICK for a built-in role, given the columns that screen draws.
 *
 * The screen used to render the server's declared bundle, and that bundle is the very thing ADR-203 §4
 * called a lie: `manager` is declared without `manage`, so nothing carried it to `moderate` and the grid
 * showed a manager who cannot moderate. The store says otherwise, and the store is what this reads —
 * through the measured table, filtered to the columns the grid actually has (`manage` has no column, by
 * the ruling that keeps the display vocabulary apart from the grantable one).
 */
export function builtinDisplayCaps(roleName: string, columns: readonly string[]): string[] {
  const key = nounCapability(roleName);
  if (!key) return [];
  return BUILTIN_EFFECTIVE_CAPS[key].filter((c) => columns.includes(c));
}
