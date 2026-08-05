// #635 (user ruling): became .
//
// The ruling asked for more than a string swap: check that " / / " have not split into
// three words for one action. Measured, they had not — the product uses two words for two DIFFERENT
// mechanisms, and that distinction is worth keeping
//
// / grant a direct FGA tuple (space members, page permissions)
// / assign a `role_assignments` row (custom and tenant roles)
//
// What HAD split was one action across both: the members screen called assigning a tenant role
// while the roles screen called the same thing , and English said "Give a role" against
// "Assign". Same act, three names between the two languages.
import { describe, it, expect } from "vitest";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

type Dict = Record<string, unknown>;
function flatten(d: Dict, p = ""): [string, string][] {
  return Object.entries(d).flatMap(([k, v]) => {
    const n = p ? `${p}.${k}` : k;
    return typeof v === "object" && v !== null ? flatten(v as Dict, n) : [[n, String(v)] as [string, string]];
  });
}

describe("#635: one act, one word", () => {
  it("nothing says 渡す any more", () => {
    // The word the ruling retired. Swept over VALUES rather than looked up by key, since the same word
    // reaching a second key is exactly how it would come back.
    const offenders = flatten(ja as Dict).filter(([, v]) => v.includes("渡す"));
    expect(offenders.map(([k]) => k), "the retired word is back").toEqual([]);
  });

  it("the two screens that assign a tenant role use the same verb", () => {
    // Members and Roles both assign a tenant role; before this they called it and .
    for (const [locale, dict] of [["ja", ja], ["en", en]] as const) {
      const d = Object.fromEntries(flatten(dict as Dict));
      const title = d["members.grantTitle"]!;
      // The STEM, not a fixed casing: English inflects ("Assign a role" / "Tenant role assignments")
      // and matching one spelling would fail on a perfectly consistent screen.
      const stem = locale === "ja" ? "割り当て" : "ssign";
      for (const [key, what] of [
        ["members.grantTitle", "the members screen"],
        ["adminRoles.tenantAssignTitle", "the roles screen"],
        ["adminRoles.groupAssignBody", "the group copy"],
      ] as const) {
        expect(d[key], `${locale}: ${what} should use the assign verb — saw "${d[key]}"`).toContain(stem);
      }
      expect(title, `${locale}: the members screen title exists`).toBeTruthy();
    }
  });

  it("grant is still its own word — this unified one act, it did not flatten two", () => {
    // A sweep that turned every into would pass the test above and lose a real distinction
    // a direct tuple is not a role assignment, and the screens that hand out direct access say so.
    const d = Object.fromEntries(flatten(ja as Dict));
    expect(d["spaceMembers.body"], "space access is still granted, not assigned").toContain("付与");
    expect(d["permissions.body"], "page access likewise").toContain("付与");
  });

  it("both locales carry every key this touched (no orphans, either direction)", () => {
    const E = Object.fromEntries(flatten(en as Dict));
    const J = Object.fromEntries(flatten(ja as Dict));
    for (const k of ["members.grantTitle", "adminRoles.tenantAssignTitle", "adminRoles.groupAssignBody", "adminRoles.tenantAssignBody"]) {
      expect(E[k], `en is missing ${k}`).toBeTruthy();
      expect(J[k], `ja is missing ${k}`).toBeTruthy();
    }
  });
});
