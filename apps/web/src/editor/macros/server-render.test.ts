import { describe, it, expect } from "vitest";
import { renderMarkdownToHtml, html, builtinMacroRegistry, tableHtmlRender, type MacroHtmlRegistry } from "@wikistead/macro-render";

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

// #89 / ADR-097 (the sanitize "lifeline"): `:::table` cells that carry BLOCK content render through this
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

  // NEGATIVE (the lifeline): NO external-resource / executable / form tag is ever emitted live — each degrades
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

// #89 (rescoped, 2026-07-05): cells are inline text only. tableHtmlRender no longer reparses cell content
// (the block-content feature was removed) — it emits the table body verbatim; cell text is already entity-
// escaped by cellTextToHtml (toHtml), and the downstream #85 export sanitizer is the authoritative XSS
// boundary (covered end-to-end in the html-export integration tests). No markdown/macro dispatch per cell.
describe("tableHtmlRender — #89 (rescoped): cell body is emitted verbatim, no per-cell reparse", () => {
  it("passes the table body through unchanged (entity-escaped cell text stays escaped)", () => {
    const body = '<table><tbody><tr><td>a &amp; b</td><td>&lt;iframe&gt;</td></tr></tbody></table>';
    const out = tableHtmlRender(body).value;
    expect(out).toBe(body); // verbatim — no reparse, no macro dispatch; final sanitizer handles raw HTML
    expect(out).not.toMatch(/<iframe[\s>]/i); // cell text stays escaped (never a live tag here)
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

  // #85 (user ruling 2026-07-28): a degrade macro is rendered like any other — no wrapper, no badge, no
  // data-fidelity. The mark existed to be honest about a block that did not render properly, and it became
  // the reason such blocks were allowed to stay that way. Pinned as an absence so the wrapper cannot return
  // quietly; the macro's own output is still what lands.
  it("renders a DEGRADE directive macro plainly — no badge, no wrapper", () => {
    const h = out(":::simplified\nbody text\n:::", macros);
    expect(h).toContain('<div class="s">body text</div>');
    expect(h).not.toContain("wks-fidelity");
    expect(h).not.toContain("data-fidelity");
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

describe("renderMarkdownToHtml — GFM table (#174 point 4)", () => {
  it("renders a pipe table as a <table> (th header + td body)", () => {
    const h = out("| A | B |\n| - | - |\n| 1 | 2 |\n");
    expect(h).toContain("<table>");
    expect(h).toContain("<thead><tr><th>A</th><th>B</th></tr></thead>");
    expect(h).toContain("<td>1</td>");
    expect(h).toContain("<td>2</td>");
  });
  it("escapes cell content (XSS boundary holds — no raw HTML from a cell)", () => {
    const h = out('| h |\n| - |\n| <script>boom()</script> |\n');
    expect(h).not.toContain("<script>boom()</script>");
    expect(h).toContain("&lt;script&gt;");
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
  it("details → standard <details>, with the [label] as the <summary> (#337 point 3)", () => {
    const h = out(":::details[More info]\nhidden body\n:::", reg);
    expect(h).toContain("<summary>More info</summary>"); // the fence [label], not the hardcoded "Details"
    expect(h).toContain("hidden body");
  });
  it("details with no [label] falls back to <summary>Details</summary>", () => {
    expect(out(":::details\nbody\n:::", reg)).toContain("<summary>Details</summary>");
  });
  it("details [label] is XSS-inert (escaped in the summary)", () => {
    const h = out(":::details[<script>alert(1)</script>]\nbody\n:::", reg);
    expect(h).not.toContain("<script>alert(1)</script>");
    expect(h).toContain("&lt;script&gt;");
  });
  it("typed callouts → a per-type wrapper (note / warning), body escaped", () => {
    expect(out(":::note\nheads up\n:::", reg)).toContain('<div class="callout callout-note">');
    expect(out(":::warning\n<b>careful</b>\n:::", reg)).toContain('<div class="callout callout-warning">');
    expect(out(":::warning\n<b>careful</b>\n:::", reg)).not.toContain("<b>careful</b>"); // escaped
  });
  it("fence macros dispatch: mermaid/plantuml → <pre>, with no badge on either", () => {
    const m = out("```mermaid\ngraph TD; A-->B\n```", reg);
    expect(m).toContain('<pre class="mermaid">graph TD; A--&gt;B'); // body escaped inside pre
    // #85 (user ruling 2026-07-28): the badge is gone. Marking a block that did not render became a way
    // of not rendering it; the acceptance is that the export looks like the screen. Asserted as an
    // absence so the wrapper cannot come back unnoticed.
    expect(m).not.toContain("wks-fidelity");
    const p = out("```plantuml\n@startuml\n@enduml\n```", reg);
    expect(p).toContain('<pre class="plantuml">');
    expect(p).not.toContain("wks-fidelity"); // no badge on this one either
  });
  it(":::embed-page → a data-page placeholder (page ref escaped)", () => {
    expect(out(":::embed-page\npage-123\n:::", reg)).toContain('<div class="embed-page" data-page="page-123">');
  });
  it(":::embed-external → degrades to a link in exported HTML (no iframe; url escaped)", () => {
    const h = out(":::embed-external\nhttps://youtube.com/embed/x\n:::", reg);
    expect(h).toContain('<a class="embed-link" href="https://youtube.com/embed/x"');
    expect(h.toLowerCase()).not.toContain("<iframe"); // server export never emits an iframe
    expect(h).not.toContain("data-fidelity"); // #85 ruling: no badge, here or anywhere
  });
  it(":::embed-external with a non-http(s) url renders inert text in a span, never a live link", () => {
    const h = out(":::embed-external\njavascript:alert(1)\n:::", reg);
    expect(h.toLowerCase()).not.toContain('href="javascript:'); // never a link carrying the scheme
    expect(h).toContain('<span class="embed-link">'); // rendered as inert text instead
  });
});

// #296: nested directives (a :::tabs with 2 tabs) — lezer early-closes the parent at the first inner
// close, so the string renderer used to truncate the body (2nd tab dropped to a generic box) and leak the
// dangling ':::' as body text. render.ts now consumes resolveDirectiveRanges + skips the leaked siblings.
describe("renderMarkdownToHtml — #296 nested directive ranges", () => {
  const reg = builtinMacroRegistry();
  it("renders BOTH tabs of a nested :::tabs and leaks no literal ':::'", () => {
    const src = "::::tabs\n:::tab[One]\nAlpha content\n:::\n:::tab[Two]\nBravo content\n:::\n::::";
    const h = out(src, reg);
    expect(h).toContain("Alpha content"); // tab 1
    expect(h).toContain("Bravo content"); // tab 2 — not dropped by the early-close
    expect(h).not.toContain(":::"); // no dangling close marker leaked as body text
    expect(h).not.toContain("wks-directive"); // the 2nd tab did NOT fall to the generic fallback box
  });

  it("a non-nested directive is unchanged (no over-skip of following blocks)", () => {
    const h = out(":::columns\nc1\n:::\n\nAfter the block.", reg);
    expect(h).toContain("After the block."); // the sibling AFTER a simple directive still renders
  });
});

describe("renderMarkdownToHtml — #85 recursive nested-directive bodies", () => {
  const reg = builtinMacroRegistry();

  it("renders a nested pipe table inside a callout as a real <table>, not flattened raw text", () => {
    const h = out(":::note\n| A | B |\n| - | - |\n| x | y |\n:::\n", reg);
    expect(h).toContain("<table>");
    expect(h).toContain("<td>x</td>");
    expect(h).not.toContain("| A | B |"); // the #85 bug: the body must NOT stay flattened pipe text
  });

  it("recurses into a :::columns column body (a list becomes a real <ul>/<li>)", () => {
    const h = out("::::columns\n:::column\n- one\n- two\n:::\n:::column\ntext\n:::\n::::\n", reg);
    expect(h).toContain("<ul>");
    expect(h).toContain("<li>");
    expect(h).not.toContain("- one"); // not raw
  });

  it("recurses into tabs bodies (each tab's markdown renders)", () => {
    const h = out("::::tabs\n:::tab[One]\n**bold in a tab**\n:::\n:::tab[Two]\n| C | D |\n| - | - |\n| 1 | 2 |\n:::\n::::\n", reg);
    expect(h).toContain("<strong>bold in a tab</strong>");
    expect(h).toContain("<table>"); // the second tab's table renders at depth
  });

  it("stays XSS-safe recursively — a nested <script> in a callout body is escaped at depth", () => {
    const h = out(":::note\n<script>alert(1)</script>\n:::\n", reg);
    expect(h).not.toContain("<script>alert(1)</script>");
    expect(h).toContain("&lt;script&gt;"); // the allowlist boundary holds at every nesting depth
  });
});

describe("renderMarkdownToHtml — footnotes (#335 / ADR-130)", () => {
  it("renders a reference as a numbered superscript link and collects the definition into a section", () => {
    const h = out("Text with a note[^1].\n\n[^1]: the note body\n");
    expect(h).toContain('<sup class="cm-lp-footnote-ref" id="fnref-1"><a href="#fn-1">1</a></sup>');
    expect(h).toContain('<section class="cm-lp-footnotes" data-testid="footnotes">');
    expect(h).toContain('<li class="cm-lp-footnote-item" id="fn-1">');
    expect(h).toContain("the note body");
    expect(h).toContain('<a href="#fnref-1" class="cm-lp-footnote-back">↩</a>');
    expect(h).not.toContain("[^1]:"); // the def line is never emitted in the body flow
  });

  it("numbers by first-reference order and shares a number across repeated references", () => {
    const h = out("a[^b] then a[^a] then again[^b].\n\n[^a]: A\n[^b]: B\n");
    // [^b] is referenced first → number 1; [^a] second → number 2 (definition order is irrelevant).
    expect(h).toContain('id="fnref-1"><a href="#fn-1">1</a>');
    expect(h).toContain('id="fnref-2"><a href="#fn-2">2</a>');
    expect(h.indexOf("#fn-1")).toBeLessThan(h.indexOf("#fn-2"));
  });

  it("renders a reference with no definition as a muted ?, never a dangling link or raw [^x]", () => {
    const h = out("orphan[^missing] here\n");
    expect(h).toContain('<sup class="cm-lp-footnote-ref cm-lp-footnote-undef">?</sup>');
    expect(h).not.toContain("[^missing]");
    expect(h).not.toContain("#fn-"); // no target for an undefined reference
  });

  it("does NOT treat a real link or reference link as a footnote", () => {
    const h = out("[text](https://example.com) and [ref][id]\n\n[id]: https://x.example\n");
    expect(h).toContain('<a href="https://example.com" rel="noopener noreferrer nofollow">text</a>');
    expect(h).not.toContain("cm-lp-footnote-ref");
  });

  it("keeps a footnote body XSS-inert — a <script> in a definition is escaped", () => {
    const h = out("ref[^x]\n\n[^x]: <script>alert(1)</script>\n");
    expect(h).not.toContain("<script>alert(1)</script>");
    expect(h).toContain("&lt;script&gt;");
  });

  // #307 / ADR-127 §6: `:::backlinks` is a MEMBER-surface data macro; on the server export it is deliberately
  // NOT registered, so it takes the unregistered-directive fallback (empty <div>, fences + [label] stripped)
  // — the v1 "public/print/export emits nothing" mechanism. No raw ::: and no label may leak.
  it("emits nothing for :::backlinks on export (no raw :::, no label leak)", () => {
    const reg = builtinMacroRegistry();
    const h = out(":::backlinks[関連ページ]\n\n:::\n", reg);
    expect(h).not.toContain(":::"); // the fences are stripped by the fallback
    expect(h).not.toContain("関連ページ"); // the label is on the (dropped) open line — never leaked
    expect(h).not.toContain("cm-lp-backlinks"); // no list is rendered server-side (member surface only)
  });

  // §A scope (review): a footnote INSIDE a macro body is literal — never pulled into the document-end
  // section, never numbered against the top level, and it never starts its own nested section. DOM and server
  // must agree here (ADR-085); the DOM twin lives in md-render.test.ts.
  it("does NOT pull a footnote from inside a :::columns body into the document-end section", () => {
    const reg = builtinMacroRegistry();
    const h = out(
      "top[^1]\n\n::::columns\n:::column\ninside[^2] here\n\n[^2]: nested note\n:::\n:::column\ntext\n:::\n::::\n\n[^1]: top note\n",
      reg,
    );
    // the top-level footnote resolves and is collected exactly once
    expect(h).toContain('id="fnref-1"');
    expect(h).toContain("top note");
    expect((h.match(/class="cm-lp-footnotes"/g) ?? []).length).toBe(1); // one section, no nested duplicate
    // the nested [^2] is NOT numbered against the top level and has no dangling back-link target
    expect(h).not.toContain("#fn-2");
    expect(h).not.toContain('id="fn-2"');
    expect(h).not.toContain("#fnref-2");
    expect(h).toContain("cm-lp-footnote-undef"); // nested ref renders as a muted `?`
    // the nested definition is preserved literally in the body (not silently dropped), not in the section
    expect(h).toContain("nested note");
  });
});

// #422 / ADR-151 follow-up: align EXPORT PARITY. The server sink wraps `:::table{align=left|right}`
// (and an `align=` diagram fence) in the SAME fixed .cm-lp-align-* class the editor/read surfaces
// use. The attr value is an enum switch between fixed class literals — a crafted value must be a
// no-op (never interpolated into markup: the XSS boundary of ADR-151 §2).
describe("renderMarkdownToHtml — #422 align export parity", () => {
  it("wraps :::table{align=left|right|center} in the fixed align class", () => {
    const left = out(":::table{align=left}\n<table><tbody><tr><td>x</td></tr></tbody></table>\n:::", builtinMacroRegistry());
    expect(left).toContain('<div class="cm-lp-align-left">');
    expect(left).toContain("</div>");
    const right = out(":::table{align=right}\n<table><tbody><tr><td>x</td></tr></tbody></table>\n:::", builtinMacroRegistry());
    expect(right).toContain('<div class="cm-lp-align-right">');
    const center = out(":::table{align=center}\n<table><tbody><tr><td>x</td></tr></tbody></table>\n:::", builtinMacroRegistry());
    expect(center, "an explicit center must reach the read/export sink, not just the editor").toContain('<div class="cm-lp-align-center">');
  });

  //this used to assert that center emits NO wrapper, which was right while center was the
  // default — and became the thing keeping the fix out once #393 made LEFT the default. The absent
  // case is the one that carries "default parity" now.
  it("absent align emits NO wrapper (it IS the default); center emits its own", () => {
    const none = out(":::table\n<table></table>\n:::", builtinMacroRegistry());
    expect(none).not.toContain("cm-lp-align-");
  });

  it("a crafted align value never reaches the markup; a non-enum value is a NO-OP (XSS boundary)", () => {
    // The attr parser strips the quote-break attempt (yielding a clean enum value at most) and the
    // sink switches between FIXED class literals — the injected fragment must never surface.
    const crafted = out(':::table{align="left\u0022 onmouseover=\u0022evil()"}\n<table></table>\n:::', builtinMacroRegistry());
    expect(crafted).not.toContain("onmouseover");
    expect(crafted).not.toContain("evil");
    // A non-enum value applies nothing (no wrapper, no interpolation).
    const nonEnum = out(":::table{align=evil}\n<table></table>\n:::", builtinMacroRegistry());
    expect(nonEnum).not.toContain("cm-lp-align-");
    expect(nonEnum).not.toContain("evil\"");
  });

  it("wraps an align= diagram fence (mermaid) in the same fixed class", () => {
    const aligned = out("```mermaid align=left\nflowchart TD\n```", builtinMacroRegistry());
    expect(aligned).toContain('<div class="cm-lp-align-left">');
    expect(aligned).toContain('<pre class="mermaid">');
    const plain = out("```mermaid\nflowchart TD\n```", builtinMacroRegistry());
    expect(plain).not.toContain("cm-lp-align-");
  });
});
