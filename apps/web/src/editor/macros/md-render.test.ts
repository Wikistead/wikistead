// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from "vitest";
import { renderMarkdownToDom, renderCalloutPanel } from "./md-render";
import { registerMacro } from "./registry";

function root(src: string): HTMLElement {
  const d = document.createElement("div");
  d.appendChild(renderMarkdownToDom(src));
  return d;
}

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
      htmlRender: (b) => `<div class="x">${b}</div>`,
      liveRender: (body) => { const d = document.createElement("div"); d.className = "adr085-rendered"; d.textContent = body; return d; },
    });
    registerMacro({
      kind: "directive", name: "adr085throw", exportFidelity: "degrade",
      htmlRender: () => "", liveRender: () => { throw new Error("boom"); },
    });
  });

  it("dispatches a known directive to its macro's liveRender (not a generic box)", () => {
    const d = root(":::adr085test\nhello body\n:::");
    const rendered = d.querySelector(".adr085-rendered");
    expect(rendered).not.toBeNull();
    expect(rendered?.textContent).toBe("hello body"); // the inner body (between the ::: markers)
    expect(d.querySelector(".cm-lp-md-directive")).toBeNull(); // NOT the generic fallback box
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

  // ADR-085 v1: the SAME dispatch for the FENCE macro shape (```lang), so a diagram fence nested in
  // transclude/columns renders as the real macro — not a raw <pre><code>. Completes client dispatch
  // for both macro shapes (directive above + fence here). Register a fence macro to exercise it.
  it("dispatches a known FENCE macro to its liveRender (not a raw <pre><code>)", () => {
    registerMacro({
      kind: "fence", lang: "adr085fence", exportFidelity: "degrade", summary: () => "fence",
      htmlRender: (b) => `<div>${b}</div>`,
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
      htmlRender: () => "", liveRender: () => { throw new Error("boom"); },
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

// #170 / ADR-049 (Y): a CONTAINER directive with an icon (a typed callout, no liveRender) renders
// as the shared callout PANEL — icon + variant title + nested Markdown body — both as the CM widget
// and via this nested dispatch (callouts inside transclude/columns). renderCalloutPanel is the single
// source of truth.
describe("callout panel (#170 案Y — containerClass dispatch + renderCalloutPanel)", () => {
  beforeAll(() => {
    registerMacro({
      kind: "directive", name: "adr049callout", exportFidelity: "preserve",
      containerClass: "cm-lp-callout cm-lp-callout-warning", icon: "triangle-alert",
      htmlRender: (b) => `<div>${b}</div>`,
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
