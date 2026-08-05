// #607 (review rejection): the client half — a row whose PRINCIPAL this caller may not move draws as
// a badge, not a control.
//
// The two signals are deliberately not folded together, and the pin says which drives which. Folding
// them in either direction costs something real:
//
//   revocable=false, changeable=true   → drop the ×, keep the control
//   revocable=true,  changeable=false  → keep the ×, drop the control   ← the defect's row
//
// The second is the one that happened: the owner's plain `view` row is individually revocable, so it kept
// a control, and using it offered to demote the space's owner.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(import.meta.dirname, "./SpaceMembersTab.tsx"), "utf8");

describe("#607 the roster draws no control this caller cannot use", () => {
  it("the control is withheld on the PRINCIPAL answer, and the × on the ROW answer", () => {
    expect(SRC, "the row answer drives `locked`").toContain("locked: g.revocable === false");
    expect(SRC, "the principal answer drives `frozen`").toContain("frozen: g.changeable === false");
    // the control is withheld when EITHER says no…
    expect(SRC, "the control checks both").toMatch(/r\.managed \|\| r\.locked \|\| r\.frozen \?/);
    // …while the revoke affordance is withheld only by the ROW answer, so a legitimate revoke survives
    const revokeBranch = SRC.slice(SRC.indexOf('data-testid="space-grant-managed"'));
    expect(revokeBranch.slice(0, 400), "the × still asks only about the row").toMatch(/\) : r\.locked \?/);
    expect(revokeBranch.slice(0, 400), "…and is NOT withheld by the principal answer").not.toMatch(/r\.locked \|\| r\.frozen \?/);
  });

  it("a custom-role row belonging to a frozen principal is frozen too", () => {
    // the server's signal travels with the GRANTS, so the assignment rows read it across by principal —
    // a manager's custom-role row is exactly as unmovable as their built-in one
    expect(SRC).toContain("const frozenPrincipals = new Set(grants.filter((g) => g.changeable === false)");
    expect(SRC).toContain("frozen: frozenPrincipals.has(a.principal)");
  });

  it("a refusal that reaches the user names the rule, rather than saying nothing", () => {
    expect(SRC, "the 403 branch exists").toMatch(/err\.status === 403/);
    expect(SRC, "and says which rule stopped them").toContain('t("spaceMembers.ceilingRefused"');
    // the generic toast survives for everything else — this is a narrower message, not a replacement
    expect(SRC, "other failures keep the generic message").toContain('notify.error(t("toast.actionFailed"))');
  });

  it("both locales carry the two new strings (a missing key renders the key)", () => {
    for (const loc of ["en", "ja"]) {
      const json = JSON.parse(readFileSync(resolve(import.meta.dirname, `../i18n/locales/${loc}.json`), "utf8"));
      expect(json.spaceMembers.roleFrozen, `${loc}: the badge explains itself`).toBeTruthy();
      expect(json.spaceMembers.ceilingRefused, `${loc}: the refusal names the rule`).toContain("{{who}}");
    }
  });
});
