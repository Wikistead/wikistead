// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { buildExportDocument } from "./exportDocument";

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

  it("keeps raster and inline-image data URLs, drops other data: schemes", () => {
    const out = buildExportDocument({
      title: "t",
      body: surface('<img src="data:image/png;base64,AAA"><a href="data:text/html,<b>x</b>">l</a>'),
      css: "",
    });
    expect(out).toContain("data:image/png;base64,AAA");
    expect(out).not.toContain("data:text/html");
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

  // #505 review rejection: the app's stylesheet travels with the file, and its print rule hides everything
  // that is not the print root — which, inside the exported document, was the document itself. Printing
  // the file produced a blank sheet. The root wears the marker so that rule points at it.
  it("marks its root as the print root, so the app's print rule does not hide it", () => {
    const out = buildExportDocument({ title: "t", body: surface("<p>content</p>"), css: "@media print{body > :not([data-print-root]){display:none !important}}" });
    expect(out).toMatch(/<main[^>]*data-print-root/);
    expect(out).toContain("content");
  });

  it("does not mutate the surface it was given", () => {
    const live = surface('<div><button class="cm-lp-code-copy">Copy</button><p onclick="x()">p</p></div>');
    buildExportDocument({ title: "t", body: live, css: "" });
    expect(live.querySelector("button"), "the live page still has its controls").not.toBeNull();
    expect(live.querySelector("p")?.getAttribute("onclick")).toBe("x()");
  });
});
