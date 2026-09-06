// @vitest-environment happy-dom
// #1162 / ADR-282 (owner ruling, accepted): `connectionEffective === false` gets a small, dim,
// deliberately unalarming label next to the connection's name — never shown for an effective
// connection, and never doubled up with `identitiesConnectionGone` (a fully-deleted connection is
// already `connectionName: null`, which the component renders as its own distinct fallback string).
import { describe, it, expect, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const links = {
  active: { linkId: "l1", connectionId: "c1", connectionName: { kind: "oidc", label: "Acme", brand: null }, linkedAt: "2026-01-01T00:00:00Z", connectionEffective: true },
  inactive: { linkId: "l2", connectionId: "c2", connectionName: { kind: "oidc", label: "Old Co", brand: null }, linkedAt: "2026-01-01T00:00:00Z", connectionEffective: false },
  gone: { linkId: "l3", connectionId: "c3", connectionName: null, linkedAt: "2026-01-01T00:00:00Z", connectionEffective: false },
};

let queryResult: { data: { primaryIdentitySource: string; links: (typeof links)[keyof typeof links][] } | undefined; isLoading: boolean; isError: boolean };
vi.mock("../data/queries", () => ({
  useMemberIdentityLinks: () => queryResult,
}));

const { MemberIdentityLinksSection } = await import("./MemberIdentityLinksSection");

async function render(linkRows: (typeof links)[keyof typeof links][]) {
  queryResult = { data: { primaryIdentitySource: "oidc", links: linkRows }, isLoading: false, isError: false };
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(createElement(MemberIdentityLinksSection, { sub: "s1" })); });
  return { container, root };
}

describe("#1162: connectionEffective renders a dim inactive label, never for an effective or gone connection", () => {
  it("an effective connection shows no inactive label", async () => {
    const { container, root } = await render([links.active]);
    expect(container.querySelector('[data-testid="member-identity-link-inactive"]')).toBeNull();
    act(() => root.unmount());
  });

  it("an ineffective-but-named connection shows the dim inactive label", async () => {
    const { container, root } = await render([links.inactive]);
    const label = container.querySelector('[data-testid="member-identity-link-inactive"]');
    expect(label, "connectionEffective: false must render the label").not.toBeNull();
    expect(label!.textContent).toBe("members.identityLinkInactive");
    act(() => root.unmount());
  });

  it("a fully-deleted (gone) connection shows ONLY the gone fallback, not the inactive label too", async () => {
    const { container, root } = await render([links.gone]);
    expect(container.querySelector('[data-testid="member-identity-link-inactive"]'), "gone already reads as absent — no second label").toBeNull();
    expect(container.textContent).toContain("members.identitiesConnectionGone");
    act(() => root.unmount());
  });
});
