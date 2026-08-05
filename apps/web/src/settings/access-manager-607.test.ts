// #607 / ADR-209: the client half of the membership verb, pinned pure (the server route test measures
// the gates against a real store; this pins what the SCREEN offers and withholds).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GRANTABLE_FOR, GRANTABLE } from "./SpaceMembersTab";
import { CAP_NOUN, capNoun, BUILTIN_EFFECTIVE_CAPS } from "./role-nouns";

describe("#607: the picker's offer depends on the caller", () => {
  it("a manager sees the four tiers; a weaker caller only the roster verbs", () => {
    // The manager's list briefly grew four single-verb nouns (#604 C / #607). The 2026-08-05 ruling took
    // them back out on an edition boundary — composing one verb is a CUSTOM ROLE, and custom roles are
    // EE — so the built-in picker is the four tiers again on BOTH branches of this function.
    expect(GRANTABLE_FOR(true)).toEqual([...GRANTABLE]);
    expect(GRANTABLE_FOR(false), "no admin-class noun is offered to a non-manager").toEqual(["view", "edit"]);
    for (const c of GRANTABLE_FOR(false)) {
      expect(["moderate", "manage", "manageAccess", "delete", "share", "settings"], `403-bound option ${c} must not be offered`).not.toContain(c);
    }
    // and the free door offers no single-verb noun to ANYONE — the check that would have caught the
    // edition slip, asked of every branch rather than of the one that happened to be wrong
    for (const caller of [true, false]) {
      for (const c of GRANTABLE_FOR(caller)) {
        expect(["manageAccess", "delete", "share", "settings"],
          `${c} is a paid composition — the built-in picker must not hand it out`).not.toContain(c);
      }
    }
  });

  it("the capability keeps its noun, because a role that bundles it still renders in the roster", () => {
    // The NOUN survives the built-in's removal on purpose: a custom role carrying `manageAccess` writes
    // the same tuple, and the roster reverse-maps it. Dropping the noun here would render a raw verb in
    // a row the product can still produce — the display gap #529 pinned from the other side.
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
