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

  it("does not mutate the surface it was given", () => {
    const live = surface('<div><button class="cm-lp-code-copy">Copy</button><p onclick="x()">p</p></div>');
    buildExportDocument({ title: "t", body: live, css: "" });
    expect(live.querySelector("button"), "the live page still has its controls").not.toBeNull();
    expect(live.querySelector("p")?.getAttribute("onclick")).toBe("x()");
  });
});
