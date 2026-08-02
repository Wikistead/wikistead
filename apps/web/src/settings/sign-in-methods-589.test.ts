// #589 / ADR-195 addendum: the auth tab is ONE list of sign-in methods, and every row is edited in
// place. The defect this closes was structural — a legacy form that always wrote
// `ORDER BY sort, id LIMIT 1`, so the second connection could not be edited and the first was edited
// without saying so — and the shape that caused it (a second place to edit a connection) is what
// these pins forbid coming back.
//
// Source pins, deliberately: the failure mode is "a second editing surface exists", which is a fact
// about the module graph, not about one rendered tree. The rendered geometry (a long issuer must not
// cover the row's buttons) is measured in the real browser instead — no layout engine here.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { methodBadge } from "./login-method-badge";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";

const here = import.meta.dirname;
const read = (f: string) => readFileSync(resolve(here, f), "utf8");

describe("#589: one list, one place to edit a sign-in method", () => {
  it("the retired surfaces are gone from the tree, not merely unmounted", () => {
    // A component nobody renders is a component the next change re-mounts. Both the status card and
    // the legacy single-OIDC section are deleted files now.
    const files = readdirSync(here);
    expect(files).not.toContain("AdminLoginMethodsSection.tsx");
    expect(files).not.toContain("AdminConnectionsSection.tsx");
  });

  it("the auth tab renders the list and nothing that edits a connection itself", () => {
    const tab = read("./AdminAuthTab.tsx");
    expect(tab).toContain("<AdminSignInMethodsSection />");
    // the legacy form's fields lived directly on the tab — the tab must carry none of them now
    for (const testid of ["oidc-issuer", "oidc-client-secret", "oidc-groups-claim", "oidc-save"]) {
      expect(tab, `the tab must not edit a connection itself (${testid})`).not.toContain(testid);
    }
  });

  it("exactly ONE module owns the connection editor fields", () => {
    // The discovery form of the pin: whatever the files are called, only one of them may carry the
    // editor. Two modules with `oidc-save` is the two-places-to-edit shape returning.
    const owners = readdirSync(here)
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => read(`./${f}`).includes('data-testid="oidc-save"'));
    expect(owners).toEqual(["AdminSignInMethodsSection.tsx"]);
  });

  it("the editor offers the three flags that used to be creation-only", () => {
    const list = read("./AdminSignInMethodsSection.tsx");
    // #554 S6 called these out: a connection stuck with trust_groups=false could never sync groups,
    // and only the creation form could set them.
    expect(list).toContain("admin-connection-trust-groups-");
    expect(list).toContain("admin-connection-bootstrap-");
    expect(list).toContain('data-testid="oidc-groups-claim"');
  });

  it("a cleared label is SENT, so a label can be unset and not only set", () => {
    // The server reads "" as "clear it" (sanitizeConnectionLabel). Sending `label || undefined`
    // would drop the empty string, and the old label would silently survive the clear.
    const list = read("./AdminSignInMethodsSection.tsx");
    expect(list).toContain("label: draft.label");
    expect(list).not.toContain("label: draft.label || undefined");
  });

  it("the connection test still runs from the row (it is the product's only test path)", () => {
    // POST /admin/oidc/test has no equivalent under /admin/connections; deleting the legacy form
    // without keeping this would have removed connection testing from the product.
    const list = read("./AdminSignInMethodsSection.tsx");
    expect(list).toContain("useTestTenantOidc");
    expect(list).toContain('data-testid="oidc-test"');
  });

  it("the issuer is clipped to one line rather than wrapping under the row's buttons", () => {
    const list = read("./AdminSignInMethodsSection.tsx");
    const issuerLine = list.split("\n").find((l) => l.includes("admin-connection-issuer-"));
    expect(issuerLine).toBeTruthy();
    expect(issuerLine).toContain("truncate");
    expect(issuerLine).toContain("min-w-0");
  });

  it("reorder controls appear only when there is an order to change", () => {
    const list = read("./AdminSignInMethodsSection.tsx");
    expect(list).toContain("rows.length > 1 && (");
  });

  it("MCP stays a per-connection switch on the row (#592 is not regressed by the merge)", () => {
    const list = read("./AdminSignInMethodsSection.tsx");
    expect(list).toContain("admin-connection-mcp-");
    expect(list).toContain("admin-connection-mcp-note-");
  });

  it("both locales carry the list's own copy", () => {
    for (const loc of [en, ja] as Array<{ signInMethods: Record<string, string> }>) {
      for (const k of ["title", "body", "edit"]) expect(loc.signInMethods?.[k], k).toBeTruthy();
    }
  });
});

// The classifier moved out of the deleted card; its rules are ADR-195 §1 and did not change.
describe("#589: the badge classification survived the card it lived in", () => {
  const base = { inCeiling: true, configured: true, selected: true, effective: false };
  it("effective wins over everything", () => {
    expect(methodBadge({ ...base, effective: true, inCeiling: false })).toBe("effective");
  });
  it("a method the ceiling excludes reads as blocked by policy, not off", () => {
    expect(methodBadge({ ...base, inCeiling: false })).toBe("byPolicy");
  });
  it("an unentitled selection says so (the data is preserved, ADR-072)", () => {
    expect(methodBadge({ ...base, entitled: false })).toBe("unentitled");
  });
  it("a method nobody selected is simply off", () => {
    expect(methodBadge({ ...base, selected: false })).toBe("off");
  });
});
