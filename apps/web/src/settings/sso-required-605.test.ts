// #605 / ADR-210: the client half of the stance, pinned at the source level (the server pins measure
// the doors against a real store; this pins what the screens say and — §3 (iii) — do NOT say).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(import.meta.dirname, p), "utf8");

describe("#605: the switch speaks, the rows say why, the lapse is shown", () => {
  it("both locales carry the vocabulary, and the switch's copy says 'this is about signing in' (§7)", () => {
    for (const loc of ["en", "ja"]) {
      const j = JSON.parse(read(`../i18n/locales/${loc}.json`));
      for (const k of ["blockedByStance", "ssoRequired", "ssoRequiredBody", "ssoRequiredLapsed", "ssoNeedsIdp", "ssoNeedsExemption"]) {
        expect(j.adminAuth[k], `${loc}: adminAuth.${k}`).toBeTruthy();
      }
      expect(j.adminAuth.ssoRequiredBody, `${loc}: names the untouched credentials (§7 ruling)`).toMatch(/API/);
      for (const k of ["recoveryLink", "recoveryTitle", "recoveryBody"]) expect(j.auth[k], `${loc}: auth.${k}`).toBeTruthy();
    }
  });

  it("the section wires the 409 codes to their reasons and shows the lapse", () => {
    const src = read("./AdminSignInMethodsSection.tsx");
    expect(src).toContain('code === "own_idp_required"');
    expect(src).toContain('code === "sso_exemption_required"');
    expect(src).toContain('data-testid="sso-required-lapsed"');
    expect(src, "the preserved-selection reason on the local row").toContain('data-testid="blocked-by-stance"');
    expect(src, "an exemption without a key is marked (§5: the credential is the witness)").toContain("sso-exemption-no-credential");
  });
});

describe("#605 §3 (iii): the recovery door is findable only where it is needed", () => {
  it("the login screen links it ONLY inside the idp_unavailable error, and the route exists", () => {
    const login = read("../app/LoginScreen.tsx");
    const linkAt = login.indexOf("login-recovery-link");
    expect(linkAt, "the link exists").toBeGreaterThan(-1);
    const guard = login.lastIndexOf('=== "idp_unavailable"', linkAt);
    expect(guard, "and it renders behind the idp_unavailable guard, never at rest").toBeGreaterThan(-1);
    expect(linkAt - guard, "the guard is the enclosing condition, not a distant coincidence").toBeLessThan(500);
    const routes = read("../app/routes.tsx");
    expect(routes).toContain('path="/login/recovery"');
    // the ordinary screen must not grow a standing link: exactly one reference, inside the error block
    expect(login.split("login-recovery-link").length - 1).toBe(1);
  });

  it("the recovery screen reuses the ordinary form — no second credential surface", () => {
    const login = read("../app/LoginScreen.tsx");
    const rec = login.slice(login.indexOf("export function RecoveryScreen"));
    expect(rec).toContain("<LocalLoginForm");
  });
});
