import { describe, it, expect } from "vitest";
import { renderMarkdownToHtml, html, builtinMacroRegistry, tableHtmlRender, type MacroHtmlRegistry } from "@wikistead/macro-render";
import { toHtml, type TCell } from "./table-model";

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

// #89 / ADR-097 (the sanitize ): `:::table` cells that carry BLOCK content render through this
// SAME shared renderer, so its tag allowlist IS the cell sanitize boundary. The reviewer (comment 710)
// required the allowlist be pinned as an executable contract — a positive list AND a negative assert
// so an external-resource / executable tag can never slip in via a table cell and bypass the embed
// (#108) allowlist/sandbox/same-origin gates. This renderer is allowlist-BY-CONSTRUCTION (it only ever
// emits a fixed set of tags via html``/unsafeHtml; any raw HTML block, incl. HTMLBlock, degrades to
// escaped text), so these lock that guarantee for the cell-content path.
describe("renderMarkdownToHtml — #89/ADR-097 cell block-content sanitize allowlist", () => {
  // POSITIVE: the block/inline constructs a cell is allowed to contain all render as live, allowlisted tags.
  it("renders the allowlisted block + inline tags (lists, paragraphs, headings, quote, emphasis, code, safe link)", () => {
    const h = out("# H\n\npara\n\n> quote\n\n- a\n- b\n\n1. x\n\n**s** _e_ `c` [l](https://ok.example)");
    for (const tag of ["<h1>", "<p>", "<blockquote>", "<ul>", "<li>", "<ol>", "<strong>", "<em>", "<code>"]) {
      expect(h, `allowlisted ${tag} must render`).toContain(tag);
    }
    expect(h).toContain('<a href="https://ok.example" rel="noopener noreferrer nofollow">');
  });

  // NEGATIVE : NO external-resource / executable / form tag is ever emitted live — each degrades
  // to escaped text. A raw <iframe src> in a cell must NOT become a live frame (else it bypasses #108).
  const FORBIDDEN = ["iframe", "object", "embed", "script", "form", "input", "button", "style", "link", "base", "meta", "svg", "math", "template", "img"];
  for (const tag of FORBIDDEN) {
    it(`does NOT emit a live <${tag}> — raw HTML degrades to escaped text`, () => {
      const h = out(`before\n\n<${tag} src="https://evil.example" onerror="alert(1)">x</${tag}>\n\nafter`);
      expect(h, `<${tag}> must not appear as a live tag`).not.toMatch(new RegExp(`<${tag}[\\s>]`, "i"));
      expect(h).toContain(`&lt;${tag}`); // present only as inert escaped text
      expect(h).toContain("<p>before</p>");
      expect(h).toContain("<p>after</p>"); // surrounding content intact
    });
  }

  it("strips event-handler attributes and dangerous URL schemes (never live on* / javascript:/data:/vbscript:)", () => {
    const h = out('text <span onclick="alert(1)">y</span>\n\n[a](javascript:alert(1)) [b](data:text/html,x) [c](vbscript:x)');
    // on* only survives as escaped text (the raw span), never as a live attribute on an emitted tag.
    expect(h).not.toMatch(/<[a-z]+[^>]*\son(?:click|error|load|mouseover)=/i);
    expect(h).not.toContain('href="javascript:');
    expect(h).not.toContain('href="data:');
    expect(h).not.toContain('href="vbscript:');
  });

  it("an in-cell embed is a DIRECTIVE routed through the macro gate, not a raw iframe", () => {
    // With no registry, an unknown directive degrades to an escaped generic box — NEVER a live iframe.
    const h = out(":::embed-external\nhttps://evil.example\n:::");
    expect(h).not.toMatch(/<iframe[\s>]/i);
    // With a registry, dispatch hits the macro's htmlRender (its own gate) — proving the directive path,
    // not a raw-HTML passthrough, is what renders an embed in a cell.
    const gated: MacroHtmlRegistry = {
      fence: () => undefined,
      directive: (name) => (name === "embed-external" ? { exportFidelity: "degrade", htmlRender: (b) => html`<a class="wks-embed-degrade" href="${b.trim()}">${b.trim()}</a>` } : undefined),
    };
    const h2 = out(":::embed-external\nhttps://ok.example\n:::", gated);
    expect(h2).toContain('class="wks-embed-degrade"'); // went through the gate (degraded link), not a raw frame
    expect(h2).not.toMatch(/<iframe[\s>]/i);
  });
});

// #89 comment 782: the ACTUAL cell path is `tableHtmlRender` → blockCellSource (decode the wire-escaped
// inner back to Markdown source) → renderMarkdownToHtml. The reviewer's core threat is a raw <iframe> that
// survives that decode-then-reparse and goes live. These tests drive the END-TO-END cell path (not just
// renderMarkdownToHtml directly) and assert nothing dangerous becomes live — including the escaped-then-
// decoded round-trip that blockCellSource performs (a `&lt;iframe&gt;` in the wire → decoded to source →
// re-escaped by renderMarkdownToHtml's HTMLBlock default). cellTextToHtml (toHtml) entity-escapes cell
// source, so the wire inner of a block cell is ALWAYS entity-escaped — that is what these inputs mirror.
describe("tableHtmlRender — #89/ADR-097 block-cell path never goes live (comment 782)", () => {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const cell = (source: string) => tableHtmlRender(`<table><tbody><tr><td data-block="1">${esc(source)}</td></tr></tbody></table>`).value;

  it("renders allowlisted block content in a cell (a list becomes a real <ul><li>)", () => {
    const h = cell("- one\n- two");
    expect(h).toMatch(/<ul><li>(<p>)?one(<\/p>)?<\/li>\s*<li>(<p>)?two(<\/p>)?<\/li><\/ul>/);
  });

  const DANGEROUS = [
    '<iframe src="https://evil.example"></iframe>',
    '<script>alert(1)</script>',
    '<object data="x"></object>',
    '<embed src="x">',
    '<img src=x onerror="alert(1)">',
    '<svg onload="alert(1)"></svg>',
  ];
  for (const raw of DANGEROUS) {
    const kind = raw.match(/^<([a-z]+)/)![1];
    it(`a raw <${kind}> written into a block cell degrades to escaped text (no live element)`, () => {
      const h = cell(`before\n\n${raw}\n\nafter`);
      // the decode-then-reparse (blockCellSource → renderMarkdownToHtml HTMLBlock default) re-escapes it
      // the dangerous tag only ever appears inside an escaped `&lt;…&gt;` run, never as a live element (so
      // any on* handler it carries is inert text, not an attribute on a real node).
      expect(h).not.toMatch(new RegExp(`<${kind}[\\s>]`, "i")); // NOT a live tag
      expect(h).toContain(`&lt;${kind}`); // the tag survives ONLY as escaped text
      expect(h).toContain("<td data-block=\"1\">"); // the cell wrapper itself is intact
    });
  }

  it("a javascript: / data: URL in a block cell never becomes a live href", () => {
    const h = cell("[x](javascript:alert(1)) [y](data:text/html,x)");
    expect(h).not.toContain('href="javascript:');
    expect(h).not.toContain('href="data:');
  });

  it("a plain (non-block) cell passes through unchanged — no markdown reparse", () => {
    const plain = tableHtmlRender('<table><tbody><tr><td>a &amp; b</td></tr></tbody></table>').value;
    expect(plain).toContain("<td>a &amp; b</td>"); // untouched; only data-block cells are reparsed
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
// of truth in @wikistead/macro-render — the same code the editor uses), via builtinMacroRegistry.
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
  it(":::embed-page → a data-page placeholder (page ref escaped)", () => {
    expect(out(":::embed-page\npage-123\n:::", reg)).toContain('<div class="embed-page" data-page="page-123">');
  });
  it(":::embed-external → degrades to a link in exported HTML (no iframe; url escaped)", () => {
    const h = out(":::embed-external\nhttps://youtube.com/embed/x\n:::", reg);
    expect(h).toContain('<a class="embed-link" href="https://youtube.com/embed/x"');
    expect(h.toLowerCase()).not.toContain("<iframe"); // server export never emits an iframe
    expect(h).toContain('data-fidelity="degrade"'); // embed = degrade → badged
  });
  it(":::embed-external with a non-http(s) url renders inert text in a span, never a live link", () => {
    const h = out(":::embed-external\njavascript:alert(1)\n:::", reg);
    expect(h.toLowerCase()).not.toContain('href="javascript:'); // never a link carrying the scheme
    expect(h).toContain('<span class="embed-link">'); // rendered as inert text instead
  });
});

// #89 / ADR-097 anti-test ③④ (server): the :::table export renders a `data-block="1"` cell's Markdown
// through the shared sanitizer, so block content renders AND a raw <iframe>/<script> in a cell can't
// smuggle past the embed gates. Wire form is built via toHtml (the real serializer).
describe("tableHtmlRender — block-content cells (#89 / ADR-097)", () => {
  const block = (text: string): TCell => ({ text, header: false, colspan: 1, rowspan: 1, block: true });
  const plain = (text: string): TCell => ({ text, header: false, colspan: 1, rowspan: 1 });

  it("renders a block cell's Markdown list as real <ul>/<li> (not inline text)", () => {
    const h = tableHtmlRender(toHtml([[block("- one\n- two")]])).value;
    expect(h).toContain("<ul>");
    expect(h).toContain("one");
    expect(h).toContain("two");
    expect(h).toContain('data-block="1"'); // cell marker preserved in the export
  });

  it("a raw <iframe>/<script> inside a block cell is NOT live — the embed gate can't be bypassed", () => {
    const h = tableHtmlRender(toHtml([[block("- <iframe src=https://evil.example></iframe>\n- <script>alert(1)</script>")]])).value;
    expect(h).not.toMatch(/<iframe[\s>]/i); // no live frame
    expect(h).not.toMatch(/<script[\s>]/i); // no live script
    expect(h).toContain("&lt;iframe"); // degraded to escaped text
    expect(h).toContain("&lt;script");
  });

  it("a plain text cell passes through unchanged (no block rendering, no regression)", () => {
    const h = tableHtmlRender(toHtml([[plain("hello"), plain("a\nb")]])).value;
    expect(h).not.toContain("data-block");
    expect(h).toContain("hello");
    expect(h).toContain("a<br>b"); // plain multi-line stays <br>-joined inline text
  });
});
