// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { isAllowlistedEmbed, buildEmbedElement, unembeddableGuidance } from "./embed";

// #108 / ADR-071 (comment 551): external embeds are client-direct sandboxed iframes for
// operator-allowlisted hosts ONLY; everything else degrades to a link. These verify the
// allowlist decision (the single source of truth) and the sandboxed-iframe / degrade DOM.
describe("isAllowlistedEmbed", () => {
  const allow = ["youtube.com", "player.vimeo.com"];

  it("allows an exact allowlisted host over https", () => {
    expect(isAllowlistedEmbed("https://youtube.com/embed/x", allow)).toBe(true);
    expect(isAllowlistedEmbed("https://player.vimeo.com/video/1", allow)).toBe(true);
  });

  it("allows a subdomain of an allowlisted host", () => {
    expect(isAllowlistedEmbed("https://www.youtube.com/embed/x", allow)).toBe(true);
  });

  it("rejects a look-alike host that merely ends with the allowlisted string", () => {
    expect(isAllowlistedEmbed("https://evilyoutube.com/x", allow)).toBe(false);
    expect(isAllowlistedEmbed("https://youtube.com.evil.test/x", allow)).toBe(false);
  });

  it("rejects a non-allowlisted host", () => {
    expect(isAllowlistedEmbed("https://example.com/x", allow)).toBe(false);
  });

  it("rejects non-https schemes even for an allowlisted host", () => {
    expect(isAllowlistedEmbed("http://youtube.com/x", allow)).toBe(false);
    expect(isAllowlistedEmbed("javascript:alert(1)", allow)).toBe(false);
    expect(isAllowlistedEmbed("data:text/html,<script>", allow)).toBe(false);
  });

  it("rejects everything when the allowlist is empty (opt-in off by default)", () => {
    expect(isAllowlistedEmbed("https://youtube.com/x", [])).toBe(false);
  });

  it("does not throw on an unparseable URL", () => {
    expect(isAllowlistedEmbed("not a url", allow)).toBe(false);
  });

  // #108 (comment 643): security — a same-origin iframe with allow-scripts + allow-same-origin escapes
  // the sandbox and reaches the parent editor, so the app's OWN origin must NEVER be iframed even if an
  // admin mis-adds it to the allowlist.
  it("rejects the app's own origin even when it is in the allowlist (sandbox-escape guard)", () => {
    const w = window as unknown as { happyDOM?: { setURL(u: string): void } };
    w.happyDOM?.setURL("https://app.example.test/p/x");
    try {
      expect(isAllowlistedEmbed("https://app.example.test/embed/y", ["app.example.test"])).toBe(false);
    } finally {
      w.happyDOM?.setURL("http://localhost/");
    }
  });

  it("strips a userinfo bypass to the real host (youtube.com@evil.com → not allowlisted)", () => {
    expect(isAllowlistedEmbed("https://youtube.com@evil.com/x", ["youtube.com"])).toBe(false);
  });
});

describe("buildEmbedElement", () => {
  const allow = ["youtube.com"];

  it("renders a sandboxed, no-referrer iframe for an allowlisted host", () => {
    const el = buildEmbedElement("https://www.youtube.com/embed/x", allow);
    expect(el.tagName).toBe("IFRAME");
    const sandbox = el.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    // The minimal sandbox must NOT grant top-navigation / modals / downloads.
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(sandbox).not.toContain("allow-modals");
    // #108 bounce: strict-origin-when-cross-origin (NOT no-referrer, which triggers YouTube error 153).
    // Sends only the origin cross-origin — path/content still private.
    expect(el.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
    expect(el.getAttribute("referrerpolicy")).not.toBe("no-referrer");
    expect(el.getAttribute("src")).toBe("https://www.youtube.com/embed/x");
  });

  it("degrades a non-allowlisted URL to an inert external link (Open formats)", () => {
    const el = buildEmbedElement("https://example.com/x", allow);
    expect(el.tagName).toBe("A");
    expect(el.getAttribute("href")).toBe("https://example.com/x");
    expect(el.getAttribute("rel")).toContain("noreferrer");
    expect(el.getAttribute("rel")).toContain("nofollow");
  });

  // #319 (anon-XSS gate): a dangerous scheme in the body must NEVER become a clickable href — the
  // degrade `<a>` is a LIVE element (unlike the textContent degrade of the public reader today), so a raw
  // `javascript:` href would be a one-click stored XSS once this DOM is the anonymous public reader.
  it("degrades a javascript: URL to INERT PLAIN TEXT — never an iframe, never a clickable href", () => {
    const el = buildEmbedElement("javascript:alert(document.cookie)", allow);
    expect(el.tagName).toBe("SPAN"); // not an <a> — no dangerous href to click
    expect(el.getAttribute("href")).toBeNull();
    expect(el.textContent).toBe("javascript:alert(document.cookie)"); // shown as text, harmless
  });

  it("degrades data:/vbscript:/file: schemes to inert text too (shared safeHref policy)", () => {
    for (const bad of ["data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "file:///etc/passwd", "java\tscript:alert(1)"]) {
      const el = buildEmbedElement(bad, allow);
      expect(el.tagName, `${bad} must not be a link`).toBe("SPAN");
      expect(el.getAttribute("href")).toBeNull();
    }
  });

  it("degrades the app's own origin to a link even if allowlisted (#108 comment 643)", () => {
    const w = window as unknown as { happyDOM?: { setURL(u: string): void } };
    w.happyDOM?.setURL("https://app.example.test/p/x");
    try {
      const el = buildEmbedElement("https://app.example.test/embed/y", ["app.example.test"]);
      expect(el.tagName).toBe("A"); // never an iframe on our own origin (sandbox-escape guard)
    } finally {
      w.happyDOM?.setURL("http://localhost/");
    }
  });
});

// #908: a URL whose host rejects framing (X-Frame-Options/CSP) drew a blank iframe with no explanation
// — the browser's own refusal, inside an iframe the product controls but never gets to annotate. These
// verify the known-bad-shape detector itself; buildEmbedElement's own describe block below verifies it
// is consulted ONLY inside the allowlisted (would-be-iframe) branch — a host that was never allowlisted
// must keep degrading to a plain link exactly as before.
describe("unembeddableGuidance", () => {
  it("flags Google's Maps share-link shortener regardless of path", () => {
    expect(unembeddableGuidance("https://maps.app.goo.gl/abc123")).toBe("macro.embedUnembeddableGoogleMaps");
  });

  it("flags the bare goo.gl/maps/… shortener form", () => {
    expect(unembeddableGuidance("https://goo.gl/maps/xyz")).toBe("macro.embedUnembeddableGoogleMaps");
    expect(unembeddableGuidance("https://www.goo.gl/maps/xyz")).toBe("macro.embedUnembeddableGoogleMaps");
  });

  it("flags an ordinary google.com/maps/… page (not the embed path)", () => {
    expect(unembeddableGuidance("https://www.google.com/maps/place/Tokyo")).toBe("macro.embedUnembeddableGoogleMaps");
    expect(unembeddableGuidance("https://google.com/maps/@35,139,12z")).toBe("macro.embedUnembeddableGoogleMaps");
  });

  it("flags /maps with no trailing slash, maps.google.com, and other Google ccTLDs", () => {
    expect(unembeddableGuidance("https://www.google.com/maps?q=Tokyo")).toBe("macro.embedUnembeddableGoogleMaps");
    expect(unembeddableGuidance("https://maps.google.com/maps/place/Tokyo")).toBe("macro.embedUnembeddableGoogleMaps");
    expect(unembeddableGuidance("https://www.google.co.jp/maps/place/Tokyo")).toBe("macro.embedUnembeddableGoogleMaps");
    expect(unembeddableGuidance("https://www.google.co.uk/maps/place/London")).toBe("macro.embedUnembeddableGoogleMaps");
  });

  it("does NOT flag the actual embeddable URL (Share → Embed a map), on any matched host", () => {
    expect(unembeddableGuidance("https://www.google.com/maps/embed?pb=!1m18")).toBeNull();
    expect(unembeddableGuidance("https://maps.google.com/maps/embed?pb=!1m18")).toBeNull();
  });

  it("does not flag an unrelated google.com page or a look-alike host", () => {
    expect(unembeddableGuidance("https://www.google.com/search?q=x")).toBeNull();
    expect(unembeddableGuidance("https://evilgoogle.com/maps/x")).toBeNull();
    expect(unembeddableGuidance("https://maps.app.goo.gl.evil.test/x")).toBeNull();
    expect(unembeddableGuidance("https://notgoo.gl/maps/x")).toBeNull();
  });

  it("does not flag an unrelated host", () => {
    expect(unembeddableGuidance("https://youtube.com/embed/x")).toBeNull();
  });

  it("does not throw on an unparseable URL", () => {
    expect(unembeddableGuidance("not a url")).toBeNull();
  });
});

describe("buildEmbedElement — known-unembeddable guidance", () => {
  it("renders the generic guidance sentence + a real link, never an iframe, when the host IS allowlisted", () => {
    const el = buildEmbedElement("https://maps.app.goo.gl/abc123", ["maps.app.goo.gl", "google.com"]);
    expect(el.tagName).not.toBe("IFRAME");
    expect(el.getAttribute("data-testid")).toBe("macro-embed-unembeddable");
    // #970: a GENERIC sentence (no vendor name) — the table stopped naming a vendor's text (§3.2).
    expect(el.textContent).toContain("This page can't be shown in a frame here.");
    // #970: always offers the way back — a dead end in kinder words is still a dead end.
    const link = el.querySelector('[data-testid="macro-embed-unembeddable-link"]');
    expect(link?.getAttribute("href")).toBe("https://maps.app.goo.gl/abc123");
  });

  it("still embeds the real Google Maps embed URL when google.com is allowlisted", () => {
    const el = buildEmbedElement("https://www.google.com/maps/embed?pb=!1m18", ["google.com"]);
    expect(el.tagName).toBe("IFRAME");
    expect(el.getAttribute("src")).toBe("https://www.google.com/maps/embed?pb=!1m18");
  });

  // #908 (regression found in review review): guidance must NEVER preempt the ordinary degrade-to-link
  // path. exportBrowser.ts and PrintSurface.tsx both call buildEmbedElement(url, []) — an empty
  // allowlist — specifically so an embed ALWAYS becomes a real, content-preserving link in a file or
  // printout nobody can re-edit; guidance text with no href would silently drop the URL (#207's
  // content-loss shape, reintroduced). A non-embeddable Maps URL with a host that was never
  // allowlisted must degrade exactly like any other non-allowlisted URL — real href, no guidance.
  it("a non-embeddable Maps URL degrades to a REAL LINK (not guidance) when the host is NOT allowlisted", () => {
    const el = buildEmbedElement("https://maps.app.goo.gl/abc123", []);
    expect(el.tagName).toBe("A");
    expect(el.getAttribute("data-testid")).toBe("macro-embed-degrade");
    expect(el.getAttribute("href")).toBe("https://maps.app.goo.gl/abc123"); // the URL is preserved, not swallowed
  });

  it("export/print's empty-allowlist call never produces guidance for ANY known-bad shape", () => {
    for (const url of ["https://maps.app.goo.gl/x", "https://www.google.com/maps/place/Tokyo", "https://goo.gl/maps/x"]) {
      const el = buildEmbedElement(url, []);
      expect(el.getAttribute("data-testid"), url).toBe("macro-embed-degrade");
      expect(el.getAttribute("href"), url).toBe(url);
    }
  });
});

// #970 / ADR-267 §3.1/§3.3: the host-mediated async probe. buildEmbedElement returns a LOADING
// placeholder synchronously (never an optimistic iframe — §3.3's note that showing-then-yanking an
// iframe on a late refusal reintroduces the exact opaque-frame flash #908 removed) and swaps once the
// probe resolves.
describe("buildEmbedElement — async frameability (opts.checkFrameability)", () => {
  const allow = ["youtube.com"];

  it("returns a loading placeholder synchronously — never an iframe before the probe resolves", () => {
    const el = buildEmbedElement("https://youtube.com/embed/x", allow, { checkFrameability: () => new Promise(() => {}) });
    expect(el.tagName).not.toBe("IFRAME");
    expect(el.getAttribute("data-testid")).toBe("macro-embed-loading");
  });

  it("swaps to the iframe when the probe resolves embeddable", async () => {
    const el = buildEmbedElement("https://youtube.com/embed/x", allow, { checkFrameability: async () => "embeddable" });
    await Promise.resolve().then(() => Promise.resolve()); // flush the microtask the .then() callback runs on
    expect(el.querySelector("iframe")).not.toBeNull();
    expect(el.getAttribute("data-testid")).toBe("macro-embed-external");
  });

  it("swaps to guidance (never an iframe) when the probe resolves refused", async () => {
    const el = buildEmbedElement("https://youtube.com/embed/x", allow, { checkFrameability: async () => "refused" });
    await Promise.resolve().then(() => Promise.resolve());
    expect(el.querySelector("iframe")).toBeNull();
    expect(el.querySelector('[data-testid="macro-embed-unembeddable-link"]')?.getAttribute("href")).toBe("https://youtube.com/embed/x");
  });

  it("⚠️ §3.3 fail-open: a REJECTING checker still ends in the iframe, never guidance", async () => {
    const el = buildEmbedElement("https://youtube.com/embed/x", allow, { checkFrameability: async () => { throw new Error("network"); } });
    await Promise.resolve().then(() => Promise.resolve());
    expect(el.querySelector("iframe"), "a probe failure must fail OPEN (#207's content-loss is the worse direction)").not.toBeNull();
  });

  it("calls the block-widget onMeasure hook after the async swap (height changed)", async () => {
    let measured = 0;
    buildEmbedElement("https://youtube.com/embed/x", allow, { checkFrameability: async () => "embeddable", onMeasure: () => { measured++; } });
    await Promise.resolve().then(() => Promise.resolve());
    expect(measured, "onMeasure must fire — the swap changes the block's height").toBe(1);
  });

  it("a non-allowlisted host never calls checkFrameability at all — the probe only ever sees a URL that would otherwise become an iframe", () => {
    let called = false;
    const el = buildEmbedElement("https://example.com/x", allow, { checkFrameability: async () => { called = true; return "embeddable"; } });
    expect(el.getAttribute("data-testid")).toBe("macro-embed-degrade");
    expect(called, "a URL that degrades to a link must never be probed").toBe(false);
  });
});
