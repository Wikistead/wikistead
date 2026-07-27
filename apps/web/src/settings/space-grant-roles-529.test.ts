import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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

const listOf = (name: string): string[] => {
  const m = SRC.match(new RegExp(`const ${name}: PageRelation\\[\\] = \\[([^\\]]*)\\]`));
  if (!m) throw new Error(`${name} not found — the lists were renamed; re-aim this pin rather than deleting it`);
  return m[1]!.split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean);
};

// The server's built-in roles (apps/server/src/routes/roles.ts BUILT_IN_ROLES) as the Roles tab shows them.
const BUILT_IN_ROLE_NOUNS = ["viewer", "editor", "moderator", "manager"];
const NOUN: Record<string, string> = { view: "viewer", comment: "commenter", edit: "editor", moderate: "moderator", manage: "manager" };

describe("#529: the space grant picker offers exactly the roles the Roles tab lists", () => {
  it("offers no capability whose noun is absent from the built-in roles", () => {
    const offered = listOf("GRANTABLE").map((c) => NOUN[c] ?? c);
    expect(offered.filter((n) => !BUILT_IN_ROLE_NOUNS.includes(n))).toEqual([]);
  });

  it("still ORDERS a comment grant, so an existing one does not float to the top", () => {
    expect(listOf("CAP_ORDER")).toContain("comment");
  });

  it("keeps the picker a subset of the orderable set (a row can hold anything it offers)", () => {
    const order = listOf("CAP_ORDER");
    expect(listOf("GRANTABLE").filter((c) => !order.includes(c))).toEqual([]);
  });
});
