// @vitest-environment happy-dom
// #537 / ADR-195 §5+§9: the SAML admin section's three-way disclosure branch. The dangerous edge is
// the difference between the two "no" answers: a CE build (route not mounted, 404) must render
// NOTHING — SAML does not exist there and a locked teaser would advertise an EE feature the binary
// cannot serve — while an EE build with an unentitled plan (403+upgrade) must show the ADR-072
// upgrade notice, because a 404-shaped disappearance there reads as "your configuration was deleted".
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { samlSectionState } from "./AdminSamlSection";
import { apiErrorFrom } from "../data/apiClient";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";

const err = (status: number, body: unknown = {}) => ({ isError: true, error: apiErrorFrom(status, "/admin/saml", body) });

describe("#537 samlSectionState", () => {
  it("CE build (404) → hidden — no teaser for a feature the binary cannot serve", () => {
    expect(samlSectionState(err(404, { message: "Not Found" }))).toEqual({ kind: "hidden" });
  });
  it("EE build, unentitled plan (403 + entitlement marker) → locked (ADR-072 admin surface)", () => {
    expect(samlSectionState(err(403, { message: "no", code: "saml_not_entitled", upgrade: true }))).toEqual({ kind: "locked" });
  });
  it("entitled: data (or none yet) → the form", () => {
    expect(samlSectionState({ isError: false, error: null, data: null })).toEqual({ kind: "form", data: null });
    const dto = {
      idpEntityId: "e", ssoUrl: "s", spEntityId: "sp", acsUrl: "a",
      attrEmail: null, attrName: null, attrGroups: null, enabled: true, hasCert: true,
    };
    expect(samlSectionState({ isError: false, error: null, data: dto })).toEqual({ kind: "form", data: dto });
  });
  it("an unclassifiable failure hides the section — never a half-broken auth form", () => {
    expect(samlSectionState(err(500)).kind).toBe("hidden");
    expect(samlSectionState({ isError: true, error: new Error("network") }).kind).toBe("hidden");
  });
});

describe("#537 SAML admin section wiring (source pins)", () => {
  const src = readFileSync(resolve(import.meta.dirname, "./AdminSamlSection.tsx"), "utf8");
  it("the cert is write-only: textarea cleared after save, keep-placeholder driven by hasCert", () => {
    expect(src).toContain('setIdpCert("")'); // cleared on success — never echoed back
    expect(src).toContain("data?.hasCert ? t(\"adminAuth.samlCertKeep\")");
  });
  it("the locked branch renders UpgradeNotice through disclosureKindFromError (never a hardcoded hint)", () => {
    expect(src).toContain("disclosureKindFromError(saml.error");
    expect(src).toContain('testId="saml-upgrade"');
  });
  it("the section is mounted on the /admin/auth tab", () => {
    const tab = readFileSync(resolve(import.meta.dirname, "./AdminAuthTab.tsx"), "utf8");
    expect(tab).toContain("<AdminSamlSection />");
  });
  it("both locales carry the SAML keys", () => {
    for (const loc of [en, ja] as Array<{ adminAuth: Record<string, string> }>) {
      for (const k of ["samlTitle", "samlLockedTitle", "samlLockedBody", "samlCertKeep", "samlCertRequired", "samlSpHint"]) {
        expect(loc.adminAuth[k], k).toBeTruthy();
      }
    }
  });
});
