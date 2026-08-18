// #723a surface must not show the subscriber's view while it is still finding out whether
// the workspace is entitled.
//
// What shipped: `locked` is derived from the request's ERROR, and there is no error while the
// request is in flight — so a workspace without the entitlement rendered the full surface (the SCIM
// endpoint, the token field, the "create token" button) and only then swapped it for the upgrade
// notice. Not a race: the 403 always comes, so the flash always happened. The user saw it on both
// tabs added that week, and the same shape was already shipping on the audit log.
//
// Why the existing tests missed it: they hand the component an error from the first render, so they
// enter through the `locked` branch and never pass through the pending window at all. A test that
// starts after the interesting moment cannot see what happens during it.
//
// This renders each surface in the PENDING state and asserts the subscriber's controls are absent
// from the markup. The three are checked from one table rather than three copies, so the fourth
// entitlement-gated tab is one row away — and `AdminSamlSection` is included as the positive
// control, since it is the one surface that already guarded and must stay guarded.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The queries each surface calls. Pending means: no data, no error, isPending true — which is what
// react-query reports before the first response and what the shipped bug read as "not locked".
const PENDING = { data: undefined, error: null, isPending: true, isLoading: true } as const;
const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, reset: vi.fn() };

vi.mock("../data/queries", () => ({
  useScimTokens: () => PENDING,
  useCreateScimToken: () => idle,
  useRevokeScimToken: () => idle,
  useCustomDomains: () => PENDING,
  useAddCustomDomain: () => idle,
  useVerifyCustomDomain: () => idle,
  useReleaseCustomDomain: () => idle,
  useAuditLog: () => PENDING,
  useAuditVerify: () => idle,
  useTenantSaml: () => PENDING,
  useUpdateTenantSaml: () => idle,
  useSecondFactorStance: () => PENDING,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en" } }) }));
// The audit surface reads the session for the actor's own name. Provided here rather than wrapped in
// a provider: this test is about one render decision, and a real provider would drag the query
// client and the router in with it.
vi.mock("../session/SessionProvider", () => ({ useSession: () => ({ sub: "u1", role: "admin", tenant: { plan: "team" } }) }));
// The audit surface also opens the access-transparency panel, which calls useQuery directly rather
// than through the data layer. Stubbed so this file stays about one render decision; a real client
// would make the test depend on fetch behaviour it is not measuring.
vi.mock("@tanstack/react-query", () => ({ useQuery: () => PENDING, useMutation: () => idle, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));

const { AdminScimTab } = await import("./AdminScimTab");
const { AdminDomainsTab } = await import("./AdminDomainsTab");
const { AdminAuditTab } = await import("./AdminAuditTab");

// Each row: the surface, and a control that only a SUBSCRIBER should ever see. The marker is a
// testid the surface itself carries, so it cannot drift into checking for prose.
const SURFACES: { name: string; component: unknown; subscriberOnly: string[] }[] = [
  { name: "SCIM", component: AdminScimTab, subscriberOnly: ["scim-token-name", "scim-token-create"] },
  { name: "custom domains", component: AdminDomainsTab, subscriberOnly: ["domain-input", "domain-add"] },
  { name: "audit log", component: AdminAuditTab, subscriberOnly: ["audit-verify"] },
];

describe("#723: no subscriber view while the entitlement is still unknown", () => {
  for (const s of SURFACES) {
    it(`${s.name}: renders none of the subscriber's controls while pending`, () => {
      const html = renderToStaticMarkup(createElement(s.component as never));
      for (const testid of s.subscriberOnly) {
        expect(html, `${s.name} drew ${testid} before knowing whether the workspace is entitled`).not.toContain(testid);
      }
    });
  }

  // The assertion above passes trivially if the testids were renamed or the mock stopped matching
  // the real hooks — "absent" is the easiest thing in the world to be right about for the wrong
  // reason. So: the SAME components, given a successful response, must draw those controls.
  it("the markers are real: with data, every surface draws the controls this test looks for", async () => {
    vi.resetModules();
    const ok = { data: [], error: null, isPending: false, isLoading: false };
    vi.doMock("../data/queries", () => ({
      useScimTokens: () => ok,
      useCreateScimToken: () => idle,
      useRevokeScimToken: () => idle,
      useCustomDomains: () => ok,
      useAddCustomDomain: () => idle,
      useVerifyCustomDomain: () => idle,
      useReleaseCustomDomain: () => idle,
      useAuditLog: () => ok,
      useAuditVerify: () => idle,
      useTenantSaml: () => ok,
      useUpdateTenantSaml: () => idle,
      useSecondFactorStance: () => ok,
    }));
    vi.doMock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en" } }) }));
    vi.doMock("../session/SessionProvider", () => ({ useSession: () => ({ sub: "u1", role: "admin", tenant: { plan: "team" } }) }));
    vi.doMock("@tanstack/react-query", () => ({ useQuery: () => ok, useMutation: () => idle, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
    const live = {
      SCIM: (await import("./AdminScimTab")).AdminScimTab,
      "custom domains": (await import("./AdminDomainsTab")).AdminDomainsTab,
      "audit log": (await import("./AdminAuditTab")).AdminAuditTab,
    } as Record<string, unknown>;
    for (const s of SURFACES) {
      const html = renderToStaticMarkup(createElement(live[s.name] as never));
      for (const testid of s.subscriberOnly) {
        expect(html, `${s.name}: ${testid} is not a marker this surface actually renders`).toContain(testid);
      }
    }
  });
});
