// @vitest-environment happy-dom
// #85 (review rejection, measured on a saved file): a line break inside a paragraph or a quote survives.
//
// What the reader saw: a two-line quote arrived in the exported HTML as one run of prose. The measurement
// in the bounce was `brs=0 / ps=1`. CommonMark folds a soft break into a space, which is a defensible
// reading of the format and an indefensible difference from the EDITING surface — CodeMirror draws the
// source, so the author sees two lines while every static surface shows one. #381's rule is that the
// surfaces agree; the editor cannot be the one to move, because it renders what was typed.
//
// So the shared visitor emits a break, and every sink built on it inherits the fix at once: the read
// surface, the export, the print portal, the server's HTML render. This file pins the DOM sink, which is
// what the export serializes.
//
// Two details that are easy to get wrong and are pinned as such:
//   - the continuation of a QUOTE starts with the space that followed `>` (the mark is its own node), so
//     the break must swallow it or every continued line is indented by one space;
//   - a trailing newline is not a break: every block ends with one, and emitting it hangs an empty `<br>`
//     inside every heading and paragraph.
import { describe, it, expect } from "vitest";
import { renderMarkdownToDom } from "./md-render";

const html = (md: string): string => {
  const d = document.createElement("div");
  d.appendChild(renderMarkdownToDom(md));
  return d.innerHTML;
};

describe("#85: a soft line break is a line break", () => {
  it("in a paragraph", () => {
    expect(html("para one\npara two\n")).toBe("<p>para one<br>para two</p>");
  });

  it("in a quote, without indenting the continued line", () => {
    expect(html("> quote line one\n> quote line two\n")).toBe(
      "<blockquote><p>quote line one<br>quote line two</p></blockquote>",
    );
  });

  it("in a list item's continuation", () => {
    expect(html("- item one\n  continued\n")).toBe("<ul><li><p>item one<br>continued</p></li></ul>");
  });

  it("before an inline node, not only before plain text", () => {
    // the break is emitted lazily, so this is the case where laziness could swallow it
    expect(html("line one\n**bold** after\n")).toBe("<p>line one<br><strong>bold</strong> after</p>");
  });

  it("and never as a trailing break at the end of a block", () => {
    expect(html("just one line\n")).toBe("<p>just one line</p>");
    expect(html("# heading\n")).toBe("<h1>heading</h1>");
  });

  it("a hard break still works, and does not double up", () => {
    // `line\` (backslash) is the explicit hard break — it must not produce two <br>
    expect(html("line one\\\nline two\n")).toBe("<p>line one<br>line two</p>");
  });

  it("a blank line still separates paragraphs (a break is not a paragraph)", () => {
    expect(html("one\n\ntwo\n")).toBe("<p>one</p><p>two</p>");
  });
});
