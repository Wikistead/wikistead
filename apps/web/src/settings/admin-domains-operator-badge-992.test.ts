// #992 / ADR-262 §3.3 the operator-registered badge and the disabled release control.
//
// The server-side guard (removeCustomDomain rejecting source='shell') shipped with its own test, but
// nothing pinned the WEB half of the same acceptance — "the row shows its origin, and the control that
// would 409 is disabled here too". Without this, a refactor could drop the badge, or leave the button
// enabled, and nothing would go red. Both directions are asserted: a change that swings the OTHER way
// (badging every row, or disabling every release control) must fail here as well.
//
// Also pins the fix: the tooltip travels through this repo's fast-tooltip mechanism (`data-tip`,
// tooltip-host.ts), not a native `title` — the thing #530 already bans and no-native-title.test.ts is
// supposed to catch (it missed this one because the attribute sat on its own source line).
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CustomDomain } from "../data/queries";

const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, reset: vi.fn() };
let domainRows: CustomDomain[] = [];

vi.mock("../session/SessionProvider", () => ({ useSession: () => ({ token: "t", status: "authed" }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en" } }),
}));
vi.mock("../ui/toast", () => ({ notify: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../data/queries", () => ({
  useCustomDomains: () => ({ data: domainRows, isPending: false, error: null }),
  useAddCustomDomain: () => idle,
  useVerifyCustomDomain: () => idle,
  useReleaseCustomDomain: () => idle,
}));

const SHELL_ROW: CustomDomain = {
  domain: "gw.example.com", status: "verified", verifiedAt: "2026-08-01T00:00:00Z",
  challengeRecord: "_wikistead-challenge.gw.example.com", challengeValue: "abc123",
  source: "shell",
};
const DNS_ROW: CustomDomain = {
  domain: "docs.example.com", status: "verified", verifiedAt: "2026-08-01T00:00:00Z",
  challengeRecord: "_wikistead-challenge.docs.example.com", challengeValue: "def456",
  source: "dns",
};

// Attribute order on the rendered <button> depends on prop spread order, not on this file — matching
// on substring position would make the pin depend on an implementation detail nobody promised. Pull the
// one tag out and inspect it in isolation instead.
function releaseButtonTag(html: string): string {
  const match = html.match(/<button\b[^>]*data-testid="domain-release"[^>]*>/);
  if (!match) throw new Error("domain-release button not found in the rendered markup");
  return match[0];
}

// The `disabled:opacity-50` / `disabled:cursor-default` Tailwind variants live in the button's own
// class string on EVERY row, shell or not — a plain `\bdisabled\b` match hits those regardless of the
// actual attribute and would pass whether or not the control is really disabled. React's static
// renderer serialises the boolean HTML attribute as `disabled=""` when true and omits it entirely when
// false, so that exact form is what distinguishes the two.
const isDisabledTag = (tag: string): boolean => /\sdisabled=""/.test(tag);

describe("#992 the operator-managed row shows its origin and cannot be released here", () => {
  it("badges a shell row and disables its release control", async () => {
    domainRows = [SHELL_ROW];
    vi.resetModules();
    const { AdminDomainsTab } = await import("./AdminDomainsTab");
    const html = renderToStaticMarkup(createElement(AdminDomainsTab as never));
    expect(html).toContain('data-testid="domain-operator"');
    expect(isDisabledTag(releaseButtonTag(html))).toBe(true);
  });

  it("does not badge, or disable, an ordinary dns row", async () => {
    domainRows = [DNS_ROW];
    vi.resetModules();
    const { AdminDomainsTab } = await import("./AdminDomainsTab");
    const html = renderToStaticMarkup(createElement(AdminDomainsTab as never));
    expect(html).not.toContain('data-testid="domain-operator"');
    expect(isDisabledTag(releaseButtonTag(html))).toBe(false);
  });

  it("carries the recovery tooltip through data-tip, not a native title", async () => {
    domainRows = [SHELL_ROW];
    vi.resetModules();
    const { AdminDomainsTab } = await import("./AdminDomainsTab");
    const html = renderToStaticMarkup(createElement(AdminDomainsTab as never));
    // The mocked `t` returns the key itself, so the tip text IS the translation key here.
    expect(html).toContain('data-tip="adminDomains.releaseOperator"');
    expect(releaseButtonTag(html)).not.toMatch(/\stitle=/);
  });

  it("carries no tip on an ordinary dns row (nothing to explain)", async () => {
    domainRows = [DNS_ROW];
    vi.resetModules();
    const { AdminDomainsTab } = await import("./AdminDomainsTab");
    const html = renderToStaticMarkup(createElement(AdminDomainsTab as never));
    expect(html).not.toContain("data-tip=");
  });
});
