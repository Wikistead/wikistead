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

  it("the editor offers the flags that used to be creation-only", () => {
    const list = read("./AdminSignInMethodsSection.tsx");
    // #554 S6 called these out: a connection stuck with trust_groups=false could never sync groups,
    // and only the creation form could set them.
    // #616 / ADR-212 slice 2: it was three, and the bootstrap one went with its mechanism. The two
    // that remain are the ones the complaint was actually about.
    expect(list).toContain("admin-connection-trust-groups-");
    expect(list).toContain('data-testid="oidc-groups-claim"');
    expect(list, "and the retired one is not lingering in the editor").not.toContain("admin-connection-bootstrap-");
  });

  it("a cleared label is SENT, so a label can be unset and not only set", () => {
    // The server reads as "clear it" (sanitizeConnectionLabel). Sending `label || undefined`
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

  // ── the review's findings, pinned so they cannot come back ────────────────
  it("F1: a ceiling-excluded method keeps its ROW and loses only its toggle (ADR-195 §1)", () => {
    const list = read("./AdminSignInMethodsSection.tsx");
    // "not configured here" is the only reason a row disappears; policy exclusion must be VISIBLE
    expect(list).toContain('m["platform-oidc"].configured;');
    expect(list).not.toMatch(/showPlatform\s*=.*inCeiling/);
    expect(list, "the toggle is what the ceiling withholds").toContain('m["platform-oidc"].inCeiling && (');
  });

  it("F2: the selection badge never borrows the word for 'working'", () => {
    const list = read("./AdminSignInMethodsSection.tsx");
    // a selected-but-broken connection must not read as Active, in any locale's word for it
    expect(list).toContain('t(enabled ? "signInMethods.selectionOn" : "signInMethods.selectionOff")');
    expect(list).not.toContain('t(enabled ? "adminAuth.method_effective"');
  });

  it("F3: a row is never judged by the aggregate's first-row `selected` flag", () => {
    // /admin/login-methods computes `selected` from `ORDER BY sort, id LIMIT 1` — the FIRST row
    // so handing it to every row makes rows 2..n claim row 1's state.
    const list = read("./AdminSignInMethodsSection.tsx");
    expect(list).toContain('{ ...m["tenant-oidc"], selected: c.enabled }');
  });

  it("F4: an unentitled SAML row says so while collapsed", () => {
    const list = read("./AdminSignInMethodsSection.tsx");
    expect(list).toContain('samlState.kind === "locked"');
    expect(list).toContain('adminAuth.method_unentitled');
  });

  it("F5: the SAML row waits for its query — CE must never flash a row it may not show", () => {
    const list = read("./AdminSignInMethodsSection.tsx");
    expect(list).toContain("!saml.isPending && samlState.kind !== \"hidden\"");
  });

  it("F6: everything in the editor is part of the draft, so Cancel cancels all of it", () => {
    // #616 / ADR-212 slice 2: `bootstrapEligible` left this list with the toggle it named. Rather than
    // shrink to the one field that remains — which would stop noticing a NEW field wired straight to
    // the server — the statement is asked of every switch the editor draws, discovered from the source.
    const list = read("./AdminSignInMethodsSection.tsx");
    const editorBlock = list.slice(list.indexOf("setDraft("), list.lastIndexOf("setDraft(") + 200);
    const switched = [...editorBlock.matchAll(/setDraft\(\{ \.\.\.draft, (\w+): on \}\)/g)].map((m) => m[1]!);
    expect(switched.length, "the editor draws at least one switch (a broken match must not pass vacuously)")
      .toBeGreaterThan(0);
    for (const field of switched) {
      expect(list, `${field} is part of the draft, so Cancel cancels it`).toContain(`${field}: draft.${field}`);
    }
    expect(list, "the bootstrap toggle is gone with its mechanism").not.toContain("bootstrapEligible");
  });

  it("F7: an unreachable issuer keeps its own message instead of the generic failure", () => {
    const list = read("./AdminSignInMethodsSection.tsx");
    expect(list).toContain('code === "oidc_unreachable"');
  });

  it("F8: the retired surfaces' copy went with them", () => {
    for (const loc of [en, ja] as unknown as Array<Record<string, Record<string, string> | undefined>>) {
      for (const [section, key] of [
        ["adminAuth", "methodsTitle"], ["adminAuth", "methodsBody"], ["adminAuth", "methodTenantOidc"],
        ["adminAuth", "enabled"], ["adminAuth", "samlTitle"],
        ["adminConnections", "title"], ["adminConnections", "body"],
      ] as const) {
        expect(loc[section]?.[key], `${section}.${key} belongs to a surface that no longer exists`).toBeUndefined();
      }
    }
  });

  // review: the tab still opened with "configure your organization's identity provider (OIDC)",
  // written when OIDC was the only way in. Below it the list now carries SAML, password sign-in and
  // platform login, so a method-specific sentence introduced methods it did not describe.
  it("the shared header names no single sign-in method", () => {
    for (const loc of [en, ja] as unknown as Array<{ adminAuth: Record<string, string> }>) {
      // Discovery: every method's display name is an `adminAuth.methodXxx` key, so a sixth method
      // joins this check by existing. An enumerated list would pass the next one through (#544).
      const names = Object.entries(loc.adminAuth)
        .filter(([k]) => /^method[A-Z]/.test(k))
        .map(([, v]) => v);
      expect(names.length, "the discovery found the method names").toBeGreaterThanOrEqual(3);
      for (const header of [loc.adminAuth.body!, loc.adminAuth.warning!]) {
        for (const name of names) {
          expect(header, `"${name}" is one method; a header above all of them must not name it`)
            .not.toContain(name);
        }
        // the retired `methodTenantOidc` key is gone (F8), so OIDC has no name left to discover
        for (const oidc of ["OIDC", "identity provider", "ID プロバイダー"]) {
          expect(header, `${oidc} is one method`).not.toContain(oidc);
        }
      }
    }
  });

  it("the header does not repeat what the list already says about itself", () => {
    for (const loc of [en, ja] as unknown as Array<{ adminAuth: Record<string, string>; signInMethods: Record<string, string> }>) {
      const listBody = loc.signInMethods.body!;
      expect(loc.adminAuth.body).not.toBe(listBody);
      for (const claim of listBody.split(/[。.]/).map((s) => s.trim()).filter((s) => s.length > 8)) {
        expect(loc.adminAuth.body, `the list already says "${claim}"`).not.toContain(claim);
      }
    }
  });

  it("advice about ONE method lives in that method's row", () => {
    // Testing a connection is about an issuer, so it belongs beside the issuer field rather than
    // above every method in the tab.
    const tab = read("./AdminAuthTab.tsx");
    const list = read("./AdminSignInMethodsSection.tsx");
    expect(list).toContain("adminConnections.verifyBeforeEnable");
    expect(tab, "the tab must not carry connection-specific advice").not.toContain("verifyBeforeEnable");
    for (const loc of [en, ja] as unknown as Array<{ adminConnections: Record<string, string> }>) {
      expect(loc.adminConnections.verifyBeforeEnable).toBeTruthy();
    }
  });

  it("both locales carry the list's own copy", () => {
    for (const loc of [en, ja] as Array<{ signInMethods: Record<string, string> }>) {
      for (const k of ["title", "body", "edit", "selectionOn", "selectionOff", "notWorking"]) {
        expect(loc.signInMethods?.[k], k).toBeTruthy();
      }
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
