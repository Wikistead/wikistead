import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CAP_NOUN, capNoun } from "./role-nouns";
import { fileURLToPath } from "node:url";

// #529 review rejection: "why is a role that isn't in the roles list showing up here?". The space grant
// picker offered `commenter` while the Roles tab's built-in list (server: viewer / editor / moderator /
// manager) did not contain it — one product, two answers to "what roles are there". The standing ruling
// was that the built-in set is not changing yet, so the picker is what gives, and the capability keeps
// working server-side until #514 / ADR-188 §6 merges built-in and custom roles into one assignment UI.
//
// Two DIFFERENT lists have to stay different for the right reasons, which is what this pins: a grant row
// can HOLD a comment grant (made through the API, or before this change) and must still sort correctly,
// while the picker must not OFFER anything the roles list does not name.
const SRC = readFileSync(fileURLToPath(new URL("./SpaceMembersTab.tsx", import.meta.url)), "utf8");

// #582 bounce: the table moved to role-nouns.ts so the page dialog reads the same one. Re-aimed as the
// pin's own note instructed — and now it reads the VALUE rather than parsing a literal, which is the
// stronger form: a rename of the module cannot make it pass vacuously.
const nounKeys = (): string[] => Object.keys(CAP_NOUN);
const listOf = (name: string): string[] => {
  const m = SRC.match(new RegExp(`const ${name}: PageRelation\\[\\] = \\[([^\\]]*)\\]`));
  if (!m) throw new Error(`${name} not found — the lists were renamed; re-aim this pin rather than deleting it`);
  return m[1]!.split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean);
};

// The server's built-in roles, READ FROM THE SERVER rather than restated here — #536 added `commenter`
// to that list, and a hand-copied constant would have gone stale silently, which is the same "two voices"
// failure this file exists to prevent (just moved into the test). Now the pin compares the two real
// surfaces, so either one changing alone is what turns it red.
const ROLES_SRC = readFileSync(
  fileURLToPath(new URL("../../../../apps/server/src/routes/roles.ts", import.meta.url)),
  "utf8",
);
// [a-z-]: `access-manager` and `settings-editor` carry hyphens, and the hyphenless pattern silently
// dropped them from the parse — the pin's both-ways check was blind to exactly the roles this ticket
// family added (#604 C found it: access-manager had been escaping the comparison since #607).
const BUILT_IN_ROLE_NOUNS = [...ROLES_SRC.matchAll(/\{\s*name:\s*'([a-z-]+)',\s*capabilities:/g)].map((m) => m[1]!);

describe("#529: the space grant picker offers exactly the roles the Roles tab lists", () => {
  it("reads a non-empty built-in list from the server (a broken match must not pass vacuously)", () => {
    expect(BUILT_IN_ROLE_NOUNS.length).toBeGreaterThanOrEqual(4);
    expect(BUILT_IN_ROLE_NOUNS).toContain("manager");
    expect(BUILT_IN_ROLE_NOUNS, "the hyphen fix is not vacuous").toContain("access-manager");
  });

  // #607/#604 C: the picker is caller-dependent now, so the list the pin compares is the MANAGER's —
  // the widest one, the one that must equal the Roles tab. The narrowed non-manager list is pinned in
  // access-manager-607.test.ts (an option the server 403s is not an option).
  const managerOffer = (): string[] => {
    const m = SRC.match(/callerManages \? \[\.\.\.GRANTABLE, ([^\]]*)\]/);
    if (!m) throw new Error("GRANTABLE_FOR's manager branch not found — re-aim this pin rather than deleting it");
    return [...listOf("GRANTABLE"), ...m[1]!.split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean)];
  };

  it("offers no capability whose noun is absent from the built-in roles", () => {
    const offered = managerOffer().map((c) => capNoun(c));
    expect(offered.filter((n) => !BUILT_IN_ROLE_NOUNS.includes(n))).toEqual([]);
  });

  it("…and names every built-in role it lists — the check runs BOTH ways", () => {
    // One direction only was still one voice able to move alone: adding a built-in on the server kept this
    // file green while the picker said nothing about it, which is the same mismatch from the other side.
    const offered = managerOffer().map((c) => capNoun(c));
    expect(BUILT_IN_ROLE_NOUNS.filter((n) => !offered.includes(n)),
      "a built-in role the picker cannot grant").toEqual([]);
  });

  // #536①: CAP_ORDER (the capability-power sort) is gone — the merged list sorts by principal
  // label, which is capability-independent. The surviving invariant is the DISPLAY set: every capability
  // a row can hold (offered or API-made) must have a noun, or the row renders a raw verb.
  it("still NAMES a comment grant (an API-made row renders its noun, not a raw verb)", () => {
    expect(nounKeys()).toContain("comment");
  });

  it("keeps the picker a subset of the display set (a row can render anything it offers)", () => {
    const named = nounKeys();
    expect(listOf("GRANTABLE").filter((c) => !named.includes(c))).toEqual([]);
  });
});
