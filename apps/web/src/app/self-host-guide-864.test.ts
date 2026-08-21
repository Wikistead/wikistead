// @vitest-environment happy-dom
// #864 (#806): the operator who just stood the server up is told where the guide is.
//
// The empty state says "ask an administrator to add you to a space". On a self-hosted install the
// person reading it usually IS the administrator — they started the server five minutes ago — so the
// advice is to ask themselves, and there is no way from here to the setup guide. On the managed
// deployment the same sentence is correct and a setup guide is somebody else's business.
//
// ⚠️ THE CONDITION IS A DEPLOYMENT FACT, NOT A LEVER. Every entitlement is UNLIMITED on a self-host
// AND on a top-plan Cloud tenant, so no lever value tells them apart; what does is the resolver
// registration the edition performs once at composition time (ADR-015). This pins that the screen
// reads that fact — a future edit that reaches for a plan name instead would pass a rendering
// assertion and be wrong on exactly the tenant that pays the most.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bundles = Object.fromEntries(["en", "ja"].map((l) =>
  [l, JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales", `${l}.json`), "utf8"))]));
let lang = "en";
const copy = (key: string): string =>
  key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], bundles[lang]) as string;

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (k: string) => copy(k) ?? k, i18n: { language: lang } }),
}));

let selfHosted: boolean | undefined = false;
vi.mock("../data/queries", () => ({
  useSpacesPage: () => ({ isPending: false, data: { spaces: [] } }),
  useEntitlements: () => ({ data: { branding: true, selfHosted } }),
}));
const { HomeEmpty } = await import("./HomeEmpty");

function render(): { text: string; link: string | null } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(HomeEmpty as never)); });
  const a = host.querySelector('[data-testid="home-self-hosting-guide"]') as HTMLAnchorElement | null;
  const out = { text: host.textContent ?? "", link: a ? a.getAttribute("href") : null };
  act(() => root.unmount());
  host.remove();
  return out;
}

beforeEach(() => { lang = "en"; selfHosted = false; });

describe("#864: the empty desk offers the setup guide to whoever set the server up", () => {
  for (const l of ["en", "ja"]) {
    it(`offers it on a self-hosted install (${l})`, () => {
      lang = l; selfHosted = true;
      const { text, link } = render();
      expect(text).toContain(copy("home.emptySelfHostGuide"));
      expect(link, "the link goes to the guide the documentation site publishes").toContain("/getting-started/self-hosting");
    });
  }

  it("says nothing about setup on the managed deployment", () => {
    selfHosted = false;
    const { text, link } = render();
    expect(link, "a tenant on somebody else's server has no server to set up").toBeNull();
    expect(text, "and is not told to read a guide for one").not.toContain(copy("home.emptySelfHostGuide"));
    // The rest of the empty state is untouched — this ticket adds a line, it does not rewrite one.
    expect(text).toContain(copy("home.emptyTitle"));
    expect(text).toContain(copy("home.emptyBody"));
  });

  it("stays silent while the fact is unknown, rather than guessing", () => {
    // The query has not answered yet (or an older server does not send the field). Guessing "self
    // hosted" here would put an operator's link in front of every Cloud tenant for one render.
    selfHosted = undefined;
    expect(render().link).toBeNull();
  });
});
