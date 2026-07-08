import { describe, it, expect } from "vitest";
import { renderMarkdownToHtml } from "@wikistead/macro-render";
import { previewMacroRegistry } from "./preview-macro-registry";

// #267: the client preview registry renders first-party SafeHtml macros but MUST NOT render `:::table`
// (the one TRUSTED-passthrough / unsafeHtml macro) — the client preview has no downstream sanitizer, so a
// rendered `:::table` would inject a template author's raw HTML. This is the XSS boundary for the preview.
const out = (src: string) => renderMarkdownToHtml(src, previewMacroRegistry()).value;

describe("previewMacroRegistry — safe-by-construction subset (#267)", () => {
  it("renders a callout (SafeHtml macro), not degrade-to-source", () => {
    const h = out(":::note\nheads up\n:::");
    expect(h).toContain('<div class="callout callout-note">');
  });

  it("renders columns/tabs/details (all SafeHtml macros)", () => {
    expect(out(":::::columns\n:::column\nL\n:::\n:::column\nR\n:::\n:::::")).toContain('<div class="columns">');
    expect(out(":::details[More]\nbody\n:::")).toContain("<details><summary>");
  });

  it("does NOT render :::table (excluded) — a malicious table body is NOT injected as raw HTML", () => {
    const h = out(':::table\n<img src=x onerror="alert(1)">\n:::');
    // excluded → the block degrades to ESCAPED source; the raw <img onerror> never appears as live markup.
    expect(h).not.toContain("<img src=x onerror");
    expect(h).not.toContain('onerror="alert(1)"');
  });

  it("escapes ordinary dynamic values (the SafeHtml boundary holds)", () => {
    expect(out(":::note\n<script>evil()</script>\n:::")).not.toContain("<script>evil()</script>");
  });
});
