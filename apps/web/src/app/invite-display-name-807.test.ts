// @vitest-environment happy-dom
// #807: the first administrator of a self-hosted workspace arrived nameless.
//
// Accepting a password invitation MINTS a new identity, and nothing in that flow knew what to call
// them — the acceptance wrote `name: null` outright. An OIDC invitation gets a name from the IdP at
// every login, so the two doors were asymmetric, and the local one produced a member who appears in
// the roster, on presence carets and in mentions as a bare `wlocal_…` sub.
//
// The field belongs to the ACCEPT door only: a reset is a member who already has a name. And it is
// the SCREEN that requires it, not the route — a tab opened before this shipped must still be able
// to accept a real invitation, and refusing it server-side would answer "this link does not work",
// the one thing this flow's uniform 404 must never say wrongly.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bundles = Object.fromEntries(["en", "ja"].map((l) =>
  [l, JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales", `${l}.json`), "utf8"))]));
let lang = "en";
const copy = (key: string): string =>
  key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], bundles[lang]) as string;

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({
    t: (k: string, v?: Record<string, string>) => (copy(k) ?? k).replace(/\{\{(\w+)\}\}/g, (_m, n) => v?.[n] ?? ""),
    i18n: { language: lang },
  }),
}));
vi.mock("../data/apiClient", () => ({ assetUrl: (p: string) => p }));

const { SetPasswordForm } = await import("./SetPasswordForm");
const SRC = readFileSync(resolve(import.meta.dirname, "SetPasswordForm.tsx"), "utf8");

const render = (mode: "accept" | "reset") => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    createElement(SetPasswordForm, { token: "t", mode, onDone: () => {} }),
  );
  return host;
};

afterEach(() => { lang = "en"; });

describe("#807 a password invitation asks what to call you", () => {
  for (const l of ["en", "ja"]) {
    it(`the accept door asks for a display name, and says it can be changed (${l})`, () => {
      lang = l;
      const host = render("accept");
      expect(host.querySelector('[data-testid="set-password-display-name"]'), "the field itself").not.toBeNull();
      const text = host.textContent ?? "";
      // The reader is told who sees it and that it is not final — otherwise the field reads as
      // another credential they must get right.
      expect(text).toContain(copy("auth.displayNameHint"));
    });
  }

  it("the reset door does NOT ask — that member already has a name", () => {
    const host = render("reset");
    expect(host.querySelector('[data-testid="set-password-display-name"]')).toBeNull();
    expect(host.textContent ?? "").not.toContain(copy("auth.displayNameHint"));
  });

  it("cannot be submitted nameless, which is the whole defect", () => {
    const host = render("accept");
    const submit = host.querySelector('[data-testid="set-password-submit"]');
    expect(submit?.hasAttribute("disabled"), "an empty name must not be submittable").toBe(true);
    // …and the gate reads the TRIMMED value, so spaces are not a name.
    expect(SRC).toContain('!displayName.trim()');
  });

  it("sends the name only on the accept door, trimmed", () => {
    // Read the body the form builds: the reset door must not start sending a field its route ignores,
    // and an untrimmed name would store spaces the roster then renders.
    const body = SRC.slice(SRC.indexOf("body: JSON.stringify("), SRC.indexOf("});", SRC.indexOf("body: JSON.stringify(")));
    expect(body).toContain('mode === "accept"');
    expect(body).toContain("displayName: displayName.trim()");
  });
});
