// @vitest-environment happy-dom
// #798 (ruling): a connection without a preset is NAMED, and the name is asked for where the admin
// is — not left to a fallback on the sign-in screen. #834 (ruling, the same day) took the other half
// back out, and this file follows it down.
//
// #798 had also built a migration for rows that predate the rule: a notice above the list, a badge on
// the row, and a server-side exemption letting a request carrying no label through so those rows
// stayed manageable. The rule shipped the same day it was written, so that population was empty
// machinery asking for something nothing needed, and a second reading of "a connection has a name"
// (true at creation, negotiable afterwards). The replacement is one line: the name field's
// placeholder shows the words the sign-in screen would use, so the field explains itself by example.
//
// ⚠️ AND THE OLD PINS PASSED OVER THE REMOVAL. They read
// `expect(host.querySelector(...)?.textContent).toBe(copy("adminConnections.unnamedNotice"))`, so
// when the element AND the copy key both went, the assertion compared `undefined` with `undefined`
// and stayed green. A pin that reads both sides from things that can disappear together is not
// measuring anything. The ones below assert absence and presence directly, against literals.
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

describe("#834: the migration is gone, and the field explains itself", () => {
  it("a nameless row gets no notice and no badge", () => {
    // Absence asserted as absence — not as "equals the copy that also went away".
    rows = [row({ id: "old", label: null })];
    const { host, unmount } = render();
    expect(host.querySelector('[data-testid="admin-connections-unnamed-notice"]')).toBeNull();
    expect(host.querySelector('[data-testid="admin-connection-unnamed-old"]')).toBeNull();
    expect(host.querySelector('[data-testid="admin-connection-label-required-old"]')).toBeNull();
    unmount();
  });

  it("the name field shows the words the sign-in screen would use", () => {
    // The ruling's replacement for the sentence underneath. Compared against the LIVE `auth.signInSso`
    // string, which the sign-in screen also renders, so the two cannot drift apart quietly.
    rows = [row({ id: "c1", label: "Acme SSO" })];
    const { host, unmount } = render();
    act(() => { (host.querySelector('[data-testid="admin-connection-edit-c1"]') as HTMLElement).click(); });
    const input = host.querySelector('[data-testid="oidc-label"]') as HTMLInputElement;
    const words = copy("auth.signInSso");
    expect(words, "the wording key vanished, so this test proves nothing").toBeTruthy();
    expect(input.placeholder).toBe(words);
    unmount();
  });

  it("the row is still listed and still switchable", () => {
    rows = [row({ id: "old", label: null })];
    const { host, unmount } = render();
    expect(host.querySelector('[data-testid="admin-connection-old"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="admin-connection-enabled-old"]')).not.toBeNull();
    unmount();
  });

  it("the editor will not save a preset-less row without a name", () => {
    // The half the ruling KEPT. The route refuses it too, so this is the screen saying so before the
    // round trip rather than the only thing saying so.
    rows = [row({ id: "old", label: null })];
    const { host, unmount } = render();
    act(() => { (host.querySelector('[data-testid="admin-connection-edit-old"]') as HTMLElement).click(); });
    expect((host.querySelector('[data-testid="oidc-save"]') as HTMLButtonElement).disabled).toBe(true);

    const input = host.querySelector('[data-testid="oidc-label"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Acme SSO");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect((host.querySelector('[data-testid="oidc-save"]') as HTMLButtonElement).disabled).toBe(false);
    unmount();
  });

  it("a preset row offers no name field and saves without one", () => {
    // The mirror image: a preset wears fixed first-party branding, the route refuses a label on it,
    // and requiring one here would be a field nobody can satisfy.
    rows = [row({ id: "g", label: null, preset: "google" })];
    const { host, unmount } = render();
    act(() => { (host.querySelector('[data-testid="admin-connection-edit-g"]') as HTMLElement).click(); });
    expect(host.querySelector('[data-testid="oidc-label"]')).toBeNull();
    expect((host.querySelector('[data-testid="oidc-save"]') as HTMLButtonElement).disabled).toBe(false);
    unmount();
  });

  it("the copy the migration needed is gone, and the field still says it is required", () => {
    const bundle = bundles as Record<string, { adminConnections: Record<string, string> }>;
    for (const l of ["en", "ja"]) {
      const conn = bundle[l]!.adminConnections;
      // Read off the BUNDLE, not through `copy` — a lookup helper answers `undefined` for a missing
      // key and for a typo alike, which is the shape that made the old pins vacuous.
      for (const k of ["unnamedNotice", "unnamedBadge", "labelRequired"]) {
        expect(Object.keys(conn), `adminConnections.${k} survived the migration it belonged to (${l})`).not.toContain(k);
      }
      expect(conn.labelPlaceholder, `the ${l} field still calls the name optional`).not.toMatch(/optional|任意/);
    }
  });
});
