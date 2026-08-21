// @vitest-environment happy-dom
// #798 / ADR-246. From the owner, at the screen: "why are there two Sign ins? each way in has to say
// which one it is."
//
// A tenant with a nameless custom OIDC connection and password sign-in got:
//
//   [ Sign in ]            ← the connection, falling back to `auth.signIn`
//   ─────────────
//   email / password
//   [ Sign in ]            ← the form's submit, using the same key
//
// Two buttons, one word, and the reader found out which was which by pressing one.
//
// MEASURED ON THE RENDERED SCREEN, and on the PROPERTY rather than on the three strings the fix
// changed: "no two ways in on this screen are called the same thing". A pin that asserted
// `signInSso` and `signInLocal` would go green the day a fourth kind lands with no wording of its
// own — which is the defect, one level down.
//
// The ruling of 2026-08-21 added the other half: a preset-less connection is NAMED at creation, so
// the generic wording is insurance rather than the everyday answer. Both are pinned here — the
// insurance still has to be distinct, because the rows that predate the rule are still out there.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bundles = Object.fromEntries(["en", "ja"].map((l) =>
  [l, JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales", `${l}.json`), "utf8"))]));
let lang = "en";
const copy = (key: string): string =>
  key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], bundles[lang]) as string;

type Conn = { id: string; kind: string; label: string | null; brand: string | null };
let connections: Conn[] = [];

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({
    t: (k: string, v?: Record<string, string>) =>
      (copy(k) ?? k).replace(/\{\{(\w+)\}\}/g, (_m, n) => v?.[n] ?? ""),
    i18n: { language: lang },
  }),
}));
vi.mock("@simplewebauthn/browser", () => ({ startRegistration: vi.fn(), startAuthentication: vi.fn() }));
vi.mock("../data/queries", () => ({ useBranding: () => ({ data: { productName: "Wikistead" } }) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { methods: connections.map((c) => c.kind), connections } }),
}));

const { LoginScreen } = await import("./LoginScreen");

/** The rendered screen, and the buttons on it that start a way in. */
function waysIn(): { texts: string[]; screen: string } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(LoginScreen)); });
  const texts = Array.from(host.querySelectorAll("button"))
    // The chrome is not a way in: the theme and language toggles carry an icon, and "forgot your
    // password" starts a reset rather than a sign-in.
    .filter((b) => (b.getAttribute("data-testid") ?? "") !== "login-local-forgot")
    .map((b) => (b.textContent ?? "").trim())
    .filter((s) => s !== "");
  const screen = host.textContent ?? "";
  act(() => root.unmount());
  host.remove();
  return { texts, screen };
}

const local: Conn = { id: "local", kind: "local", label: null, brand: null };
const nameless: Conn = { id: "c1", kind: "oidc", label: null, brand: null };
const named: Conn = { id: "c2", kind: "oidc", label: "Acme SSO", brand: null };
const preset: Conn = { id: "c3", kind: "oidc", label: null, brand: "google" };
const saml: Conn = { id: "c4", kind: "saml", label: null, brand: null };
const platform: Conn = { id: "platform", kind: "platform", label: null, brand: null };

// Every shape the product can put on this screen, and the combinations that put two of them side by
// side. The nameless-plus-local row is the one the owner reported.
const SHAPES: [string, Conn[]][] = [
  ["a nameless connection beside the password form", [nameless, local]],
  ["a named connection beside the password form", [named, local]],
  ["a preset beside the password form", [preset, local]],
  ["SAML beside the password form", [saml, local]],
  ["the platform account beside the password form", [platform, local]],
  ["a nameless connection beside SAML", [nameless, saml]],
  ["every kind at once", [nameless, named, preset, saml, platform, local]],
];

afterEach(() => { lang = "en"; connections = []; });

describe("#798: no two ways in on the sign-in screen are called the same thing", () => {
  for (const [what, list] of SHAPES) {
    for (const l of ["en", "ja"]) {
      it(`${what} (${l})`, () => {
        lang = l; connections = list;
        const { texts } = waysIn();
        expect(texts.length, "the screen rendered no way in at all — this shape proves nothing").toBeGreaterThan(1);
        const dupes = texts.filter((s, i) => texts.indexOf(s) !== i);
        expect(dupes, `two ways in read the same: ${texts.join(" | ")}`).toEqual([]);
      });
    }
  }

  // ⚠️ THE ONE SHAPE THAT STILL COLLIDES, written down rather than left out.
  //
  // Two connections that both fall back to the generic wording read alike, and no wording can fix
  // that: a third string would only move the collision to the third connection. ADR-246 §3 said the
  // answer is a name, and the ruling of 2026-08-21 made the name required at creation — so this
  // state is reachable only for rows made before that rule, and the admin screen asks those rows to
  // be named (`admin-connections-unnamed-notice`, pinned in the settings suite).
  //
  // Asserted as it IS, not as it should be. The day somebody makes it unreachable this test goes
  // red and says so, which is worth more than a shape quietly missing from the list above.
  it("two rows that predate the naming rule still read alike, and one name separates them", () => {
    connections = [nameless, { ...nameless, id: "c9" }, local];
    const both = waysIn().texts;
    expect(both.filter((s, i) => both.indexOf(s) !== i),
      "this collision became unreachable: good, and the notice/migration around it can now retire")
      .toEqual([copy("auth.signInSso")]);

    connections = [nameless, { ...nameless, id: "c9", label: "Corp IdP" }, local];
    const oneNamed = waysIn().texts;
    expect(oneNamed.filter((s, i) => oneNamed.indexOf(s) !== i)).toEqual([]);
  });

  it("a named connection wears its own name, so naming is what separates two SSO buttons", () => {
    connections = [named, { id: "c5", kind: "oidc", label: "Corp IdP", brand: null }, local];
    const { screen, texts } = waysIn();
    expect(screen).toContain("Acme SSO");
    expect(screen).toContain("Corp IdP");
    expect(texts.filter((s, i) => texts.indexOf(s) !== i)).toEqual([]);
  });
});

describe("#798: the words say what the way in IS", () => {
  for (const l of ["en", "ja"]) {
    it(`a nameless connection says single sign-on, and the form says email (${l})`, () => {
      lang = l; connections = [nameless, local];
      const { screen } = waysIn();
      expect(screen).toContain(copy("auth.signInSso"));
      expect(screen).toContain(copy("auth.signInLocal"));
    });
  }

  it("the bare verb is on no way-in button any more", () => {
    // Walked, not grepped: `auth.signIn` still exists for the places that really are the verb (the
    // reset card, the page title), so a grep would either miss the defect or forbid the legitimate
    // uses. What must be true is that no BUTTON that starts a way in is called it.
    connections = [nameless, named, preset, saml, platform, local];
    const { texts } = waysIn();
    expect(texts).not.toContain(copy("auth.signIn"));
  });

  it("the issuer host never reaches this screen", () => {
    // The admin list falls back to the issuer's host and is right to; that surface is authenticated.
    // Here it would publish the organisation's identity to anyone who loads the page. The server
    // does not send an issuer at all, and the break-check is that a component which learned to read
    // one could not print it either.
    connections = [{ ...nameless, ...({ issuer: "https://login.acme.example" } as object) }, local];
    const { screen } = waysIn();
    expect(screen).not.toContain("acme.example");
  });
});

describe("#798: the kinds this pin covers are the kinds the server can send", () => {
  it("a new connection kind lands in SHAPES before it lands on the screen", () => {
    // Discovery, cross-package: `resolveLoginConnections` is the one place a connection acquires its
    // kind. A kind added there with no wording of its own would fall back to the generic string and
    // pair up with something — which is the defect this file exists for — and a fixed list here
    // would stay green through it.
    const src = readFileSync(resolve(import.meta.dirname, "../../../server/src/auth/login-methods.ts"), "utf8");
    const kinds = new Set(Array.from(src.matchAll(/kind: '([a-z-]+)'/g), (m) => m[1]!));
    expect(kinds.size, "the kind literals moved — this pin is reading the wrong file").toBeGreaterThan(2);
    const covered = new Set(SHAPES.flatMap(([, list]) => list.map((c) => c.kind)));
    expect([...kinds].filter((k) => !covered.has(k)), "a connection kind the server can send is not on any shape above").toEqual([]);
  });
});
