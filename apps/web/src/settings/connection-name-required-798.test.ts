// @vitest-environment happy-dom
// #798 (ruling, 2026-08-21): a connection without a preset is NAMED, and the name is asked for where
// the admin is — not left to a fallback on the sign-in screen.
//
// Two things have to be true for that to be a rule rather than a wish
//
// the WRITE refuses a nameless preset-less connection (pinned server-side), and
// the rows that predate the rule are ASKED, on the next visit, rather than left as they are.
//
// The second is what this file is about, and it is the half a fix usually skips: a rule added after
// the data exists leaves a population that satisfies neither the old shape nor the new one. Those
// connections still sign people in, so the screen does not block on them — it says what is missing,
// on the row and above the list, and refuses only the save that would leave the row nameless.
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

type Row = { id: string; kind: "oidc"; issuer: string; clientId: string; hasSecret: boolean; scopes: string
  redirectUri: string; enabled: boolean; sort: number; label: string | null; preset: string | null
  trustGroups: boolean; subjectPrefix: string | null; groupsClaim: string | null
  mcpEnabled: boolean; mcpEnforceable: boolean };

const row = (over: Partial<Row>): Row => ({
  id: "c1", kind: "oidc", issuer: "https://login.acme.example", clientId: "cid", hasSecret: true,
  scopes: "openid email profile", redirectUri: "", enabled: true, sort: 0, label: null, preset: null,
  trustGroups: false, subjectPrefix: "wcabc_", groupsClaim: null, mcpEnabled: false, mcpEnforceable: true,
  ...over,
});

let rows: Row[] = [];

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, v?: Record<string, string>) =>
      (copy(k) ?? k).replace(/\{\{(\w+)\}\}/g, (_m, n) => v?.[n] ?? ""),
    i18n: { language: lang },
  }),
}));
vi.mock("../ui/toast", () => ({ notify: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./AdminSamlSection", () => ({
  AdminSamlSection: () => null,
  samlSectionState: () => ({ kind: "hidden" as const }),
}));
vi.mock("../ui/MemberSearchInput", () => ({ MemberSearchInput: () => null }));
vi.mock("../app/product-name", () => ({ useProductName: () => "Wikistead" }));
const noopMutation = () => ({ mutate: vi.fn(), isPending: false });
const noQuery = () => ({ data: undefined });
// Everything this section reaches for, answered with "nothing to show" so the ROWS are the only
// thing on screen. Listed exhaustively rather than with a proxy: a hook added to the section that
// nobody stubs here fails loudly, which is the reminder to decide what it should answer.
vi.mock("../data/queries", () => ({
  useAdminConnections: () => ({ data: rows, isLoading: false }),
  useCreateConnection: noopMutation,
  useUpdateConnection: noopMutation,
  useDeleteConnection: noopMutation,
  useReorderConnections: noopMutation,
  useLoginMethods: noQuery,
  useUpdatePlatformLogin: noopMutation,
  useUpdateLocalLogin: noopMutation,
  useTenantSaml: noQuery,
  useUpdateTenantSaml: noopMutation,
  useTestTenantOidc: noopMutation,
  useUpdateSsoRequired: noopMutation,
  useUpdateSecondFactorRequired: noopMutation,
  useUpdateSecondFactorStance: noopMutation,
  useStanceImpact: noQuery,
  useSsoExemptions: noQuery,
  useGrantSsoExemption: noopMutation,
  useRevokeSsoExemption: noopMutation,
  useTenantMemberCandidates: noQuery,
  useTenantMemberNames: () => new Map<string, string>(),
}));

afterEach(() => { lang = "en"; rows = []; });

/** Render the section and hand back its DOM. */
function render(): { host: HTMLElement; unmount: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(Section)); });
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

const { AdminSignInMethodsSection: Section } = await import("./AdminSignInMethodsSection");

describe("#798: the rows that predate the naming rule are asked, not ignored", () => {
  for (const l of ["en", "ja"]) {
    it(`the list says a name is missing, above it and on the row (${l})`, () => {
      lang = l;
      rows = [row({ id: "old", label: null })];
      const { host, unmount } = render();
      expect(host.querySelector('[data-testid="admin-connections-unnamed-notice"]')?.textContent)
        .toBe(copy("adminConnections.unnamedNotice"));
      expect(host.querySelector('[data-testid="admin-connection-unnamed-old"]')?.textContent)
        .toBe(copy("adminConnections.unnamedBadge"));
      unmount();
    });
  }

  it("a named connection and a preset are not asked for anything", () => {
    // The break-check for the notice: if it appeared for every row it would be noise, and an admin
    // who has named everything would be told to go and name something.
    rows = [row({ id: "named", label: "Acme SSO" }), row({ id: "g", label: null, preset: "google" })];
    const { host, unmount } = render();
    expect(host.querySelector('[data-testid="admin-connections-unnamed-notice"]')).toBeNull();
    expect(host.querySelector('[data-testid="admin-connection-unnamed-named"]')).toBeNull();
    expect(host.querySelector('[data-testid="admin-connection-unnamed-g"]')).toBeNull();
    unmount();
  });

  it("the notice does not block the screen — the connection is still listed and still switchable", () => {
    // A rule added after the data exists must not make the data unmanageable. These rows work; what
    // they lack is a name.
    rows = [row({ id: "old", label: null })];
    const { host, unmount } = render();
    expect(host.querySelector('[data-testid="admin-connection-old"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="admin-connection-enabled-old"]')).not.toBeNull();
    unmount();
  });

  it("opening a nameless row asks for the name and will not save without one", () => {
    rows = [row({ id: "old", label: null })];
    const { host, unmount } = render();
    const edit = host.querySelector('[data-testid="admin-connection-edit-old"]') as HTMLElement;
    act(() => { edit.click(); });
    expect(host.querySelector('[data-testid="admin-connection-label-required-old"]')?.textContent)
      .toBe(copy("adminConnections.labelRequired"));
    const save = host.querySelector('[data-testid="oidc-save"]') as HTMLButtonElement;
    expect(save.disabled, "a save that clears the name is what the server refuses").toBe(true);

    const input = host.querySelector('[data-testid="oidc-label"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Acme SSO");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect((host.querySelector('[data-testid="oidc-save"]') as HTMLButtonElement).disabled).toBe(false);
    expect(host.querySelector('[data-testid="admin-connection-label-required-old"]')).toBeNull();
    unmount();
  });

  it("a preset row's editor offers no label field and saves without one", () => {
    // The mirror image: a preset wears fixed first-party branding, the server refuses a label on it,
    // and requiring one here would be a field nobody can satisfy.
    rows = [row({ id: "g", label: null, preset: "google" })];
    const { host, unmount } = render();
    act(() => { (host.querySelector('[data-testid="admin-connection-edit-g"]') as HTMLElement).click(); });
    expect(host.querySelector('[data-testid="oidc-label"]')).toBeNull();
    expect((host.querySelector('[data-testid="oidc-save"]') as HTMLButtonElement).disabled).toBe(false);
    unmount();
  });

  it("the copy no longer calls the label optional", () => {
    // It said "(optional, shown on the login screen)" in both locales, which is now false — and a
    // form that calls a required field optional is worse than one that says nothing.
    for (const l of ["en", "ja"]) {
      lang = l;
      expect(copy("adminConnections.labelPlaceholder")).not.toMatch(/optional|任意/);
    }
  });
});
