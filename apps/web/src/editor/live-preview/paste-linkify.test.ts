// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { linkifyPaste } from "./paste-linkify";

// #223: the pure linkify decision. XSS is delegated to the SAME safeHref (no new boundary), so the
// anti-tests here fix that a dangerous scheme NEVER produces a link (plain-paste fallback), for both the
// text/plain (bare URL) and text/html (rich link) paths.
const call = (text: string, html = "", selectedText = "") => linkifyPaste({ text, html, selectedText });

describe("#223 linkifyPaste", () => {
  it("linkifies a bare http/https URL to [url](url)", () => {
    expect(call("https://example.com/a")).toBe("[https://example.com/a](https://example.com/a)");
    expect(call("http://x.test")).toBe("[http://x.test](http://x.test)");
  });

  it("wraps the SELECTION as the anchor when text is selected", () => {
    expect(call("https://example.com", "", "my site")).toBe("[my site](https://example.com)");
  });

  it("does NOT linkify a scheme-less / www. / plain string (v1)", () => {
    expect(call("www.example.com")).toBeNull();
    expect(call("example.com")).toBeNull();
    expect(call("just some text")).toBeNull();
    expect(call("ftp://host/f")).toBeNull();
  });

  it("NEVER linkifies a dangerous-scheme bare URL (plain paste)", () => {
    expect(call("javascript:alert(1)")).toBeNull();
    expect(call("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(call("vbscript:msgbox(1)")).toBeNull();
  });

  it("normalizes a rich <a href> paste to [text](href)", () => {
    expect(call("", '<a href="https://example.com/p">Docs</a>')).toBe("[Docs](https://example.com/p)");
  });

  it("does NOT linkify a rich link with a dangerous href (plain paste)", () => {
    expect(call("click", '<a href="javascript:alert(1)">click</a>')).toBeNull();
    expect(call("x", '<a href="data:text/html,x">x</a>')).toBeNull();
  });

  it("leaves a rich paste with extra content around the link untouched (default paste)", () => {
    expect(call("a b", '<p>a <a href="https://x.test">b</a> c</p>')).toBeNull();
    expect(call("", '<a href="https://a.test">a</a><a href="https://b.test">b</a>')).toBeNull();
  });

  it("angle-wraps a URL containing parentheses so the Markdown link doesn't break", () => {
    expect(call("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe("[https://en.wikipedia.org/wiki/Foo_(bar)](<https://en.wikipedia.org/wiki/Foo_(bar)>)");
  });

  it("escapes []/backslash in the anchor text so it can't break out of the link syntax", () => {
    expect(call("https://x.test", "", "a]b[c")).toBe("[a\\]b\\[c](https://x.test)");
  });

  it("HTML link text with markup is taken as textContent (no innerHTML), href scheme-checked", () => {
    // the anchor's visible text is used verbatim (via textContent); a nested <img onerror> is not executed
    // by DOMParser and contributes no live node — only the text survives.
    expect(call("", '<a href="https://x.test"><b>bold</b> link</a>')).toBe("[bold link](https://x.test)");
  });
});
