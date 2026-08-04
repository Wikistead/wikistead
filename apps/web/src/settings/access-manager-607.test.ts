// #607 / ADR-209: the client half of the membership verb, pinned pure (the server route test measures
// the gates against a real store; this pins what the SCREEN offers and withholds).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GRANTABLE_FOR, GRANTABLE } from "./SpaceMembersTab";
import { CAP_NOUN, capNoun, BUILTIN_EFFECTIVE_CAPS } from "./role-nouns";

describe("#607: the picker's offer depends on the caller", () => {
  it("a manager sees everything plus the new noun; an access-manager only the roster verbs", () => {
    expect(GRANTABLE_FOR(true)).toEqual([...GRANTABLE, "manageAccess"]);
    expect(GRANTABLE_FOR(false), "no admin-class noun is offered to a non-manager").toEqual(["view", "edit"]);
    for (const c of GRANTABLE_FOR(false)) {
      expect(["moderate", "manage", "manageAccess"], `403-bound option ${c} must not be offered`).not.toContain(c);
    }
  });

  it("the noun is the ruled one, and the tables carry it", () => {
    expect(CAP_NOUN.manageAccess).toBe("access-manager");
    expect(capNoun("manageAccess")).toBe("access-manager");
    expect(BUILTIN_EFFECTIVE_CAPS.manageAccess, "the measured row exists (truth test keeps it honest)").toBeDefined();
  });
});

describe("#607: a row this caller may not move is a badge, not a control", () => {
  it("the list renders locked rows read-only and drops their revoke", () => {
    const src = readFileSync(resolve(import.meta.dirname, "./SpaceMembersTab.tsx"), "utf8");
    expect(src, "the locked state joins the managed rendering").toContain("r.managed || r.locked");
    expect(src, "locked comes from the server's per-row signal, not a client guess").toContain("locked: g.revocable === false");
    expect(src, "the revoke affordance goes, not just greys").toMatch(/r\.locked \? \(\s*\/\*[^]*?\*\/\s*null/);
  });
});
