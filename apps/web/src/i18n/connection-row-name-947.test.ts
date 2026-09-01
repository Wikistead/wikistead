// #947 (D2): the account-settings "Link sign-in methods" list names each row by what the way in IS,
// not by the verb the sign-in button carries. The heading already says "link"; a row that also said
// "Sign in with …" next to a "Link" button put two actions on one line (reviewer note D2 on #947).
//
// Measured on the FUNCTION the row renders, in both languages, so a locale that slips back to the
// button wording is red on its own. The wiring half — that the row calls this function and not the
// button's — is asserted on the panel's source, since the row is a leaf with no fetch of its own.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import i18n from "i18next";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import { connectionName, connectionButtonText, type LoginConnection } from "../app/LoginScreen";

const VERB: Record<string, RegExp> = { en: /sign in|continue with/i, ja: /サインイン|続行/ };

describe("#947 (D2): a row in the link list is a name, not a sign-in verb", () => {
  beforeAll(async () => {
    await i18n.init({ lng: "en", fallbackLng: false, resources: { en: { translation: en }, ja: { translation: ja } } });
  });

  for (const lng of ["en", "ja"] as const) {
    it(`${lng}: a label-less OIDC / platform / SAML row carries no verb, while the button still does`, async () => {
      await i18n.changeLanguage(lng);
      const t = (k: string) => i18n.t(k);
      for (const kind of ["oidc", "platform", "saml"]) {
        const conn: LoginConnection = { id: "c", kind, label: null, brand: null };
        const name = connectionName(conn, t);
        expect(name, `${lng}/${kind}: unresolved key`).not.toMatch(/^auth\./);
        expect(name, `${lng}/${kind}: the row must not read as the sign-in button`).not.toMatch(VERB[lng]!);
        // The contrast that makes the assertion above non-vacuous: the BUTTON wording does carry the verb.
        expect(connectionButtonText(conn, t)).toMatch(VERB[lng]!);
      }
    });
  }

  it("the admin's label and a preset brand win, brand first (a branded row never carries a label)", () => {
    const t = (k: string) => k;
    expect(connectionName({ id: "c", kind: "oidc", label: "Authentik", brand: null }, t)).toBe("Authentik");
    expect(connectionName({ id: "c", kind: "oidc", label: null, brand: "google" }, t)).toBe("Google");
    expect(connectionName({ id: "c", kind: "oidc", label: "ignored", brand: "github" }, t)).toBe("GitHub");
  });

  it("the panel's row renders connectionName, not the sign-in button's wording", () => {
    const src = readFileSync(new URL("../settings/ConnectionsLinkPanel.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/connectionName\(conn, t\)/);
    expect(src).not.toMatch(/connectionButtonText\(/);
  });
});
