// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { isAllowlistedEmbed, buildEmbedElement } from "./embed";

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
