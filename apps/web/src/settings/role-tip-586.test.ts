// #586 / ADR-203: what a role can do is shown, not explained — and the axis is role vs individual
// grant.
//
// Two things are pinned here, and they are different in kind.
//
// The LIST: `effectiveCaps` answers from the measured table for a built-in and from the role's own
// definition for a custom role. The table itself is checked against a real OpenFGA store on the server
// (`role-capability-truth-586.test.ts`) — that is where the truth lives; this side only pins that the
// UI asks the right question for the right row.
//
// The AXIS: the user's ruling was explicit that the distinction to draw is ROLE-DERIVED vs GRANTED
// INDIVIDUALLY, and that built-in vs custom must NOT become separate lists or sections. Both halves are
// asserted, because the failure mode this ticket keeps hitting is a screen that re-splits them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { effectiveCaps, BUILTIN_EFFECTIVE_CAPS, capNoun } from "./role-nouns";

describe("#586: the list a badge shows", () => {
  it("a built-in row lists the closure, not the word on the badge", () => {
    // `manager` is the case the static bundle gets wrong: BUILT_IN_ROLES declares it without `manage`
    // or `moderate`, because both arrive through model leaves.
    expect(effectiveCaps({ builtinCapability: "manage" })).toContain("manage");
    expect(effectiveCaps({ builtinCapability: "manage" })).toContain("moderate");
    // and a moderator does more than moderate (#330: moderate ⇒ comment, plus the page edit bypass)
    expect(effectiveCaps({ builtinCapability: "moderate" })).toEqual(expect.arrayContaining(["comment", "edit"]));
  });

  it("a custom role IS its capability list", () => {
    expect(effectiveCaps({ roleCapabilities: ["view", "share"] })).toEqual(["view", "share"]);
    // …and a custom role wins over any built-in lookup: it is not a noun, it is a definition
    expect(effectiveCaps({ builtinCapability: "manage", roleCapabilities: ["view"] })).toEqual(["view"]);
  });

  it("an unknown capability lists itself rather than nothing", () => {
    // a row can hold a capability the table has no noun for. Showing the raw verb is honest; showing an
    // empty tooltip would read as "this grants nothing".
    // #604 C re-aim: `settings` was this example until it became a named built-in with a MEASURED row
    // (it now resolves to ["view","settings"], which is the closure, not a fallback). `publish` is the
    // surviving unnamed one — it is edit-class and reaches rows through bundles, never as a noun.
    expect(effectiveCaps({ builtinCapability: "publish" })).toEqual(["publish"]);
    expect(effectiveCaps({})).toEqual([]);
  });

  it("the nouns and the table cover the same built-ins (neither grows without the other)", () => {
    // #607 / ADR-209: manageAccess joined both (noun `access-manager`; measured row in the truth test)
    // #604 C: delete / share / settings joined both (nouns are the model's leaf names)
    expect(Object.keys(BUILTIN_EFFECTIVE_CAPS).sort()).toEqual(["comment", "delete", "edit", "manage", "manageAccess", "moderate", "settings", "share", "view"].sort());
    for (const key of Object.keys(BUILTIN_EFFECTIVE_CAPS)) expect(capNoun(key)).not.toBe(key);
  });
});

describe("#586: role-derived and individually granted are told apart, without being separated", () => {
  const dialog = readFileSync(resolve(import.meta.dirname, "../ui/PermissionsDialog.tsx"), "utf8");
  const spaceTab = readFileSync(resolve(import.meta.dirname, "./SpaceMembersTab.tsx"), "utf8");

  it("the page dialog marks both origins, and they are the two values the ruling named", () => {
    const origins = [...dialog.matchAll(/origin="(\w+)"/g)].map((m) => m[1]);
    expect(new Set(origins), "role-derived and individual grant, nothing else").toEqual(new Set(["role", "grant"]));
  });

  it("the two badges differ by colour, taken from DS tokens rather than a literal", () => {
    const badges = [...dialog.matchAll(/data-testid="grant-role-badge"/g)];
    expect(badges.length, "one badge per row kind").toBe(2);
    expect(dialog, "the role badge wears the accent token").toContain("border-[var(--accent)]");
    expect(dialog.match(/#[0-9a-fA-F]{6}/g) ?? [], "no hex colour anywhere in this dialog").toHaveLength(0);
  });

  it("and they still live in ONE list — the axis is never built-in vs custom", () => {
    // The prohibition, pinned: role rows and grant rows sit inside the same `grant-list` container.
    const list = dialog.slice(dialog.indexOf('data-testid="grant-list"'));
    const roleRow = list.indexOf('data-testid="grant-role-item"');
    const grantRow = list.indexOf('data-testid="grant-item"');
    expect(roleRow, "the role rows are in the same list element").toBeGreaterThan(-1);
    expect(grantRow, "so are the grant rows").toBeGreaterThan(-1);
    // one picker offers both, too (#582's ruling, kept green here so a split shows up as this test)
    expect(dialog).toMatch(/options=\{\[[\s\S]*capNoun\(c\)[\s\S]*assignable\.data\?\.custom/);
  });

  it("the space screen tips its role badges from the same component", () => {
    expect(spaceTab).toContain("<RoleTip");
    expect(spaceTab, "and no second tooltip implementation grew beside it").not.toMatch(/title=\{t\(/);
  });
});

describe("#586: the capability grid shows subsumption instead of explaining it", () => {
  const tab = readFileSync(resolve(import.meta.dirname, "./AdminRolesTab.tsx"), "utf8");

  it("draws the carried capabilities as checked and not operable", () => {
    // #586 review ② re-aim: the subject is "the implied set comes from the ONE measured closure", not
    // the expression that used to spell it out. The tooltips and this grid now call the same function,
    // which is the property that stopped a `moderate`-only role reading two different ways.
    expect(tab, "the implied set is computed through the shared closure").toMatch(/closureOf\(\[held\]\)/);
    expect(tab, "and a carried box cannot be toggled").toMatch(/itemDisabled = disabled \|\| itemLocked \|\| impliedBy !== undefined/);
    expect(tab, "it reads as checked").toMatch(/checked=\{value\.includes\(c\) \|\| impliedBy !== undefined\}/);
  });

  it("says WHICH capability carries it, rather than leaving a mystery tick", () => {
    expect(tab).toMatch(/adminRoles\.impliedBy/);
  });

  it("does not write the implied capabilities into what gets saved", () => {
    // The ruling's reason: an auto-written `comment` is indistinguishable from a deliberate one, and
    // subsumption changes (#553 cut `edit ⇒ comment` this week). The saved set stays what was picked.
    const onChange = /onChange=\{itemDisabled \? undefined : \(e\) => onChange\?\.\(e\.target\.checked \? \[\.\.\.value, c\] : value\.filter\(\(x\) => x !== c\)\)\}/;
    expect(tab, "the only writer is the box the administrator actually clicked").toMatch(onChange);
    expect(tab, "nothing expands the value on save").not.toMatch(/setCaps\(\[\.\.\.caps, \.\.\.BUILTIN_EFFECTIVE_CAPS/);
  });

  it("takes subsumption from the measured table, not a second hand-written one", () => {
    // moderate carries comment; if this ever needs a literal here, the store test is the thing to read.
    expect(BUILTIN_EFFECTIVE_CAPS.moderate).toContain("comment");
    expect(tab.match(/moderate.*=>.*\["comment"/) ?? [], "no local subsumption table").toHaveLength(0);
  });
});
