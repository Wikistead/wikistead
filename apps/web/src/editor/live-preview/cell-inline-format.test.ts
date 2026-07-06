// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { applyCellMark, CELL_MARKS } from "./cell-inline-format";
import { setCellText, cellElToText } from "../macros/table-cell-dom";

// #89 (rescoped): the inline-decoration toolbar for a table cell. The risky core is the OFFSET mapping —
// a DOM selection inside a contenteditable cell (text nodes + <br>) is wrapped with the Markdown mark and
// the cell re-rendered, keeping the ADR-037 text-node/<br> invariant (never innerHTML). These test that
// core against the SAME cellElToText accounting the commit path uses, so a wrap round-trips to source.
const mark = (id: string) => CELL_MARKS.find((m) => m.id === id)!;

// Select [from,to) characters of a single-text-node cell (the common case) and return the element.
function cell(text: string): HTMLElement {
  const el = document.createElement("td");
  el.contentEditable = "true";
  setCellText(el, text);
  document.body.appendChild(el);
  return el;
}
function selectChars(el: HTMLElement, from: number, to: number) {
  // walk text nodes to find the DOM points for the char offsets (single/multi text node)
  const point = (target: number): { node: Node; offset: number } => {
    let acc = 0;
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === Node.TEXT_NODE) {
        const len = (c.nodeValue ?? "").length;
        if (target <= acc + len) return { node: c, offset: target - acc };
        acc += len;
      } else if (c instanceof HTMLBRElement) {
        if (target <= acc) return { node: el, offset: Array.from(el.childNodes).indexOf(c) };
        acc += 1;
      }
    }
    return { node: el, offset: el.childNodes.length };
  };
  const a = point(from), b = point(to);
  const r = document.createRange();
  r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset);
  const s = window.getSelection()!;
  s.removeAllRanges(); s.addRange(r);
}

describe("#89 applyCellMark — wrap a cell selection in Markdown, offset-correct", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("wraps the selected word with the bold mark (source round-trips)", () => {
    const el = cell("hello world");
    selectChars(el, 0, 5); // "hello"
    expect(applyCellMark(el, mark("bold"))).toBe(true);
    expect(cellElToText(el)).toBe("**hello** world");
  });

  for (const [id, open, close] of [["italic", "*", "*"], ["strike", "~~", "~~"], ["code", "`", "`"]] as const) {
    it(`wraps with the ${id} mark`, () => {
      const el = cell("ab cd");
      selectChars(el, 3, 5); // "cd"
      applyCellMark(el, mark(id));
      expect(cellElToText(el)).toBe(`ab ${open}cd${close}`);
    });
  }

  it("link wraps the selection as a label and inserts a url placeholder", () => {
    const el = cell("see docs");
    selectChars(el, 4, 8); // "docs"
    applyCellMark(el, mark("link"));
    expect(cellElToText(el)).toBe("see [docs](url)");
    // the restored selection covers the "url" placeholder so it can be typed over
    expect(window.getSelection()?.toString()).toBe("url");
  });

  it("is offset-correct ACROSS a <br> (multi-line cell text nodes + <br> = \\n)", () => {
    const el = cell("one\ntwo"); // text "one", <br>, text "two" → offsets 0..7 with \n at 3
    selectChars(el, 4, 7); // "two" (after the \n)
    applyCellMark(el, mark("bold"));
    expect(cellElToText(el)).toBe("one\n**two**"); // the <br> line break is preserved
  });

  it("restores the selection over the wrapped inner text (not the markers)", () => {
    const el = cell("pick me");
    selectChars(el, 5, 7); // "me"
    applyCellMark(el, mark("bold"));
    expect(window.getSelection()?.toString()).toBe("me"); // caret sits on the content, markers excluded
  });

  it("a collapsed caret inserts the empty pair (no crash)", () => {
    const el = cell("x");
    selectChars(el, 1, 1); // caret at end
    applyCellMark(el, mark("bold"));
    expect(cellElToText(el)).toBe("x****");
  });

  it("does nothing when the selection is outside the cell", () => {
    const el = cell("abc");
    const other = document.createElement("div"); other.textContent = "zzz"; document.body.appendChild(other);
    const r = document.createRange(); r.selectNodeContents(other);
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
    expect(applyCellMark(el, mark("bold"))).toBe(false);
    expect(cellElToText(el)).toBe("abc");
  });
});
