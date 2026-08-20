// @vitest-environment happy-dom
// #745(review rejection): the card kept describing the stage the reader had left.
//
// The "sign in with your email address and password" instruction sat directly above the second-factor buttons on
// /login/recovery — an instruction already carried out, over controls asking for something else. The
// card's title belonged to the SCREEN, and the screen has no idea the reader moved inside it.
//
// So the step brings its own title, and a screen that is hosting a step stops saying its own piece.
// The same structure is on /login, where it is worse: the other ways in (a connection button, "sign in
// another way") stayed on offer beside "use your passkey" — pressing one would restart sign-in and
// throw away the receipt the reader is holding.
//
// MEASURED ON RENDERED TEXT. The defect is what a person reads, and a source grep for a conditional
// cannot tell a heading that moved from one that was merely wrapped.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, useEffect, act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const bundles = Object.fromEntries(["en", "ja"].map((l) =>
  [l, JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales", `${l}.json`), "utf8"))]));
let lang = "en";
const copy = (key: string): string =>
  key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], bundles[lang]) as string;

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({
    // Interpolation matters here: the sign-in title carries the product name, and a `t` that returned
    // the raw key would make "the title is gone" trivially true.
    t: (k: string, v?: Record<string, string>) =>
      (copy(k) ?? k).replace(/\{\{(\w+)\}\}/g, (_m, n) => v?.[n] ?? ""),
    i18n: { language: lang },
  }),
}));
vi.mock("@simplewebauthn/browser", () => ({ startRegistration: vi.fn(), startAuthentication: vi.fn() }));
vi.mock("../data/queries", () => ({ useBranding: () => ({ data: { productName: "Wikistead" } }) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { methods: ["local", "oidc"], connections: [
    { id: "local", kind: "local", label: null, brand: null },
    { id: "g", kind: "oidc", label: "Acme SSO", brand: null },
    { id: "h", kind: "oidc", label: "Second SSO", brand: null },
  ] } }),
}));

// The screens are driven through the seam the fix added: the form tells the card which stage is up.
// Stubbing the form (rather than answering a fetch) keeps this about the CARD — what a host does with
// that news is the thing that was wrong.
let reported: "required" | "enrolment-required" | null = null;
vi.mock("./LocalLoginForm", () => ({
  LocalLoginForm: ({ onStage }: { onStage?: (s: "required" | "enrolment-required" | null) => void }) => {
    useEffect(() => onStage?.(reported), []);
    return createElement("div", { "data-testid": "stub-form" }, "FORM");
  },
}));

const { FactorStep } = await import("./FactorStep");
const { LoginScreen, RecoveryScreen } = await import("./LoginScreen");

// Text, not markup: the English title carries an apostrophe, which HTML escapes — and a reader sees
// the apostrophe, not the entity.
const step = (stage: "required" | "enrolment-required", kinds: string[]) => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(FactorStep, { stage, kinds, recovery: true, returnTo: "/" }));
  return host.textContent ?? "";
};

function textOf(el: () => unknown): string {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(el as never)); });
  const text = host.textContent ?? "";
  act(() => root.unmount());
  host.remove();
  return text;
}

afterEach(() => { lang = "en"; reported = null; });

describe("#745the stage on screen is the stage the words describe", () => {
  for (const l of ["en", "ja"]) {
    it(`the second-factor step names itself and not the password stage (${l})`, () => {
      lang = l;
      const html = step("required", ["totp", "passkey"]);
      expect(html).toContain(copy("auth.factorTitle"));
      expect(html).toContain(copy("auth.factorBody"));
      // The exact sentence the reader was left staring at.
      expect(html, "the password instruction followed the reader into the next stage")
        .not.toContain(copy("auth.recoveryBody"));
    });
  }

  it("says it for the member with ONE method too, who never sees a chooser", () => {
    const html = step("required", ["totp"]);
    expect(html).toContain(copy("auth.factorTitle"));
    expect(html).toContain(copy("auth.factorCode")); // …and went straight to the box
  });

  it("names the enrolment stage as itself — the third of the three", () => {
    const html = step("enrolment-required", ["totp"]);
    expect(html).toContain(copy("auth.factorEnrolTitle"));
    expect(html).not.toContain(copy("auth.factorTitle"));
  });

  it("the recovery card drops its password instruction once a stage is up", () => {
    reported = null;
    const before = textOf(() => RecoveryScreen());
    expect(before, "…and says it while the password IS what it wants").toContain(copy("auth.recoveryBody"));

    reported = "required";
    const during = textOf(() => RecoveryScreen());
    expect(during).not.toContain(copy("auth.recoveryBody"));
    expect(during).not.toContain(copy("auth.recoveryTitle"));
    expect(during, "the step itself is still there").toContain("FORM");
  });

  it("the sign-in card stops offering other ways in while a proof is owed", () => {
    reported = null;
    const before = textOf(() => LoginScreen());
    expect(before).toContain("Acme SSO");
    expect(before).toContain(copy("auth.moreWays"));

    reported = "required";
    const during = textOf(() => LoginScreen());
    // Pressing one of these restarts sign-in and throws away the receipt the reader is holding.
    expect(during, "a connection button outlived the stage that offered it").not.toContain("Acme SSO");
    expect(during).not.toContain(copy("auth.moreWays"));
    expect(during).not.toContain("Sign in to Wikistead");
    expect(during).toContain("FORM");
  });

  // Discovery: three hosts today, and the next one is a screen nobody has written yet. A host that
  // renders the form without taking the news back cannot know it is stale.
  it("every screen that hosts the password form asks to be told about the stage", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        if (e === "node_modules" || e === "dist") continue;
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx$/.test(p)) files.push(p);
      }
    };
    walk(resolve(import.meta.dirname, ".."));
    expect(files.length).toBeGreaterThan(50); // the walk read the tree

    const hosts = files.filter((f) => !f.endsWith("LocalLoginForm.tsx") && /<LocalLoginForm/.test(readFileSync(f, "utf8")));
    expect(hosts.length).toBeGreaterThan(0); // …and found the hosts
    for (const host of hosts) {
      const src = readFileSync(host, "utf8");
      for (const use of src.match(/<LocalLoginForm[^>]*\/>/g) ?? []) {
        expect(use, `${host.split("/").pop()} hosts the form without asking which stage it is on`).toContain("onStage");
      }
    }
  });
});
