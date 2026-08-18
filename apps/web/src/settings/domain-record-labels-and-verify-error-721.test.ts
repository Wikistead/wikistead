// #721the two things the review found on the custom-domain surface, measured on the
// rendered markup and on the mapping itself.
//
// ② " 2 " — the challenge was three fields and
// only the type named itself, so the person retyping it into a DNS panel (which takes host and
// value in DIFFERENT boxes, which is whysplit the copy buttons) could not tell which was
// which. Every field carries a persistent, visible name.
// ③ — the server answers `not_verified`, the most
// ordinary outcome on this screen, and the client threw it into the generic failure. A person
// then suspects the product instead of their DNS.
//
// The label assertions read the REAL catalogue, not a `t` that echoes its key: a key that renders
// nowhere and an empty string both look identical to a key-echoing stub, and "the field is named" is
// a claim about what a reader sees.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";

const lookup = (cat: unknown, key: string): string | undefined =>
  key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], cat) as string | undefined;

const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, reset: vi.fn() };

vi.mock("../session/SessionProvider", () => ({ useSession: () => ({ token: "t", status: "authed" }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string) => lookup(en, k) ?? k,
    i18n: { language: "en" },
  }),
}));
vi.mock("../ui/toast", () => ({ notify: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../data/queries", () => ({
  useCustomDomains: () => ({
    data: [{
      domain: "docs.example.com", status: "pending",
      challengeRecord: "_wikistead-challenge.docs.example.com", challengeValue: "49SohAbc123",
      passkeysStranded: 0,
    }],
    isPending: false, error: null,
  }),
  useAddCustomDomain: () => idle,
  useVerifyCustomDomain: () => idle,
  useReleaseCustomDomain: () => idle,
}));

const render = async () => {
  const { AdminDomainsTab } = await import("./AdminDomainsTab");
  return renderToStaticMarkup(createElement(AdminDomainsTab as never));
};

describe("#721②: each DNS field says what it is", () => {
  it("names the type, the host and the value in visible text", async () => {
    const html = await render();
    // The words themselves, from the catalogue. `>Host<` rather than "Host": the value
    // `_wikistead-challenge.docs.example.com` contains no such word, so this cannot pass by accident.
    for (const key of ["adminDomains.dnsTypeLabel", "adminDomains.dnsHostLabel", "adminDomains.dnsValueLabel"]) {
      const label = lookup(en, key);
      expect(label, `${key} is missing from the English catalogue`).toBeTruthy();
      expect(html, `${key} renders nowhere`).toContain(`>${label}<`);
    }
  });

  it("puts each name with its own field, in reading order", async () => {
    const html = await render();
    const at = (testId: string) => {
      const i = html.indexOf(`data-testid="${testId}"`);
      expect(i, `${testId} is not in the markup`).toBeGreaterThan(-1);
      return i;
    };
    // A name floating anywhere in the block would satisfy the test above; it has to precede the
    // field it names, and the two rows must not interleave.
    expect(at("domain-challenge-type-label")).toBeLessThan(at("domain-challenge-type"));
    expect(at("domain-challenge-type")).toBeLessThan(at("domain-challenge-host-label"));
    expect(at("domain-challenge-host-label")).toBeLessThan(at("domain-challenge-host"));
    expect(at("domain-challenge-host")).toBeLessThan(at("domain-challenge-host-copy"));
    expect(at("domain-challenge-host-copy")).toBeLessThan(at("domain-challenge-value-label"));
    expect(at("domain-challenge-value-label")).toBeLessThan(at("domain-challenge-value"));
    expect(at("domain-challenge-value")).toBeLessThan(at("domain-challenge-value-copy"));
  });

  it("keeps the names on screen rather than hiding them from sight", async () => {
    const html = await render();
    //asked for a . The copy buttons already carry aria-labels and tooltips,
    // and those are precisely what did not help while reading, so a screen-reader-only or
    // hover-only name would be the same defect wearing a different hat.
    for (const testId of ["domain-challenge-type-label", "domain-challenge-host-label", "domain-challenge-value-label"]) {
      const at = html.indexOf(`data-testid="${testId}"`);
      const tag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
      expect(tag, `${testId} is hidden`).not.toMatch(/sr-only|aria-hidden|opacity-0|\bhidden\b/);
    }
  });

  it("stops showing the record once the domain is verified", async () => {
    // The instruction exists to be followed; a verified domain has no record left to publish.
    vi.resetModules();
    vi.doMock("../data/queries", () => ({
      useCustomDomains: () => ({
        data: [{ domain: "docs.example.com", status: "verified", challengeRecord: "_wikistead-challenge.docs.example.com", challengeValue: "49SohAbc123" }],
        isPending: false, error: null,
      }),
      useAddCustomDomain: () => idle, useVerifyCustomDomain: () => idle, useReleaseCustomDomain: () => idle,
    }));
    const html = await render();
    expect(html).not.toContain("domain-challenge");
    expect(html).toContain(lookup(en, "adminDomains.verified")!);
    vi.doUnmock("../data/queries");
    vi.resetModules();
  });
});

describe("#721③: a failed verification says which failure it was", () => {
  it("gives not_verified its own sentence instead of the generic failure", async () => {
    const { verifyErrorCopyKey } = await import("./AdminDomainsTab");
    const key = verifyErrorCopyKey("not_verified");
    expect(key).not.toBe("toast.actionFailed");
    expect(lookup(en, key), `${key} has no English copy`).toBeTruthy();
    expect(lookup(ja, key), `${key} has no Japanese copy`).toBeTruthy();
  });

  it("says what was looked for and that waiting is the fix, in both locales", async () => {
    const { verifyErrorCopyKey } = await import("./AdminDomainsTab");
    const key = verifyErrorCopyKey("not_verified");
    // The record type, because that is what the reader has to go and check, and the propagation
    // delay, because "publish it and press verify straight away" is the common way to land here.
    expect(lookup(en, key)!).toContain("TXT");
    expect(lookup(en, key)!.toLowerCase()).toMatch(/wait|minute|spread|propagat/);
    expect(lookup(ja, key)!).toContain("TXT");
    expect(lookup(ja, key)!).toMatch(/待|分/);
  });

  it("leaves the two passkey refusals on their own sentences, and everything else on the generic one", async () => {
    const { verifyErrorCopyKey } = await import("./AdminDomainsTab");
    expect(verifyErrorCopyKey("passkey_stance_blocks_move")).toBe("adminDomains.stanceBlocked");
    expect(verifyErrorCopyKey("passkeys_would_be_lost")).toBe("adminDomains.passkeyRetry");
    // An unknown code has no sentence to earn: the generic failure is the honest answer there.
    expect(verifyErrorCopyKey("something_new")).toBe("toast.actionFailed");
    expect(verifyErrorCopyKey(undefined)).toBe("toast.actionFailed");
  });
});
