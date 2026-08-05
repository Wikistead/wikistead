// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { buildExportDocument, inlineTransientImages, inlineCodeFontFaces } from "./exportDocument";

// #85 / ADR-194 (Option B) acceptance 5: the exported file is INERT, and it carries the document rather
// than the app. These are the properties that make it safe to write to disk and open later — often by
// someone who is not the author — so they are pinned as properties, not as a snapshot of one page.

const surface = (html: string): HTMLElement => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
};

describe("#85: the browser-built export document", () => {
  it("keeps the content and the classes the app styles it with", () => {
    const out = buildExportDocument({
      title: "My page",
      body: surface('<div class="cm-lp-callout cm-lp-callout-note"><p>body text</p></div>'),
      css: ".cm-lp-callout{border-left:3px solid red}",
    });
    expect(out).toContain("body text");
    expect(out, "the app's own class survives — it is what the app's CSS targets").toContain("cm-lp-callout-note");
    expect(out, "and the app's stylesheet travels with it").toContain(".cm-lp-callout{border-left:3px solid red}");
    expect(out).toContain("<title>My page</title>");
  });

  it("drops the app's controls — a printed page has no Copy button", () => {
    const out = buildExportDocument({
      title: "t",
      body: surface('<div class="cm-lp-fence-card"><button class="cm-lp-code-copy">Copy</button><pre>x</pre></div>'),
      css: "",
    });
    expect(out).not.toContain("<button");
    expect(out).not.toContain("Copy");
    expect(out, "the content it decorated stays").toContain("<pre>x</pre>");
  });

  it("is inert: no script, no handler attribute, no javascript: URL", () => {
    const out = buildExportDocument({
      title: "t",
      body: surface('<p onclick="steal()">hi</p><script>steal()</script><a href="javascript:steal()">l</a><img src="x" onerror="steal()">'),
      css: "",
    });
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onerror");
    expect(out.toLowerCase()).not.toContain("javascript:");
    expect(out, "the text itself is still there").toContain("hi");
  });

  it("keeps a rendered diagram — the whole point of building it in the browser", () => {
    const out = buildExportDocument({
      title: "t",
      body: surface('<div class="cm-lp-macro"><svg viewBox="0 0 10 10"><rect width="10" height="10"></rect></svg></div>'),
      css: "",
    });
    expect(out, "the figure travels as a figure, not as its source").toContain("<svg");
    expect(out).toContain("<rect");
  });

  it("keeps raster data URLs, drops every other data: scheme", () => {
    const out = buildExportDocument({
      title: "t",
      body: surface('<img src="data:image/png;base64,AAA"><a href="data:text/html,<b>x</b>">l</a><img src="data:image/svg+xml,<svg onload=steal()></svg>">'),
      css: "",
    });
    expect(out).toContain("data:image/png;base64,AAA");
    expect(out).not.toContain("data:text/html");
    // ADR-194 anti-test: no non-raster data: URL. A drawn SVG travels as an inline element, never as a
    // data: URL, so nothing legitimate is lost by refusing the scheme.
    expect(out).not.toContain("data:image/svg");
  });

  // #85 / ADR-194 addendum A (ruling A2, 2026-08-05): the rule is not "no data: URLs" — it never was, and
  // saying so in the test would have made the ruling unimplementable. It is "no data: URL that can ACT".
  //
  // This is a rewrite, not a deletion, and it is aimed at what the old assertion could not see: it read the
  // URL ATTRIBUTES of elements, so a `data:image/svg+xml` hidden inside a <style> block passed it. The
  // document is checked as TEXT here, which is how it will be read by whatever opens it.
  it("a font may travel as a data: URL; an svg still may not, wherever it hides", () => {
    const withFont = buildExportDocument({
      title: "t",
      body: surface("<p>x</p>"),
      css: '@font-face{font-family:"Wikistead Mono";src:url(data:font/woff2;base64,AAAA) format("woff2")}',
    });
    expect(withFont, "the embedded code face is the point of A2").toContain("data:font/woff2;base64,AAAA");

    // …and the refusal the old pin claimed but did not measure: inside a stylesheet, where an <img src>
    // check never looks. A data: SVG is a document with a script surface; a woff2 is not.
    const withSvgInCss = buildExportDocument({
      title: "t",
      body: surface("<p>x</p>"),
      css: '.x{background:url("data:image/svg+xml,<svg onload=steal()></svg>")}',
    });
    expect(withSvgInCss, "an svg data: URL smuggled through CSS").not.toContain("data:image/svg");
  });

  // #85 review reject: a blob: URL is a handle into the session that built the file, dead as
  // soon as the file stands alone — the print frame resolved it, the saved document could not. Whatever was
  // not baked into a data: URL first must not travel as a reference that is known to be broken.
  it("drops a blob: URL — it cannot resolve outside the session that minted it", () => {
    const out = buildExportDocument({
      title: "t",
      body: surface('<img src="blob:http://localhost/abc" alt="diagram"><p>doc</p>'),
      css: "",
    });
    expect(out).not.toContain("blob:");
    expect(out, "the element stays; only the dead reference goes").toContain("<img");
    expect(out).toContain("doc");
  });

  // #85 (user ruling): the tab strip hides every panel but one, so the exported file was missing the other
  // tabs' TEXT — a document losing content, not a document losing interactivity. Every panel survives, each
  // under its own tab's label, and the strip of buttons does not travel.
  it("keeps every tab's content, each under its label", () => {
    const out = buildExportDocument({
      title: "t",
      body: surface(`<div class="cm-lp-tabs">
        <div class="cm-lp-tabbar"><button class="cm-lp-tab cm-lp-tab-active">One</button><button class="cm-lp-tab">Two</button></div>
        <div class="cm-lp-tabpanels">
          <div class="cm-lp-tabpanel cm-lp-tabpanel-active"><p>first pane</p></div>
          <div class="cm-lp-tabpanel"><p>second pane</p></div>
        </div>
      </div>`),
      css: "",
    });
    expect(out, "the visible tab's content is there").toContain("first pane");
    expect(out, "…and so is the one the reader never clicked").toContain("second pane");
    expect(out, "each pane keeps its label").toContain("One");
    expect(out).toContain("Two");
    expect(out, "the buttons themselves do not travel").not.toContain("<button");
    expect(out, "nor does the strip").not.toContain("cm-lp-tabbar");
  });

  // #207 (review rejection ①: "the tabs have no frame or separation on paper"). `expandTabs` invents
  // `.cm-lp-tab-label`, and the app stylesheet that travels with the file has no rule for a class the app
  // never emits — so the titles printed as bare body text. Measured in the real print document: the strip is
  // gone by design (the #85 ruling), the label was simply unstyled. The document must therefore CARRY the
  // rule, not merely the class. `css: ""` here stands in for the app sheet, so anything this asserts can only
  // come from the export's own <style>.
  it("styles the tab labels it invents, so the panes are told apart on paper", () => {
    const out = buildExportDocument({
      title: "t",
      body: surface(`<div class="cm-lp-tabs">
        <div class="cm-lp-tabbar"><button class="cm-lp-tab cm-lp-tab-active">One</button><button class="cm-lp-tab">Two</button></div>
        <div class="cm-lp-tabpanels">
          <div class="cm-lp-tabpanel cm-lp-tabpanel-active"><p>first pane</p></div>
          <div class="cm-lp-tabpanel"><p>second pane</p></div>
        </div>
      </div>`),
      css: "",
    });
    const style = out.slice(out.indexOf("<style>", out.indexOf("</style>")));
    expect(style, "the invented label class is styled by the file itself").toContain(".cm-lp-tab-label{");
    expect(style, "…and it wears the accent underline the on-screen active tab wears").toMatch(
      /\.cm-lp-tab-label\{[^}]*border-bottom:2px solid var\(--accent\)/,
    );
    expect(style, "…and consecutive panes are separated").toMatch(/\.wks-export-tabs>\.cm-lp-tabpanel\+\.cm-lp-tabpanel\{[^}]*margin-top/);
  });

  it("keeps the disclosure look but travels open", () => {
    const out = buildExportDocument({
      title: "t",
      body: surface("<details><summary>More</summary><div><p>hidden body</p></div></details>"),
      css: "",
    });
    expect(out, "still a disclosure — the look the ruling asked for").toContain("<details");
    expect(out).toContain("<summary>More</summary>");
    expect(out, "…but open, so the body is readable on paper").toMatch(/<details[^>]*\sopen/);
    expect(out).toContain("hidden body");
  });

  // #85 (supersedes the #505 pin that stood here): `data-print-root` is the app PRINT PORTAL's
  // attribute, and the app stylesheet — which travels with the file — hides it ON SCREEN. Wearing it made
  // the saved file print correctly and OPEN to a blank page (measured: root 0×0, display none). The root
  // is identified by its own `.wks-export-doc` marker instead; print.css names that class beside the
  // portal attribute in its print rules, so print survives without borrowing the portal's semantics. The
  // "opened file is visible in both media" behaviour is pinned where it can be seen — the file:// e2e
  // (export-user-path-85.spec.ts); this guards the marker choice lexically.
  it("does not wear the print portal's marker — its own class identifies the root", () => {
    const out = buildExportDocument({ title: "t", body: surface("<p>content</p>"), css: "[data-print-root]{display:none}" });
    expect(out, "the portal attribute would hide the opened file").not.toMatch(/<main[^>]*data-print-root/);
    expect(out, "the export marker is the root's identity").toMatch(/<main class="wks-export-doc wks-prose"/);
    expect(out).toContain("content");
  });

  // #85: the fence header is marked contenteditable="false" so CodeMirror leaves it alone, and stripping
  // every `[contenteditable]` took the whole header — file-name tab and all — out of the export. Only a
  // genuinely editable surface is chrome; the attribute is dropped from what stays.
  it("keeps a non-editable decoration, dropping only the attribute", () => {
    const out = buildExportDocument({
      title: "t",
      body: surface('<div class="cm-lp-fence-card"><div class="cm-lp-code-header" contenteditable="false"><span class="cm-lp-code-title">app.js</span></div><pre>x</pre></div>'),
      css: "",
    });
    expect(out, "the file name survives").toContain("app.js");
    expect(out, "…and its header element with it").toContain("cm-lp-code-header");
    expect(out, "the attribute does not travel").not.toContain("contenteditable");
  });

  it("drops a genuinely editable surface", () => {
    const out = buildExportDocument({ title: "t", body: surface('<div contenteditable="true">live editor</div><p>doc</p>'), css: "" });
    expect(out).not.toContain("live editor");
    expect(out).toContain("doc");
  });

  // The pair that makes a host-rendered diagram (plantuml) durable: the staging pass bakes each blob image
  // into a raster data: URL, and what it could not bake is dropped above rather than shipped dead.
  it("bakes a blob image into a data: URL before the document is built", async () => {
    const host = surface('<img src="blob:http://localhost/diagram"><img src="/api/att/1">');
    await inlineTransientImages(host, async () => "data:image/png;base64,BBB");
    const out = buildExportDocument({ title: "t", body: host, css: "" });
    expect(out, "the diagram travels as bytes, not as a session handle").toContain("data:image/png;base64,BBB");
    expect(out).not.toContain("blob:");
    expect(out, "a non-blob src is not touched").toContain("/api/att/1");
  });

  it("leaves a blob image it cannot read for the inert pass to drop", async () => {
    const host = surface('<img src="blob:http://localhost/gone">');
    await inlineTransientImages(host, async () => null);
    const out = buildExportDocument({ title: "t", body: host, css: "" });
    expect(out).not.toContain("blob:");
  });

  it("refuses a loader result that is not a raster data: URL", async () => {
    const host = surface('<img src="blob:http://localhost/svg">');
    await inlineTransientImages(host, async () => "data:image/svg+xml,<svg onload=steal()></svg>");
    const out = buildExportDocument({ title: "t", body: host, css: "" });
    expect(out).not.toContain("data:image/svg");
    expect(out).not.toContain("blob:");
  });

  it("does not mutate the surface it was given", () => {
    const live = surface('<div><button class="cm-lp-code-copy">Copy</button><p onclick="x()">p</p></div>');
    buildExportDocument({ title: "t", body: live, css: "" });
    expect(live.querySelector("button"), "the live page still has its controls").not.toBeNull();
    expect(live.querySelector("p")?.getAttribute("onclick")).toBe("x()");
  });
});

// #85 / ADR-194 addendum A — ruling A2 (2026-08-05): the CODE face travels inside the file, and every other
// @font-face goes with its unresolvable url(). The set is DERIVED from what --font-code resolves to, because
// the body face is a user choice (ADR-090) and a hard-coded family embeds the wrong file for anyone who
// changed their setting. That derivation is what these measure — a test that named the family would pass
// against exactly the implementation the ruling refused.
describe("#85 A2: which faces travel with the file", () => {
  const CSS = [
    '@font-face{font-family:"Wikistead Mono";font-weight:400;src:url(/assets/wikistead-mono.woff2) format("woff2")}',
    '@font-face{font-family:"UDEV Gothic";src:url(/assets/udevgothic.woff2) format("woff2")}',
    '@font-face{font-family:"Inter";src:url(/assets/inter.woff2) format("woff2")}',
    ".x{color:red}",
  ].join("\n");
  const fetchFont = async (url: string) => `data:font/woff2;base64,${url.includes("mono") ? "MONO" : "OTHER"}`;

  it("embeds the face the document actually resolves for code, and drops the rest", async () => {
    const out = await inlineCodeFontFaces(CSS, {
      codeStack: '"Wikistead Mono", ui-monospace, monospace',
      fetchFont,
    });
    expect(out, "the code face is inside the file").toContain("data:font/woff2;base64,MONO");
    expect(out, "no rule is left pointing at a path that will 404 from disk").not.toContain(".woff2)");
    expect(out, "the faces this file does not use are gone, not merely unfetched").not.toContain("UDEV Gothic");
    expect(out, "and the ordinary rules are untouched").toContain(".x{color:red}");
  });

  it("follows the SETTING: a different resolved stack embeds a different file", async () => {
    // the same document, a user whose code face resolves to UDEV Gothic — a listed-family implementation
    // would still embed Wikistead Mono here, which is the failure the ruling names
    const out = await inlineCodeFontFaces(CSS, { codeStack: '"UDEV Gothic", monospace', fetchFont });
    expect(out).toContain("UDEV Gothic");
    expect(out).toContain("data:font/woff2;base64,OTHER");
    expect(out, "the face that is no longer resolved does not travel").not.toContain("Wikistead Mono");
  });

  it("a face it cannot fetch is dropped, never left as a dead reference", async () => {
    const out = await inlineCodeFontFaces(CSS, {
      codeStack: '"Wikistead Mono", monospace',
      fetchFont: async () => null,
    });
    expect(out).not.toContain("Wikistead Mono");
    expect(out).not.toContain(".woff2");
    expect(out, "and the document keeps its other CSS").toContain(".x{color:red}");
  });
});

// #85 / ADR-194 addendum A (ruling, 2026-08-05): "the file is inert" is a claim about the BYTES that reach
// the disk, and every assertion above reads the string this module returns — which is the same thing, but
// only because nothing re-parses it. The document is built by hand (`makeInert` + `innerHTML` serialisation)
// and it deliberately carries `<svg>` and `<style>`, the two places where a parser's second look differs
// from its first (mXSS). So this parses the OUTPUT and asks the resulting DOM, which is what a browser
// opening the file will actually see.
describe("#85: inert measured on the parsed output, not on the DOM that produced it", () => {
  const parse = (html: string): Document => new DOMParser().parseFromString(html, "text/html");

  it("no script, no handler attribute, no javascript: URL survives a re-parse", () => {
    const out = buildExportDocument({
      title: "t",
      body: surface(
        '<p onclick="steal()">hi</p>' +
        '<svg><style>@import url(evil.css)</style><a xlink:href="javascript:steal()">x</a></svg>' +
        '<div><!--<img src=x onerror=steal()>--></div>',
      ),
      css: "",
    });
    const doc = parse(out);
    expect(doc.querySelectorAll("script"), "a script element after the parse").toHaveLength(0);
    const acting = Array.from(doc.querySelectorAll("*")).flatMap((el) =>
      Array.from(el.attributes).filter((a) => a.name.toLowerCase().startsWith("on")).map((a) => `${el.tagName}@${a.name}`));
    expect(acting, "an event-handler attribute after the parse").toEqual([]);
    const urls = Array.from(doc.querySelectorAll("*")).flatMap((el) =>
      ["href", "src", "xlink:href", "action"].map((n) => el.getAttribute(n) ?? "").filter(Boolean));
    expect(urls.filter((u) => /^\s*(javascript|vbscript):/i.test(u)), "an executable URL after the parse").toEqual([]);
    expect(doc.body.textContent, "and the document's own text is still there").toContain("hi");
  });

  it("the stylesheet cannot end its own block and become markup", () => {
    // `${css}` is interpolated into <style> unescaped. A sheet containing `</style><img onerror=…>` would
    // close the block early and hand the rest to the HTML parser — invisible to any assertion that reads
    // the pre-serialisation DOM, because at that point it is still just a string.
    const out = buildExportDocument({
      title: "t",
      body: surface("<p>doc</p>"),
      css: '.a{color:red}</style><img src=x onerror="steal()"><style>.b{color:blue}',
    });
    const doc = parse(out);
    expect(doc.querySelectorAll("img"), "the sheet broke out of its block").toHaveLength(0);
    const acting = Array.from(doc.querySelectorAll("*")).flatMap((el) =>
      Array.from(el.attributes).filter((a) => a.name.toLowerCase().startsWith("on")));
    expect(acting, "…and brought a handler with it").toEqual([]);
    expect(doc.body.textContent).toContain("doc");
  });
});
