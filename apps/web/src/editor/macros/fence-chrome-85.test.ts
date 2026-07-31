// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import "./index";
import { renderMarkdownToDom } from "./md-render";

// #85 (user ruling 2026-07-28): the fence's chrome is part of the document. A `showLineNumbers` fence shows
// its numbers and a `{1,3-5}` fence tints those lines on the editing surface; a reader, a printed sheet or
// an exported file without them is not the same document. The editor draws them as per-LINE decorations, so
// the read surface uses the same classes on per-line elements — one truth about what a numbered or
// highlighted line looks like, rather than a second invention.
const render = (src: string): HTMLElement => {
  const host = document.createElement("div");
  host.appendChild(renderMarkdownToDom(src));
  return host;
};

describe("#85: the read surface keeps a fence's chrome", () => {
  it("numbers the lines when the fence asks for numbers", () => {
    const host = render('```js showLineNumbers\nconst x = 1;\nconst y = 2;\n```');
    const lines = host.querySelectorAll(".cm-lp-code-numbered");
    expect(lines.length, "one numbered element per line").toBe(2);
    expect(lines[0]!.getAttribute("data-linenum")).toBe("1");
    expect(lines[1]!.getAttribute("data-linenum")).toBe("2");
  });

  it("bands the highlighted lines, and only those", () => {
    const host = render('```js {2}\nconst x = 1;\nconst y = 2;\nconst z = 3;\n```');
    const banded = Array.from(host.querySelectorAll(".cm-lp-code-hl"));
    expect(banded.length).toBe(1);
    expect(banded[0]!.textContent).toContain("const y = 2;");
  });

  it("keeps the filename tab", () => {
    const host = render('```js title="app.js"\nconst x = 1;\n```');
    expect(host.querySelector(".cm-lp-code-title")?.textContent).toBe("app.js");
  });

  it("a plain fence stays a single code node — no chrome invented", () => {
    const host = render("```js\nconst x = 1;\n```");
    expect(host.querySelectorAll(".cm-lp-code-numbered").length).toBe(0);
    expect(host.querySelectorAll(".cm-lp-code-hl").length).toBe(0);
    expect(host.querySelector("pre code")?.textContent).toContain("const x = 1;");
  });
});

// #565 bug 2, read-surface parity (the two-renderer rule): a language-less fence whose first token
// is an attribute must render the attribute's chrome — not a garbage language badge — on the same
// path the published page and exports use.
describe("#565: language-less fences keep their chrome on the read surface", () => {
  it('```title="AA" renders the filename tab and no language badge text', () => {
    const host = render('```title="AA"\nconst x = 1;\n```');
    expect(host.querySelector(".cm-lp-code-title")?.textContent).toBe("AA");
    expect(host.textContent).not.toContain('title="AA"');
  });
  it("```showLineNumbers numbers the lines", () => {
    const host = render("```showLineNumbers\nconst x = 1;\nconst y = 2;\n```");
    expect(host.querySelectorAll(".cm-lp-code-numbered").length).toBe(2);
  });
  it("```{1} bands the first line", () => {
    const host = render("```{1}\nconst x = 1;\nconst y = 2;\n```");
    const banded = Array.from(host.querySelectorAll(".cm-lp-code-hl"));
    expect(banded.length).toBe(1);
    expect(banded[0]!.textContent).toContain("const x = 1;");
  });
});
