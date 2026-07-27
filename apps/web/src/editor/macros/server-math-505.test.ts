import { describe, it, expect } from "vitest";
import { renderMarkdownToHtml, findMathSpans, renderMathHtml } from "@wikistead/macro-render";

// #505 / #207 / #85 (ADR-191): the DOM-free renderer — the one the export, the public page and (per
// ADR-191) the print sheet all come from — used to pass TeX straight through, so a page that read as
// mathematics on screen printed as raw `$x^2$`. The acceptance for the print work is explicit: every
// rendered element is in scope and none may break in print; math was the element left outside.
//
// The delimiter rules MIRROR the editor's findMath (live-preview/math.ts). These cases are what keep the
// two honest: if the screen and the static render disagree about what math IS, print disagrees with the
// screen — the exact drift ADR-191 exists to close.
describe("#505: math spans on the static path (mirrors the editor's rules)", () => {
  const texOf = (s: string) => findMathSpans(s).map((m) => `${m.display ? "block" : "inline"}:${m.tex}`);

  it("finds inline and block math", () => {
    expect(texOf("before $x^2$ after")).toEqual(["inline:x^2"]);
    expect(texOf("$$\n\\int_0^1 x\\,dx\n$$")).toEqual(["block:\\int_0^1 x\\,dx"]);
  });

  it("leaves prose about money alone (the Pandoc guards, #141)", () => {
    expect(texOf("it costs $5 and $6 total"), "closing $ preceded by a space").toEqual([]);
    expect(texOf("$5 and$6"), "opening $ followed by a digit is fine, but the pair must not span prose").toEqual([]);
    expect(texOf("$100$200"), "closing $ runs into a digit").toEqual([]);
  });

  it("respects an escaped delimiter", () => {
    expect(texOf("\\$x^2\\$")).toEqual([]);
  });

  it("does not chop a block in half with the inline scan", () => {
    expect(texOf("$$a+b$$")).toEqual(["block:a+b"]);
  });

  it("renders to self-contained MathML — nothing for a printed document to 404 on", () => {
    const out = renderMathHtml("x^2", false)!.toString();
    expect(out).toContain("<math");
    expect(out, "no stylesheet/font dependency travels with the export").not.toContain("stylesheet");
  });

  it("an unknown command still renders (strict:warn + throwOnError:false) instead of throwing", () => {
    expect(renderMathHtml("\\thisIsNotACommand{}", false)).not.toBeNull();
  });
});

describe("#505: math in the canonical HTML", () => {
  it("renders math in prose instead of emitting the TeX", () => {
    const out = renderMarkdownToHtml("Euler: $e^{i\\pi}+1=0$ done").toString();
    expect(out, "the export used to print the dollars verbatim").toContain("<math");
    expect(out).not.toContain("$e^{i\\pi}+1=0$");
  });

  it("leaves a fence alone — code that looks like math is code, structurally", () => {
    const out = renderMarkdownToHtml("```\nprice = $x$ dollars\n```").toString();
    expect(out, "a fence body never reaches the text sink").not.toContain("<math");
    expect(out).toContain("price = $x$ dollars");
  });

  it("leaves an inline code span alone too", () => {
    const out = renderMarkdownToHtml("use `$x$` literally").toString();
    expect(out).not.toContain("<math");
  });

  // The security property is that a dangerous URL never becomes a LINK, and that markup in the TeX never
  // becomes markup in the output. Measured: with trust:false KaTeX renders \href as red error text and
  // emits no <a>/href at all — the URL survives only inside the inert <annotation> that carries the TeX
  // source, as escaped text. Asserting "the string javascript: is absent" would be the wrong pin (it
  // would fail on that harmless echo while saying nothing about linkability).
  it("does not let TeX become a link (trust:false disables \\href)", () => {
    const out = renderMarkdownToHtml("$\\href{javascript:alert(1)}{x}$").toString();
    expect(out, "no anchor is produced at all").not.toMatch(/<a[\s>]/);
    expect(out, "and no href attribute").not.toMatch(/href\s*=/);
    expect(out).not.toContain("<script");
  });

  it("does not let markup in the TeX escape into the document", () => {
    for (const tex of ["</math><script>alert(1)</script>", "x</annotation><img src=x onerror=alert(1)>", "\\text{<script>alert(1)</script>}"]) {
      const out = renderMarkdownToHtml(`$${tex}$`).toString();
      expect(out, tex).not.toMatch(/<script/i);
      expect(out, tex).not.toMatch(/<img/i); // escaped to &lt;img — text, not an element
    }
  });
});
