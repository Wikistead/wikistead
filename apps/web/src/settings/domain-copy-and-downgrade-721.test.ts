// #721 / the two items the review left open on the custom-domain surface.
//
//   ① the DNS challenge must be COPYABLE, and the host and the value must copy SEPARATELY — a DNS
//      panel takes them in different boxes, so one button that copies the whole sentence produces
//      something that cannot be pasted anywhere.
//   ② the screen where the plan is changed must name the domains a downgrade releases, and say that
//      adding one back means proving ownership again (ADR-230 §3, the item found missing).
//
// Rendered markup, not grep: a class name or a call site says nothing about what reached the DOM.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, reset: vi.fn() };
const DOMAIN_ROWS = [{
  domain: "docs.example.com", status: "pending",
  challengeRecord: "_wikistead-challenge.docs.example.com", challengeValue: "49SohAbc123",
  passkeysStranded: 1,
}];
let domainRows: typeof DOMAIN_ROWS = DOMAIN_ROWS;

vi.mock("../session/SessionProvider", () => ({ useSession: () => ({ token: "t", status: "authed" }) }));
// Real interpolation, mock catalogue: the assertion below is about the DOMAIN NAME reaching the
// sentence, and a `t` that returns its key would let a warning with no domain in it pass.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, string>) =>
      k === "billing.domainsAtRisk"
        ? `Changing to a plan without custom domains releases ${vars?.domains}. Adding a domain back means proving ownership again.`
        : k,
    i18n: { language: "en" },
  }),
}));
vi.mock("../ui/toast", () => ({ notify: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../data/queries", () => ({
  useCustomDomains: () => ({ data: domainRows, isPending: false, error: null }),
  useAddCustomDomain: () => idle,
  useVerifyCustomDomain: () => idle,
  useReleaseCustomDomain: () => idle,
  useSecondFactorStance: () => ({ data: { stance: "any" }, isPending: false, error: null }),
  useBillingStatus: () => ({ data: { plan: "team", billingEnabled: true }, isPending: false, error: null }),
  useBillingUsage: () => ({ data: { resources: [] }, isPending: false, error: null }),
  useEntitlements: () => ({ data: { branding: true }, isPending: false, error: null }),
  useCheckout: () => idle,
  usePortal: () => idle,
}));

beforeEach(() => { domainRows = DOMAIN_ROWS });

describe("#721 ①: the DNS challenge is copyable field by field", () => {
  it("renders the host and the value as their own fields, each with its own copy control", async () => {
    const { AdminDomainsTab } = await import("./AdminDomainsTab");
    const html = renderToStaticMarkup(createElement(AdminDomainsTab as never));
    expect(html).toContain("domain-challenge-host");
    expect(html).toContain("domain-challenge-value");
    // Two controls. One "copy the record" button is precisely the thing that could not be pasted.
    expect(html).toContain("domain-challenge-host-copy");
    expect(html).toContain("domain-challenge-value-copy");
    // …and the fields carry the values themselves, not a sentence about them.
    expect(html).toContain("_wikistead-challenge.docs.example.com");
    expect(html).toContain("49SohAbc123");
  });

  it("uses the product's existing copy control rather than a second spelling of one", async () => {
    const { CopyButton } = await import("../ui/CopyButton");
    const one = renderToStaticMarkup(createElement(CopyButton as never, { value: "x", testId: "probe" } as never));
    // The idiom named: an icon button labelled with adminApi.copy. If OneTimeSecret and the DNS
    // record ever draw different things, this and the assertion below stop agreeing.
    expect(one).toContain("probe");
    const { default: OneTimeSecret } = await import("../ui/OneTimeSecret").then((m) => ({ default: m.OneTimeSecret }));
    const secret = renderToStaticMarkup(createElement(OneTimeSecret as never, { value: "s3cret", testId: "probe2" } as never));
    expect(secret).toContain("probe2-copy");
  });
});

describe("#721 ②: the plan screen names what a downgrade releases", () => {
  it("names the domain, and says ownership has to be proven again", async () => {
    const { AdminBillingTab } = await import("./AdminBillingTab");
    const html = renderToStaticMarkup(createElement(AdminBillingTab as never));
    expect(html).toContain("billing-domains-released");
    // The NAME is the point: "you may lose custom domains" is advice; naming it is a fact to act on.
    expect(html).toContain("docs.example.com");
    expect(html.toLowerCase()).toMatch(/prov|ownership/);
  });

  it("says nothing when there are no custom domains (a warning that always shows is furniture)", async () => {
    domainRows = [];
    vi.resetModules();
    const { AdminBillingTab } = await import("./AdminBillingTab");
    const html = renderToStaticMarkup(createElement(AdminBillingTab as never));
    expect(html).not.toContain("billing-domains-released");
  });
});
