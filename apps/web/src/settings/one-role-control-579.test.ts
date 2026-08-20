// #579 (third ruling): one control chooses a role. Discovery, not a list of screens.
//
// This exact regression has now happened twice in opposite directions. #579 merged a Select and a
// "+ Role" button into one picker; #591 read "just one dropdown" as "give the tier its own dropdown"
// and split it again; the user's answer each time was the same sentence. A pin that named the two
// testids involved would have been green for #591's shape, so this one looks for the SHAPE of the
// mistake instead: a screen that offers two ways to choose a role for the same thing.
//
// How it decides, and what it cannot see: it reads the settings sources for the testids of controls
// that choose a role, and refuses a file that carries more than one of them per target. Targets are
// distinguished by the prefix a screen already uses (`member-…` is the member row, `invite-…` is the
// invite form, `space-member-…` is the space row, `space-grant-…` is the space add-form) — a screen
// that adds a NEW prefix gets its own target for free, which is the discovery half. What it cannot
// see is a second control that shares a prefix with the first and picks something other than a role;
// the e2e pin (`one-role-control-579.spec.ts`) counts the real DOM inside one row for that.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve(import.meta.dirname, ".");

/** Every testid a settings screen declares, in either shape (`data-testid=` on a DOM node, `testId=`
 *  on a DS component — the second is how MembersPage names its Select, so a scan that reads only the
 *  first sees nothing at all on the screen this pin exists for). */
const TESTIDS = /(?:data-)?test[iI]d=["`{]+([a-z0-9-]+)["`]/g;

/** A control that CHOOSES a role for someone: a role/tier picker, or an "add a role" affordance. A
 *  chip, a badge, a revoke ×, a role DEFINITION row (AdminRolesTab lists the roles themselves) are not
 *  choices — they show or edit a role, they do not hand one to a principal. */
const CHOOSES_A_ROLE = (id: string): boolean =>
  /(^|-)(role|tier)(-|$)/.test(id) &&
  (/(select|picker|add)/.test(id) || /^(invite|member)-role(-id)?$/.test(id));

function roleControlsByTarget(src: string): Map<string, Set<string>> {
  const byTarget = new Map<string, Set<string>>();
  for (const m of src.matchAll(TESTIDS)) {
    const id = m[1]!;
    if (!CHOOSES_A_ROLE(id)) continue;
    // The target is the prefix a screen already uses for one thing: `member-role-select` and
    // `member-tier-select` are both the member row; `invite-role` and `invite-role-id` are both the
    // invite form; `space-member-role-select` is the space row. A screen that introduces a NEW prefix
    // gets its own target without this file being edited, which is the discovery half.
    const target = id.replace(/-?(role|tier).*$/, "") || id;
    if (!byTarget.has(target)) byTarget.set(target, new Set());
    byTarget.get(target)!.add(id);
  }
  return byTarget;
}

describe("#579: one target, one role control", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".tsx"));

  it("finds the settings screens that choose roles at all (the scan is not vacuous)", () => {
    const screens = files.filter((f) => roleControlsByTarget(readFileSync(resolve(DIR, f), "utf8")).size > 0);
    expect(screens, "MembersPage and SpaceMembersTab both choose roles").toEqual(
      expect.arrayContaining(["MembersPage.tsx", "SpaceMembersTab.tsx"]),
    );
  });

  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".tsx"))) {
    it(`${file}: no target offers two ways to choose a role`, () => {
      const src = readFileSync(resolve(DIR, file), "utf8");
      for (const [target, ids] of roleControlsByTarget(src)) {
        expect([...ids].sort(), `${file}: "${target}" has ${ids.size} role controls — pick one`).toHaveLength(1);
      }
    });
  }
});

// #579 (2026-08-03 ruling): "adding a role" is not a thing here — the vocabulary goes with the concept.
//
// The control is now a single Select whose value is the role the member has, so there is nothing to
// "add": choosing a different value replaces, and the server converges (a71d8100). A screen that still
// says "add" would be describing a mechanism that no longer exists — which is how the chips and the
// "+ Role" button got here in the first place.
describe("#579: the tenant member screen has no ADD-a-role vocabulary left", () => {
  const page = readFileSync(resolve(import.meta.dirname, "./MembersPage.tsx"), "utf8");
  const locales = ["en", "ja"].map((l) => ({
    name: l,
    bundle: JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales", `${l}.json`), "utf8")) as Record<string, Record<string, string>>,
  }));

  it("no add-role control or testid on the member row", () => {
    expect(page).not.toMatch(/member-role-add/);
    expect(page, "the chips went with the set they drew").not.toMatch(/member-role-chip|member-tier-chip/);
  });

  it("no copy that offers to add one", () => {
    for (const { name, bundle } of locales) {
      expect(bundle.members?.addRole, `${name}: "+ Role" is retired`).toBeUndefined();
      expect(bundle.members?.roleChangeOrAdd, `${name}: so is "change or add"`).toBeUndefined();
    }
  });

  it("and the row's control shows a value rather than a placeholder", () => {
    // value="" is the shape of a picker that hides what you have — the thing chips existed to work around
    expect(page).toMatch(/value=\{currentRoleValue\(/);
    expect(page).not.toMatch(/testId="member-role-select"[\s\S]{0,200}value=""/);
  });
});
