// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from "vitest";
import { renderMarkdownToDom, renderCalloutPanel, appendMarkdownInto } from "./md-render";
import { renderMarkdownToHtml, builtinMacroRegistry } from "@wikistead/macro-render";
import { registerMacro } from "./registry";
import { tabsMacro } from "./layout-directives";
import { html, unsafeHtml } from "./safe-html";

function root(src: string): HTMLElement {
  const d = document.createElement("div");
  d.appendChild(renderMarkdownToDom(src));
  return d;
}

describe("renderMarkdownToDom — GFM table (#174 point 4)", () => {
  it("renders a pipe table as a real <table> (thead th + tbody td)", () => {
    const d = root("| A | B |\n| - | - |\n| 1 | 2 |\n");
    const table = d.querySelector("table");
    expect(table).not.toBeNull();
    expect(Array.from(d.querySelectorAll("thead th")).map((c) => c.textContent)).toEqual(["A", "B"]);
    expect(Array.from(d.querySelectorAll("tbody td")).map((c) => c.textContent)).toEqual(["1", "2"]);
  });
  it("keeps the XSS boundary: a cell's raw HTML is inert text, never an element", () => {
    const d = root('| h |\n| - |\n| <img src=x onerror="boom()"> |\n');
    expect(d.querySelector("img")).toBeNull(); // no live element from cell text
    expect(d.querySelector("td")?.textContent).toContain("<img");
  });
});

describe("renderMarkdownToDom — wks-attachment intercept (#273 / ADR-120 condition ①, client impl)", () => {
  it("a [name](wks-attachment:id) link renders as a non-anchor chip, never a raw custom-scheme <a>", () => {
    const d = root("see [report.pdf](wks-attachment:abc-123) here");
    const chip = d.querySelector('[data-testid="attachment-ref"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("report.pdf");
    expect(d.querySelector('a[href^="wks-attachment"]')).toBeNull(); // no raw custom-scheme anchor
  });
  it("a normal https link still renders as an anchor (the intercept is scheme-scoped)", () => {
    const d = root("[site](https://example.com)");
    const a = d.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com");
  });
});

// #334 / ADR-129: highlight (`==text==` → <mark>). Assert the BROWSER renderer (renderMarkdownToDom) and
// the DOM-free SERVER export renderer (renderMarkdownToHtml) both emit <mark> — the two of the three
// surfaces coverable without a browser (the CM6 editor decoration is the e2e's job). They must not drift.
describe("highlight #334 / ADR-129 — `==text==` → <mark>", () => {
  const serverHtml = (src: string) => renderMarkdownToHtml(src, builtinMacroRegistry()).value;

  it("browser renderer: `==foo==` becomes a <mark> holding just the text", () => {
    const d = root("mark ==foo== here\n");
    const m = d.querySelector("mark");
    expect(m?.textContent).toBe("foo");
    expect(d.querySelector("p")?.textContent).toBe("mark foo here"); // `==` delimiters hidden
  });

  it("server export renderer: `==foo==` becomes <mark>foo</mark> (parity with the browser)", () => {
    expect(serverHtml("mark ==foo== here")).toContain("<mark>foo</mark>");
  });

  it("XSS: highlighted raw HTML stays literal text, no element injection (both renderers)", () => {
    const d = root("==<img src=x onerror=alert(1)>==\n");
    expect(d.querySelector("mark")).not.toBeNull();
    expect(d.querySelector("img"), "no img element is injected").toBeNull();
    const srv = serverHtml("==<img src=x onerror=alert(1)>==");
    expect(srv).toContain("<mark>");
    expect(srv).not.toContain("<img"); // escaped inside the mark
  });

  it("no false positives: a lone `=`, spaced `= =`, and a `===` run are NOT highlights", () => {
    expect(root("a = b and x === y\n").querySelector("mark"), "= / === are not marks").toBeNull();
    expect(serverHtml("a = b and x === y")).not.toContain("<mark>");
  });

  it("does not collide with emphasis / strikethrough on the same line", () => {
    const d = root("*em* ~~s~~ ==h==\n");
    expect(d.querySelector("em")?.textContent).toBe("em");
    expect(d.querySelector("s")?.textContent).toBe("s");
    expect(d.querySelector("mark")?.textContent).toBe("h");
  });

  // #334 review (comment 1519): the delimiter is markdown-it-mark can-split-word, so it opens intraword
  // and right next to punctuation — `word==**bold**==word` highlights (the old GFM-strikethrough flanking left
  // the `==` literal). Both renderers, since the grammar is shared (ADR-085).
  it("highlights a run that STARTS with bold, intraword, no surrounding spaces (word==**bold**==word)", () => {
    const d = root("前後あり==**太字**==つづき\n");
    const mark = d.querySelector("mark");
    expect(mark, "the `==` opens even though `**` (punctuation) immediately follows").not.toBeNull();
    expect(mark?.querySelector("strong")?.textContent).toBe("太字"); // the bold nests inside the mark
    expect(d.querySelector("p")?.textContent).toBe("前後あり太字つづき"); // `==` delimiters hidden
    // server parity
    const srv = serverHtml("前後あり==**太字**==つづき");
    expect(srv).toContain("<mark>");
    expect(srv).toContain("<strong>太字</strong>");
    expect(srv).not.toContain("=="); // no literal delimiter leaked
  });

  it("highlights ascii intraword too (a==**b**==c) — not a CJK-only fix", () => {
    expect(root("a==**b**==c\n").querySelector("mark strong")?.textContent).toBe("b");
    expect(root("==**x**==\n").querySelector("mark strong")?.textContent).toBe("x"); // standalone
    expect(serverHtml("a==**b**==c")).toContain("<mark>");
  });

  it("still keeps space-flanked `==` literal after the relaxation (a == b)", () => {
    expect(root("a == b\n").querySelector("mark")).toBeNull();
    expect(serverHtml("a == b")).not.toContain("<mark>");
  });
});

// #335 / ADR-130: footnote (`[^1]` ref + `[^1]: body` def) → superscript number links + an end-of-document
// footnotes section with back-links. Numbering by first-reference order; document-scoped; XSS-inert.
describe("footnote #335 / ADR-130 — `[^1]` + `[^1]: body`", () => {
  it("renders a reference as a numbered superscript link + an end section with a back-link", () => {
    const d = root("see [^1] here\n\n[^1]: the note body\n");
    const ref = d.querySelector("sup.cm-lp-footnote-ref a") as HTMLAnchorElement;
    expect(ref?.textContent).toBe("1");
    expect(ref?.getAttribute("href")).toBe("#fn-1");
    expect((d.querySelector("sup.cm-lp-footnote-ref") as HTMLElement)?.id).toBe("fnref-1");
    const item = d.querySelector("section.cm-lp-footnotes li#fn-1");
    expect(item?.textContent).toContain("the note body");
    expect(item?.querySelector("a.cm-lp-footnote-back")?.getAttribute("href")).toBe("#fnref-1");
    // the def is NOT rendered in the body flow (only in the end section).
    expect(d.querySelectorAll("section.cm-lp-footnotes li").length).toBe(1);
  });

  it("numbers by FIRST-reference order; a repeated reference shares its number", () => {
    const d = root("[^b] then [^a] then [^b] again\n\n[^a]: A\n[^b]: B\n");
    const refs = Array.from(d.querySelectorAll("sup.cm-lp-footnote-ref a")).map((a) => a.textContent);
    expect(refs).toEqual(["1", "2", "1"]); // b=1 (first), a=2, b=1 again
    expect(d.querySelector("li#fn-1")?.textContent).toContain("B");
    expect(d.querySelector("li#fn-2")?.textContent).toContain("A");
  });

  it("an undefined reference is a muted '?' (no link); an unreferenced def is still shown", () => {
    const d = root("ref [^x] only\n\n[^y]: orphan note\n");
    const sup = d.querySelector("sup.cm-lp-footnote-ref");
    expect(sup?.classList.contains("cm-lp-footnote-undef")).toBe(true);
    expect(sup?.querySelector("a")).toBeNull(); // no target
    // the unreferenced def is still rendered (de-emphasised) — content never silently dropped.
    const unref = d.querySelector("li.cm-lp-footnote-unref");
    expect(unref?.textContent).toContain("orphan note");
  });

  it("does not collide with links: `[t](url)` / `[t][id]` still parse as links, `[^1]` is a footnote", () => {
    const d = root("a [link](https://x.example) and [^1] and [ref][id]\n\n[^1]: note\n");
    const link = Array.from(d.querySelectorAll("a")).find((a) => a.textContent === "link");
    expect(link, "the real link still parses as a link").toBeTruthy();
    expect(link!.getAttribute("href")).toContain("x.example");
    expect(d.querySelector("sup.cm-lp-footnote-ref a")?.textContent).toBe("1"); // `[^1]` is a footnote
  });

  it("XSS: a def body's raw HTML is inert text (no element injection)", () => {
    const d = root("x [^1]\n\n[^1]: <img src=x onerror=alert(1)> danger\n");
    expect(d.querySelector("section.cm-lp-footnotes img")).toBeNull();
    expect(d.querySelector("li#fn-1")?.textContent).toContain("danger");
  });

  // §A scope (review): a footnote INSIDE a macro body is literal — it is NOT pulled into the
  // document-end section, NOT numbered against the top level, and it never starts its own nested section.
  // This reader and the server export must agree (ADR-085); the server twin lives in server-render.test.ts.
  it("does NOT pull a footnote from inside a :::columns body into the document-end section", () => {
    const d = root("top[^1]\n\n::::columns\n:::column\ninside[^2] here\n\n[^2]: nested note\n:::\n:::column\ntext\n:::\n::::\n\n[^1]: top note\n");
    // the top-level footnote resolves and is collected exactly once
    expect((d.querySelector("sup#fnref-1 a"))?.getAttribute("href")).toBe("#fn-1");
    expect(d.querySelectorAll("section.cm-lp-footnotes").length).toBe(1); // one section, no nested duplicate
    const section = d.querySelector("section.cm-lp-footnotes")!;
    expect(section.textContent).toContain("top note");
    expect(section.textContent).not.toContain("nested note"); // nested def is NOT collected
    expect(section.querySelector("#fn-2")).toBeNull(); // no cross-boundary number
    // the nested ref is a muted `?` (no id, no target), and there is no fn-2/fnref-2 anywhere
    expect(d.querySelector("#fn-2")).toBeNull();
    expect(d.querySelector("#fnref-2")).toBeNull();
    // the nested definition is preserved literally somewhere in the body (not silently dropped)
    expect(d.textContent).toContain("nested note");
  });
});

describe("renderMarkdownToDom (#90 S0)", () => {
  it("renders common Markdown to elements", () => {
    const d = root("# Title\n\npara **bold** _i_ `c`\n\n- a\n- b\n");
    expect(d.querySelector("h1")?.textContent).toBe("Title");
    expect(d.querySelector("strong")?.textContent).toBe("bold");
    expect(d.querySelector("em")?.textContent).toBe("i");
    expect(d.querySelector("code")?.textContent).toBe("c");
    expect(d.querySelectorAll("ul li").length).toBe(2);
    expect(d.querySelector("p")?.textContent).toContain("para");
  });

  // #185: the nested renderer must COMPREHENSIVELY emit every block type (this is what runs inside a
  // column / tab / callout body). A missing type left a hole (the bounce: headings didn't appear).
  // Assert each block reaches the DOM (callout-icons.css then styles them like top-level, so a nested
  // heading reads as a heading, not body text).
  it("emits EVERY block type: h1-h6, blockquote, hr, ordered list, code (#185)", () => {
    const d = root("# a\n## b\n### c\n#### d\n##### e\n###### f\n\n> quote\n\n---\n\n1. one\n2. two\n\n```\ncode\n```\n");
    for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) expect(d.querySelector(tag), tag).not.toBeNull();
    expect(d.querySelector("blockquote")?.textContent).toContain("quote");
    expect(d.querySelector("hr")).not.toBeNull();
    expect(d.querySelectorAll("ol li").length).toBe(2);
    expect(d.querySelector("pre code")?.textContent).toContain("code");
  });

  it("renders a safe link and DROPS a javascript: href (no anchor, text kept)", () => {
    const ok = root("[x](https://e.com)");
    expect(ok.querySelector("a")?.getAttribute("href")).toBe("https://e.com");
    expect(ok.querySelector("a")?.textContent).toBe("x");

    const bad = root("[x](javascript:alert(1))");
    expect(bad.querySelector("a")).toBeNull(); // dangerous scheme → not an anchor
    expect(bad.textContent).toContain("x"); // text preserved
  });

  it("DROPS every dangerous href scheme (data/vbscript/file), keeping the text (XSS boundary)", () => {
    // safeHref blocks javascript|data|vbscript|file; the javascript: case is above. Pin the rest,
    // each with a distinct payload so a regression that drops only one scheme is caught.
    for (const [src, label] of [
      ["[d](data:text/html;base64,PHNjcmlwdD4=)", "data"],
      ["[v](vbscript:msgbox)", "vbscript"],
      ["[f](file:///etc/passwd)", "file"],
    ] as const) {
      const d = root(src);
      expect(d.querySelector("a"), `${label}: must not become an anchor`).toBeNull();
      expect(d.querySelector("span")?.textContent).toBe(label[0]); // link text preserved as a span
    }
  });

  it("blocks scheme-evasion by CASE (the regex is case-insensitive)", () => {
    const d = root("[x](JaVaScRiPt:alert)");
    expect(d.querySelector("a")).toBeNull(); // mixed-case javascript: still dropped
    expect(d.textContent).toContain("x");
  });

  it("ALLOWS safe schemes (mailto/relative) and sets rel on the anchor (allow-side + tabnabbing guard)", () => {
    const mail = root("[m](mailto:a@b.com)");
    expect(mail.querySelector("a")?.getAttribute("href")).toBe("mailto:a@b.com");

    const rel = root("[r](/page/123)");
    const a = rel.querySelector("a");
    expect(a?.getAttribute("href")).toBe("/page/123"); // relative URL is kept
    // every emitted anchor carries the tabnabbing/referrer guard
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  });

  it("unwraps an angle-bracket destination <…> to a real href (was a broken relative link)", () => {
    // CommonMark angle-bracket destinations arrive from the parser WITH the brackets; a legit
    // <https://e.com> must render as href=https://e.com, not the broken relative href "<https://e.com>".
    const d = root("[x](<https://e.com/a b>)"); // spaces are why one uses <…> in the first place
    expect(d.querySelector("a")?.getAttribute("href")).toBe("https://e.com/a b");
  });

  it("blocks a dangerous scheme wrapped in <…> (no longer relies on the accidental '<' neutering)", () => {
    const d = root("[x](<javascript:alert(1)>)");
    expect(d.querySelector("a")).toBeNull(); // brackets stripped → scheme check sees javascript: → dropped
    expect(d.textContent).toContain("x");
  });

  it("blocks scheme-evasion by CONTROL CHARS a browser strips (TAB/NUL/CR inside the scheme)", () => {
    // A browser removes TAB/LF/CR/NUL from a URL before evaluating the scheme, so `java<TAB>script:` runs.
    // safeHref must normalize the same way; each variant must be dropped (distinct payloads).
    for (const [label, src] of [
      ["tab", "[x](<java\u0009script:alert(1)>)"],
      ["nul", "[x](<java\u0000script:alert(1)>)"],
      ["cr", "[x](<java\u000Dscript:alert(1)>)"],
    ] as const) {
      const d = root(src);
      expect(d.querySelector("a"), `${label}: control-char evasion must be dropped`).toBeNull();
    }
  });

  it("renders raw HTML as LITERAL TEXT — no script/img element, no execution (XSS boundary)", () => {
    const d = root("<script>alert(1)</script>\n\nhi <img src=x onerror=alert(1)> there");
    expect(d.querySelector("script")).toBeNull();
    expect(d.querySelector("img")).toBeNull();
    expect(d.textContent).toContain("<script>"); // shown as literal text, not parsed as HTML
  });

  it("never uses innerHTML — angle brackets/ampersands in text are escaped entities", () => {
    const d = root("a < b & c > d");
    expect(d.innerHTML).toContain("&lt;");
    expect(d.innerHTML).toContain("&amp;");
    expect(d.querySelector("p")?.textContent).toBe("a < b & c > d"); // round-trips as text
  });

  it("a fenced code block renders as <pre><code> with its text verbatim (no highlight HTML)", () => {
    const d = root("```js\nconst x = 1 < 2;\n```\n");
    const code = d.querySelector("pre > code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain("const x = 1 < 2;");
    expect(code?.querySelector("*")).toBeNull(); // plain text, no nested HTML
  });
});

// ADR-085 shared macro renderer: renderMarkdownToDom dispatches a nested directive to its registered
// macro's liveRender (single source of truth), so macros render inside transclude / columns / tabs
// (#108, nested #90) — not a generic box. Unknown / throwing → the safe generic box.
describe("renderMarkdownToDom — nested macro dispatch (ADR-085 / #185)", () => {
  beforeAll(() => {
    document.documentElement.dataset.theme = "light"; // currentMacroTheme() → 'light' (no matchMedia)
    registerMacro({
      kind: "directive", name: "adr085test", exportFidelity: "degrade",
      htmlRender: (b) => html`<div class="x">${b}</div>`,
      liveRender: (body) => { const d = document.createElement("div"); d.className = "adr085-rendered"; d.textContent = body; return d; },
    });
    registerMacro({
      kind: "directive", name: "adr085throw", exportFidelity: "degrade",
      htmlRender: () => unsafeHtml(""), liveRender: () => { throw new Error("boom"); },
    });
  });

  it("#267: a nested :::tabs renders BOTH tabs — lezer early-closes the parent, the resolver corrects the range", () => {
    registerMacro(tabsMacro);
    // lezer's grammar early-closes `::::tabs` at the first `:::tab` close, so the OLD node.to sliced only
    // tab One and leaked tab Two (+ a bare `:::`) as siblings. The resolver-corrected range feeds the full
    // body to the tabs macro, so parseLayoutItems sees both tabs; renderBlocks skips the leaked siblings.
    const src = "::::tabs\n:::tab[One]\nAAA\n:::\n:::tab[Two]\nBBB\n:::\n::::";
    const r = root(src);
    const tabsEl = r.querySelector("[data-testid=macro-tabs]");
    expect(tabsEl, "the tabs widget rendered").toBeTruthy();
    expect(Array.from(tabsEl!.querySelectorAll(".cm-lp-tab")).map((b) => b.textContent)).toEqual(["One", "Two"]);
    // nothing leaked past the early-close: no bare `:::` paragraph as a sibling of the widget.
    expect(r.textContent).not.toContain(":::");
  });

  it("caps nested LIVE directive rendering depth (#90) — deeper directives degrade to plain content, not more widgets", () => {
    // A self-nesting macro (like columns/tabs, it re-renders its body via renderMarkdownToDom). Nest it
    // 3 levels (outer uses more colons than inner so the parser nests: 7 > 5 > 3). With the depth cap
    // (MAX_NESTED_DIRECTIVE_DEPTH = 2) only the first TWO levels become live widgets; the 3rd degrades to
    // a generic box — its CONTENT is still present (no information lost), only the live framing stops.
    registerMacro({
      kind: "directive", name: "nest90", exportFidelity: "degrade",
      htmlRender: (b) => html`<div>${b}</div>`,
      liveRender: (body) => { const d = document.createElement("div"); d.setAttribute("data-testid", "nest90-live"); d.appendChild(renderMarkdownToDom(body)); return d; },
    });
    const src = ":::::::nest90\n:::::nest90\n:::nest90\ndeep text\n:::\n:::::\n:::::::";
    const d = root(src);
    expect(d.querySelectorAll("[data-testid='nest90-live']").length).toBe(2); // capped at 2 live levels
    expect(d.textContent).toContain("deep text"); // deepest content still rendered (degraded, not dropped)
  });

  it("dispatches a known directive to its macro's liveRender (not a generic box)", () => {
    const d = root(":::adr085test\nhello body\n:::");
    const rendered = d.querySelector(".adr085-rendered");
    expect(rendered).not.toBeNull();
    expect(rendered?.textContent).toBe("hello body"); // the inner body (between the ::: markers)
    expect(d.querySelector(".cm-lp-md-directive")).toBeNull(); // NOT the generic fallback box
  });

  it("keeps paragraphs and a dispatched macro as SEPARATE, ORDERED blocks — not merged (#185)", () => {
    // The #185 bounce: nested content rendered every element but crammed macros and text together
    // (the paragraph/blank-line structure was lost visually). Assert the DOM structure is preserved
    // blank-line-separated text + a macro become distinct sibling blocks in source order (spacing is
    // then CSS — .cm-lp-*>*+* margin — but the structure must be right first).
    const d = root("before para\n\n:::adr085test\nmacro body\n:::\n\nafter para");
    const kids = Array.from(d.children);
    expect(kids.length).toBe(3); // three separate blocks, not one crammed lump
    expect(kids[0]!.tagName).toBe("P");
    expect(kids[0]!.textContent).toBe("before para");
    expect(kids[1]!.classList.contains("adr085-rendered")).toBe(true); // the macro, between the paragraphs
    expect(kids[2]!.tagName).toBe("P");
    expect(kids[2]!.textContent).toBe("after para");
  });

  it("falls back to the generic box for an UNKNOWN directive", () => {
    const d = root(":::totallyunknownxyz\nfoo\n:::");
    expect(d.querySelector(".cm-lp-md-directive")).not.toBeNull();
    expect(d.querySelector(".adr085-rendered")).toBeNull();
  });

  it("falls back to the generic box when the macro liveRender THROWS (never breaks the render)", () => {
    const d = root(":::adr085throw\nx\n:::");
    expect(d.querySelector(".cm-lp-md-directive")).not.toBeNull(); // degraded safely, no exception
  });

  // #598(review): the identity a surface is compared by has to name WHO DREW the element.
  // While it came from the source text, a registered macro that nothing renders on this surface came out
  // of the generic box wearing its own name, and the parity gate — whose whole job is to notice an element
  // that draws in the editor and not in the export — passed. Measured on a dummy macro and it was green.
  //
  // Both directions in one test on purpose: "the working macro is named" alone would still pass if
  // everything were named, which is the bug.
  it("#598: the name says who drew it — a macro that rendered is named, one that fell back is not", () => {
    registerMacro({
      kind: "directive", name: "wired598", exportFidelity: "degrade",
      htmlRender: (b) => html`<div>${b}</div>`,
      liveRender: () => { const d = document.createElement("div"); d.className = "wired598"; return d; },
    });
    registerMacro({
      kind: "directive", name: "unwired598", exportFidelity: "degrade",
      htmlRender: (b) => html`<div>${b}</div>`,
      // registered, and draws nothing here — the shape of a macro wired to the editing surface only
      liveRender: () => null as unknown as HTMLElement,
    });
    const d = root(":::wired598\nx\n:::\n\n:::unwired598\ny\n:::");
    expect(d.querySelector('[data-wks-el="wired598"]'), "the macro that rendered carries its name").not.toBeNull();
    expect(d.querySelector('[data-wks-el="unwired598"]'), "the macro that did NOT render must not claim the name").toBeNull();
    expect(d.querySelector('[data-wks-el-fallback="unwired598"]'), "…it is named as a fallback instead, so the gate can say which one").not.toBeNull();
  });

  // ADR-085 v1: the SAME dispatch for the FENCE macro shape (```lang), so a diagram fence nested in
  // transclude/columns renders as the real macro — not a raw <pre><code>. Completes client dispatch
  // for both macro shapes (directive above + fence here). Register a fence macro to exercise it.
  it("dispatches a known FENCE macro to its liveRender (not a raw <pre><code>)", () => {
    registerMacro({
      kind: "fence", lang: "adr085fence", exportFidelity: "degrade", summary: () => "fence",
      htmlRender: (b) => html`<div>${b}</div>`,
      liveRender: (body) => { const d = document.createElement("div"); d.className = "adr085-fence"; d.textContent = body; return d; },
    });
    const d = root("```adr085fence\ndiagram body\n```");
    const rendered = d.querySelector(".adr085-fence");
    expect(rendered).not.toBeNull();
    expect(rendered?.textContent).toBe("diagram body"); // the fence body (between the ``` markers)
    expect(d.querySelector("pre > code")).toBeNull(); // NOT the raw code fallback
  });

  it("falls back to <pre><code> for an UNKNOWN fence language (plain code block preserved)", () => {
    const d = root("```totallyunknownlang\nconst x = 1;\n```");
    const code = d.querySelector("pre > code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain("const x = 1;");
    expect(d.querySelector(".adr085-fence")).toBeNull();
  });

  it("falls back to <pre><code> when a fence macro liveRender THROWS (never breaks the render)", () => {
    registerMacro({
      kind: "fence", lang: "adr085fencethrow", exportFidelity: "degrade", summary: () => "",
      htmlRender: () => unsafeHtml(""), liveRender: () => { throw new Error("boom"); },
    });
    const d = root("```adr085fencethrow\nkaboom\n```");
    const code = d.querySelector("pre > code");
    expect(code).not.toBeNull(); // degraded safely to plain code, no exception thrown
    expect(code?.textContent).toContain("kaboom");
  });

  it("an INDENTED code block (no info string) never dispatches to a fence macro", () => {
    // Only a fenced ```lang block carries an info string; an indented CodeBlock must stay plain code
    // even if its first token happens to match a registered fence lang.
    const d = root("    adr085fence not a fence\n    still code\n");
    expect(d.querySelector(".adr085-fence")).toBeNull();
    expect(d.querySelector("pre > code")).not.toBeNull();
  });

  it("keeps the XSS boundary: raw HTML in a dispatched macro's body stays literal via the macro", () => {
    // The dispatched macro sets textContent(body); a <script> in the body is inert literal text.
    const d = root(":::adr085test\n<script>alert(1)</script>\n:::");
    expect(d.querySelector("script")).toBeNull();
    expect(d.querySelector(".adr085-rendered")?.textContent).toContain("<script>");
  });
});

// #170 / ADR-049 (option Y): a CONTAINER directive with an icon (a typed callout, no liveRender) renders
// as the shared callout PANEL — icon + variant title + nested Markdown body — both as the CM widget
// and via this nested dispatch (callouts inside transclude/columns). renderCalloutPanel is the single
// source of truth.
describe("callout panel (#170 案Y — containerClass dispatch + renderCalloutPanel)", () => {
  beforeAll(() => {
    registerMacro({
      kind: "directive", name: "adr049callout", exportFidelity: "preserve",
      containerClass: "cm-lp-callout cm-lp-callout-warning", icon: "triangle-alert",
      htmlRender: (b) => html`<div>${b}</div>`,
    });
  });

  it("dispatches a nested typed callout to the PANEL (icon + title + body), not a generic box", () => {
    const d = root(":::adr049callout[Heads up]\nbody **text**\n:::");
    const panel = d.querySelector<HTMLElement>(".cm-lp-callout-panel");
    expect(panel).not.toBeNull();
    expect(d.querySelector(".cm-lp-md-directive")).toBeNull(); // NOT the generic fallback box
    expect(panel!.querySelector(".cm-lp-callout-panel-icon")?.getAttribute("data-icon")).toBe("triangle-alert");
    expect(panel!.querySelector(".cm-lp-callout-panel-title")?.textContent).toBe("Heads up");
    // the body is rendered through renderMarkdownToDom → nested markdown is real (a <strong>, not raw **)
    expect(panel!.querySelector(".cm-lp-callout-panel-body strong")?.textContent).toBe("text");
  });

  it("renders no title element when there is no [label]", () => {
    const d = root(":::adr049callout\njust body\n:::");
    expect(d.querySelector(".cm-lp-callout-panel")).not.toBeNull();
    expect(d.querySelector(".cm-lp-callout-panel-title")).toBeNull(); // distinct from the labelled case
    expect(d.querySelector(".cm-lp-callout-panel-body")?.textContent).toContain("just body");
  });

  it("renderCalloutPanel keeps the XSS boundary: a label + body script stay inert", () => {
    const el = renderCalloutPanel("cm-lp-callout cm-lp-callout-note", "pencil", "<img src=x onerror=1>", "<script>alert(1)</script>");
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("img")).toBeNull();
    // the label is set via textContent → the raw markup is literal text, never parsed
    expect(el.querySelector(".cm-lp-callout-panel-title")?.textContent).toBe("<img src=x onerror=1>");
  });

  // #170 XSS via the DISPATCH path (not just renderCalloutPanel directly): a callout reached through
  // renderMarkdownToDom must sanitize its body — a javascript: link in the body renders NO anchor with
  // that href (the shared renderer's scheme allowlist applies inside the panel body too).
  it("the dispatch path sanitizes a dangerous href in the callout body (no javascript: anchor)", () => {
    const d = root(":::adr049callout\n[click](javascript:alert(1))\n:::");
    const panel = d.querySelector<HTMLElement>(".cm-lp-callout-panel");
    expect(panel).not.toBeNull();
    const bad = Array.from(panel!.querySelectorAll("a")).find((a) => (a.getAttribute("href") ?? "").toLowerCase().includes("javascript"));
    expect(bad).toBeUndefined(); // the javascript: scheme is dropped; text may remain, the href does not
    expect(panel!.querySelector(".cm-lp-callout-panel-body")?.textContent).toContain("click"); // text kept
  });
});

describe("renderMarkdownToDom — staticMacros mode (#351the hover card stays light)", () => {
  beforeAll(() => {
    document.documentElement.dataset.theme = "light";
    // register a fence + a directive macro whose liveRender would be a "heavy widget / fetch" stand-in
    // static mode must never call them (the assertion: the marker class never appears, the chip does).
    registerMacro({
      kind: "fence", lang: "staticfence", exportFidelity: "degrade", summary: () => "staticfence",
      htmlRender: () => unsafeHtml(""),
      liveRender: () => { const d = document.createElement("div"); d.className = "static-heavy-widget"; return d; },
    });
    registerMacro({
      kind: "directive", name: "staticdir", exportFidelity: "degrade",
      htmlRender: () => unsafeHtml(""),
      liveRender: () => { const d = document.createElement("div"); d.className = "static-heavy-widget"; return d; },
    });
  });
  const stat = (src: string) => {
    const d = document.createElement("div");
    d.appendChild(renderMarkdownToDom(src, undefined, { staticMacros: true }));
    return d;
  };

  it("a fence macro renders as a compact chip — liveRender is NEVER called", () => {
    const d = stat("intro\n\n```staticfence\ngraph TD\n```\n");
    expect(d.querySelector(".static-heavy-widget"), "no widget mounted").toBeNull();
    const chip = d.querySelector("[data-testid=static-macro-chip]");
    expect(chip?.textContent).toContain("staticfence");
    expect(d.textContent).not.toContain("graph TD"); // the label only, never the (long) source
  });

  it("a directive macro renders as a chip — liveRender is NEVER called", () => {
    const d = stat(":::staticdir\npayload\n:::\n");
    expect(d.querySelector(".static-heavy-widget")).toBeNull();
    expect(d.querySelector("[data-testid=static-macro-chip]")?.textContent).toContain("staticdir");
  });

  it("markdown-content containers (tabs) show their PLAIN body — no live widget, content kept", () => {
    // tabsMacro is already registered by the ADR-085 dispatch suite above (same file, sequential).
    const d = stat("::::tabs\n:::tab[One]\nAAA body\n:::\n::::");
    expect(d.querySelector("[data-testid=macro-tabs]"), "no tabs widget in static mode").toBeNull();
    expect(d.textContent).toContain("AAA body"); // content preserved via the plain fallback
  });

  it("a macro NESTED in a container body inherits static mode (no escape one level deeper)", () => {
    const d = stat("::::tabs\n:::tab[One]\n:::staticdir\ndeep\n:::\n:::\n::::");
    expect(d.querySelector(".static-heavy-widget")).toBeNull();
    expect(d.querySelector("[data-testid=static-macro-chip]")?.textContent).toContain("staticdir");
  });

  it("plain markdown still renders richly, and the DEFAULT mode is untouched (widgets dispatch)", () => {
    const d = stat("# Head\n\n**bold** and `code`\n");
    expect(d.querySelector("h1")?.textContent).toBe("Head");
    expect(d.querySelector("strong")?.textContent).toBe("bold");
    expect(d.querySelector("code")?.textContent).toBe("code");
    // default (non-static) render of the same fence macro still dispatches liveRender
    const dflt = document.createElement("div");
    dflt.appendChild(renderMarkdownToDom("```staticfence\nx\n```\n"));
    expect(dflt.querySelector(".static-heavy-widget"), "default mode unchanged").not.toBeNull();
    expect(dflt.querySelector("[data-testid=static-macro-chip]")).toBeNull();
  });
});

// #381 / ADR-163: appendMarkdownInto = renderMarkdownToDom + the `.wks-prose` container class (the ONE
// raw-tag prose sheet). Every emission point goes through it, so the class can't be forgotten again.
describe("appendMarkdownInto (#381)", () => {
  it("adds .wks-prose to the container and appends the rendered fragment", () => {
    const el = document.createElement("div");
    appendMarkdownInto(el, "# Hi\n\n`code`\n");
    expect(el.classList.contains("wks-prose")).toBe(true);
    expect(el.querySelector("h1")?.textContent).toBe("Hi");
    expect(el.querySelector("code")?.textContent).toBe("code");
  });

  it("a nested directive body gets .wks-prose via its emission point too", () => {
    const el = document.createElement("div");
    appendMarkdownInto(el, ":::unknowndir\n## Inside\n:::\n");
    const body = el.querySelector(".cm-lp-md-directive");
    expect(body).not.toBeNull();
    expect(body!.classList.contains("wks-prose")).toBe(true);
    expect(body!.querySelector("h2")?.textContent).toBe("Inside");
  });
});
