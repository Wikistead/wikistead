// @vitest-environment node
// #537 §6: the login screen's layout rule and the admin badge rule, pinned as pure functions.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loginLayout } from "./LoginScreen";
import { methodBadge } from "../settings/AdminLoginMethodsSection";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";

describe("#537 loginLayout (§6)", () => {
  it("OIDC is primary; SAML folds behind 'another way' only when both exist", () => {
    expect(loginLayout(["oidc", "saml"])).toEqual({ primary: "oidc", secondary: ["saml"] });
    expect(loginLayout(["oidc"])).toEqual({ primary: "oidc", secondary: [] }); // single method → no fold (today's screen)
    expect(loginLayout(["saml"])).toEqual({ primary: "saml", secondary: [] }); // SAML-only tenants get it as THE button
  });
  it("no methods → no dead button (the server would 404 it anyway)", () => {
    expect(loginLayout([])).toEqual({ primary: null, secondary: [] });
  });
});

describe("#537 methodBadge (§1 display rule)", () => {
  const base = { configured: true, selected: true, effective: false };
  it("a ceiling-excluded but selected method reads BY-POLICY, never silently off", () => {
    expect(methodBadge({ ...base, inCeiling: false })).toBe("byPolicy");
  });
  it("effective wins; a plain unselected method is just off", () => {
    expect(methodBadge({ ...base, inCeiling: true, effective: true })).toBe("effective");
    expect(methodBadge({ inCeiling: true, configured: false, selected: false, effective: false })).toBe("off");
  });
});

describe("#537 wiring pins", () => {
  it("the SAML fold and the primary-SAML branch exist in the login screen", () => {
    const src = readFileSync(resolve(import.meta.dirname, "./LoginScreen.tsx"), "utf8");
    expect(src).toContain('data-testid="login-more"'); // the fold
    expect(src).toContain('data-testid="login-saml"');
    expect(src).toContain("/auth/saml/login?returnTo=");
    expect(src).toContain('data-testid="login-none"'); // no-methods state, no dead button
  });
  it("the admin tab mounts the methods section and both locales carry the keys", () => {
    const tab = readFileSync(resolve(import.meta.dirname, "../settings/AdminAuthTab.tsx"), "utf8");
    expect(tab).toContain("<AdminLoginMethodsSection />");
    for (const loc of [en, ja] as Array<{ auth: Record<string, string>; adminAuth: Record<string, string> }>) {
      for (const k of ["signInSaml", "moreWays", "noMethods"]) expect(loc.auth[k], k).toBeTruthy();
      for (const k of ["methodsTitle", "method_byPolicy", "platformOwnIdpRequired"]) expect(loc.adminAuth[k], k).toBeTruthy();
    }
  });
});
