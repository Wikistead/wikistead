import { describe, it, expect } from "vitest";
import { SafeHtml, html, joinSafe, unsafeHtml, escapeHtml } from "./safe-html";

// ADR-045 / #88 — SafeHtml is the macro export/SSR XSS boundary made a compile-time guarantee.
// These are the RUNTIME half of that guarantee: html`` escapes every dynamic interpolation, nested
// SafeHtml composes WITHOUT double-escaping, and unsafeHtml is the sole (audited) raw pass-through.
// Assert on the produced HTML string (distinct pass/fail), not merely that a value is returned.

describe("escapeHtml", () => {
  it("escapes all five HTML-significant characters (incl. quotes for attribute safety)", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;");
  });

  it("escapes & FIRST so entities aren't double-encoded wrong", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;"); // the literal text "&lt;" → its & is escaped once
  });
});

describe("html`` tagged template", () => {
  it("returns a SafeHtml whose value is the built string", () => {
    const out = html`<p>hi</p>`;
    expect(out).toBeInstanceOf(SafeHtml);
    expect(out.value).toBe("<p>hi</p>");
    expect(out.toString()).toBe("<p>hi</p>");
  });

  it("ESCAPES a string interpolation — a <script> payload cannot break out of the markup", () => {
    const evil = "<script>alert(1)</script>";
    const out = html`<div>${evil}</div>`.value;
    expect(out).toBe("<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>");
    expect(out).not.toContain("<script>"); // the boundary: no live tag
  });

  it("ESCAPES an interpolation used inside an attribute (no attribute breakout)", () => {
    const evil = `x" onerror="alert(1)`;
    const out = html`<img alt="${evil}">`.value;
    expect(out).toContain("&quot;"); // the closing quote is escaped → cannot start a new attribute
    expect(out).not.toContain(`onerror="alert`);
  });

  it("stringifies and escapes a number interpolation", () => {
    expect(html`<b>${42}</b>`.value).toBe("<b>42</b>");
  });

  it("SPLICES a nested SafeHtml interpolation verbatim (composition, NO double-escaping)", () => {
    const inner = html`<em>${"<b>"}</em>`; // inner escapes its own text → <em>&lt;b&gt;</em>
    const outer = html`<p>${inner}</p>`.value;
    expect(outer).toBe("<p><em>&lt;b&gt;</em></p>"); // inner NOT re-escaped (no &amp;lt;)
    expect(outer).not.toContain("&amp;lt;");
  });
});

describe("joinSafe", () => {
  it("joins already-safe fragments preserving their (unescaped) markup", () => {
    const parts = ["a", "b"].map((c) => html`<li>${c}</li>`);
    expect(joinSafe(parts).value).toBe("<li>a</li><li>b</li>");
    expect(joinSafe(parts, "\n").value).toBe("<li>a</li>\n<li>b</li>");
  });

  it("does NOT re-escape the fragments it joins", () => {
    const parts = [html`<span>${"<x>"}</span>`];
    expect(joinSafe(parts).value).toBe("<span>&lt;x&gt;</span>"); // escaped once by html``, not again
  });
});

describe("unsafeHtml (audited escape hatch)", () => {
  it("passes its argument through verbatim as SafeHtml (the ONE place raw HTML is trusted)", () => {
    // Used by the table macro (body is already HTML) — the #85 server sanitizer owns cleaning it.
    const out = unsafeHtml("<table><tr><td>ok</td></tr></table>");
    expect(out).toBeInstanceOf(SafeHtml);
    expect(out.value).toBe("<table><tr><td>ok</td></tr></table>"); // NOT escaped — that is the point
  });
});
