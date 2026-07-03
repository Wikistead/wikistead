import { describe, it, expect } from "vitest";
import { renderMarkdownToHtml, html, builtinMacroRegistry, type MacroHtmlRegistry } from "@wikistead/macro-render";

// #85 / ADR-059+085: the DOM-free server-side markdown → HTML renderer (published/static export). It
// mirrors the editor's DOM renderer from the SAME grammar + macro contract, emits SafeHtml (the #88 XSS
// boundary), dispatches macros via an injected registry, and badges exportFidelity="degrade" blocks.
const out = (src: string, macros?: MacroHtmlRegistry) => renderMarkdownToHtml(src, macros).value;

describe("renderMarkdownToHtml — standard markdown (#85)", () => {
  it("renders headings, paragraphs, inline emphasis/code and lists", () => {
    const h = out("# Title\n\npara **bold** _i_ `c`\n\n- a\n- b\n");
    expect(h).toContain("<h1>Title</h1>");
    expect(h).toContain("<strong>bold</strong>");
    expect(h).toContain("<em>i</em>");
    expect(h).toContain("<code>c</code>");
    expect(h).toContain("<ul><li><p>a</p></li>\n<li><p>b</p></li></ul>"); // @lezer wraps item content in <p>
  });

  it("renders a safe link and rel-hardens it", () => {
    const h = out("[text](https://example.com)");
    expect(h).toContain('<a href="https://example.com" rel="noopener noreferrer nofollow">text</a>');
  });

  it("renders a plain code fence as <pre><code> (escaped)", () => {
    const h = out("```\n<not a tag>\n```");
    expect(h).toContain("<pre><code>&lt;not a tag&gt;");
  });
});

describe("renderMarkdownToHtml — XSS boundary (#88)", () => {
  it("escapes raw HTML in text (never emits live markup)", () => {
    const h = out("hello <img src=x onerror=alert(1)> world");
    expect(h).not.toContain("<img src=x");
    expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("neutralises a javascript: link URL (renders as a non-link span)", () => {
    const h = out("[click](javascript:alert(1))");
    expect(h).not.toContain("href=\"javascript:");
    expect(h).toContain("<span>click</span>"); // href rejected → not an anchor
  });
});

// A registry with a preserve macro, a degrade macro, and a throwing macro.
const macros: MacroHtmlRegistry = {
  fence: (lang) =>
    lang === "keepme" ? { exportFidelity: "preserve", htmlRender: (b) => html`<figure class="keep">${b}</figure>` }
    : lang === "boom" ? { exportFidelity: "degrade", htmlRender: () => { throw new Error("nope"); } }
    : undefined,
  directive: (name) =>
    name === "simplified" ? { exportFidelity: "degrade", htmlRender: (b) => html`<div class="s">${b}</div>` }
    : undefined,
};

describe("renderMarkdownToHtml — macro dispatch + fidelity (#85)", () => {
  it("dispatches a fence macro to its htmlRender; preserve fidelity has NO badge", () => {
    const h = out("```keepme\ndiagram source\n```", macros);
    expect(h).toContain('<figure class="keep">diagram source</figure>');
    expect(h).not.toContain("wks-fidelity-degrade"); // preserve → plain, no badge
  });

  it("wraps a DEGRADE directive macro with a fidelity badge (ADR-059 (c))", () => {
    const h = out(":::simplified\nbody text\n:::", macros);
    expect(h).toContain('data-fidelity="degrade"');
    expect(h).toContain('data-macro="simplified"');
    expect(h).toContain("wks-fidelity-badge"); // the "simplified for export" indicator
    expect(h).toContain('<div class="s">body text</div>'); // the macro's own output, inside the wrapper
  });

  it("a macro that THROWS falls back to plain code and never breaks the render", () => {
    const h = out("intro\n\n```boom\nx\n```\n\nafter", macros);
    expect(h).toContain("<pre><code>x"); // fell back to plain code
    expect(h).toContain("<p>intro</p>");
    expect(h).toContain("<p>after</p>"); // surrounding content still rendered
  });

  it("an UNKNOWN directive renders as a generic box (content preserved), not dropped", () => {
    const h = out(":::whoknows\nkept content\n:::", macros);
    expect(h).toContain('<div class="wks-directive">');
    expect(h).toContain("kept content");
  });
});

// #85 slice 2: the SERVER export dispatches the real built-in M2 directive htmlRenders (single source
// of truth in @wikistead/macro-render — the same code the editor uses), via builtinMacroRegistry().
describe("renderMarkdownToHtml — built-in M2 directives (#85 slice 2)", () => {
  const reg = builtinMacroRegistry();
  it("columns → each column's content in order (sequential, nothing dropped)", () => {
    const h = out(":::::columns\n:::column\nleft body\n:::\n:::column\nright body\n:::\n:::::", reg);
    expect(h).toContain('<div class="columns">');
    expect(h.indexOf("left body")).toBeGreaterThanOrEqual(0);
    expect(h.indexOf("right body")).toBeGreaterThan(h.indexOf("left body"));
  });
  it("tabs → each label as a visible heading + body (meaning-preserving degrade)", () => {
    const h = out("::::::tabs\n:::tab[Setup]\nstep one\n:::\n:::tab[Usage]\nrun it\n:::\n::::::", reg);
    expect(h).toContain('<div class="tabs">');
    expect(h).toContain('<h3 class="tab-label">Setup</h3>');
    expect(h).toContain('<h3 class="tab-label">Usage</h3>');
  });
  it("details → standard <details>", () => {
    const h = out(":::details[More]\nhidden body\n:::", reg);
    expect(h).toContain("<details><summary>");
    expect(h).toContain("hidden body");
  });
  it("typed callouts → a per-type wrapper (note / warning), body escaped", () => {
    expect(out(":::note\nheads up\n:::", reg)).toContain('<div class="callout callout-note">');
    expect(out(":::warning\n<b>careful</b>\n:::", reg)).toContain('<div class="callout callout-warning">');
    expect(out(":::warning\n<b>careful</b>\n:::", reg)).not.toContain("<b>careful</b>"); // escaped
  });
  it("fence macros dispatch: mermaid/plantuml → <pre>, plantuml is degrade-badged", () => {
    const m = out("```mermaid\ngraph TD; A-->B\n```", reg);
    expect(m).toContain('<pre class="mermaid">graph TD; A--&gt;B'); // body escaped inside pre
    expect(m).not.toContain("wks-fidelity-degrade"); // mermaid = preserve, no badge
    const p = out("```plantuml\n@startuml\n@enduml\n```", reg);
    expect(p).toContain('<pre class="plantuml">');
    expect(p).toContain('data-fidelity="degrade"'); // plantuml = degrade → badged
  });
  it(":::transclude → a data-page placeholder (page ref escaped)", () => {
    expect(out(":::transclude\npage-123\n:::", reg)).toContain('<div class="transclude" data-page="page-123">');
  });
  it(":::embed → degrades to a link in exported HTML (no iframe; url escaped)", () => {
    const h = out(":::embed\nhttps://youtube.com/embed/x\n:::", reg);
    expect(h).toContain('<a class="embed-link" href="https://youtube.com/embed/x"');
    expect(h.toLowerCase()).not.toContain("<iframe"); // server export never emits an iframe
    expect(h).toContain('data-fidelity="degrade"'); // embed = degrade → badged
  });
  it(":::embed with a non-http(s) url renders inert text in a span, never a live link", () => {
    const h = out(":::embed\njavascript:alert(1)\n:::", reg);
    expect(h.toLowerCase()).not.toContain('href="javascript:'); // never a link carrying the scheme
    expect(h).toContain('<span class="embed-link">'); // rendered as inert text instead
  });
});
