// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { applyCellMark, CELL_MARKS } from "./cell-inline-format";
import { renderCellInline, cellElToText } from "../macros/table-cell-dom";

// #89 comment 830: a table cell is a WYSIWYG surface — pressing Bold WRAPS the selection in <strong> so it
// LOOKS bold in place (not literal `**a**`), while the canonical text round-trips to Markdown via
// cellElToText and re-renders WYSIWYG via renderCellInline. These test that display↔source round-trip and
// the XSS boundary (no innerHTML; raw HTML in the source degrades to text).
const mark = (id: string) => CELL_MARKS.find((m) => m.id === id)!;

function cell(md: string): HTMLElement {
  const el = document.createElement("td");
  el.contentEditable = "true";
  renderCellInline(el, md); // WYSIWYG render of the Markdown source
  document.body.appendChild(el);
  return el;
}
// select the visible characters [from,to) of a single-text-node run inside `el`
function selectText(el: HTMLElement, needle: string) {
  const tn = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && (n.nodeValue ?? "").includes(needle)) as Text;
  const start = (tn.nodeValue ?? "").indexOf(needle);
  const r = document.createRange();
  r.setStart(tn, start); r.setEnd(tn, start + needle.length);
  const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
}

describe("#89 WYSIWYG cell marks — decorate in place, round-trip to Markdown", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("bold wraps the selection in <strong> (visible) and serialises to `**…**`", () => {
    const el = cell("hello world");
    selectText(el, "hello");
    expect(applyCellMark(el, mark("bold"))).toBe(true);
    expect(el.querySelector("strong")?.textContent).toBe("hello"); // shown bold, not literal **
    expect(cellElToText(el)).toBe("**hello** world"); // source round-trips
  });

  for (const [id, tag, open, close] of [["italic", "em", "*", "*"], ["strike", "s", "~~", "~~"], ["code", "code", "`", "`"]] as const) {
    it(`${id} → <${tag}> + ${open}…${close}`, () => {
      const el = cell("ab cd");
      selectText(el, "cd");
      applyCellMark(el, mark(id));
      expect(el.querySelector(tag)?.textContent).toBe("cd");
      expect(cellElToText(el)).toBe(`ab ${open}cd${close}`);
    });
  }

  it("link wraps in <a> and serialises to [text](url)", () => {
    const el = cell("see docs");
    selectText(el, "docs");
    applyCellMark(el, mark("link"));
    const a = el.querySelector("a");
    expect(a?.textContent).toBe("docs");
    expect(cellElToText(el)).toBe("see [docs](url)");
  });

  it("renderCellInline SHOWS existing marks WYSIWYG (round-trips both ways)", () => {
    const el = cell("a **b** c *d*");
    expect(el.querySelector("strong")?.textContent).toBe("b"); // ** hidden, shown bold
    expect(el.querySelector("em")?.textContent).toBe("d");
    expect(el.textContent).toBe("a b c d"); // no literal ** / * visible
    expect(cellElToText(el)).toBe("a **b** c *d*"); // back to source
  });

  it("preserves <br> line breaks across the round-trip", () => {
    const el = cell("one\ntwo");
    expect(el.querySelector("br")).toBeTruthy();
    expect(cellElToText(el)).toBe("one\ntwo");
  });

  it("XSS boundary: raw HTML in the source renders as TEXT, never a live element (no innerHTML)", () => {
    const el = cell("x <img src=q onerror=alert(1)> y");
    expect(el.querySelector("img")).toBeNull(); // no live <img>
    expect(el.textContent).toContain("<img"); // shown as literal text
  });

  it("a collapsed / out-of-cell selection is a no-op", () => {
    const el = cell("abc");
    const other = document.createElement("div"); other.textContent = "zzz"; document.body.appendChild(other);
    const r = document.createRange(); r.selectNodeContents(other);
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
    expect(applyCellMark(el, mark("bold"))).toBe(false);
    expect(cellElToText(el)).toBe("abc");
  });
});
