// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { applyCellMark, applyCellLink, CELL_MARKS } from "./cell-inline-format";
import { renderCellInline, cellElToText } from "../macros/table-cell-dom";
import { safeHref } from "../macros/md-render";

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

  it("#89 comment 886 (②): applyCellLink wraps in <a href=url> and serialises to [text](url)", () => {
    const el = cell("see docs");
    selectText(el, "docs");
    expect(applyCellLink(el, "https://example.com/x", safeHref)).toBe(true);
    const a = el.querySelector("a");
    expect(a?.textContent).toBe("docs");
    expect(a?.getAttribute("href")).toBe("https://example.com/x");
    expect(cellElToText(el)).toBe("see [docs](https://example.com/x)"); // real destination, not a placeholder
  });

  it("#89 comment 886 (②): a dangerous URL is rejected (safeHref is the only scheme judge) — no <a>", () => {
    const el = cell("see docs");
    selectText(el, "docs");
    expect(applyCellLink(el, "javascript:alert(1)", safeHref)).toBe(false);
    expect(el.querySelector("a")).toBeNull(); // stays plain text
    expect(cellElToText(el)).toBe("see docs");
  });

  it("#89 comment 886 (③): a mark spanning a <br> wraps PER LINE (both lines decorate, round-trips)", () => {
    const el = cell("one\ntwo");
    // select across the <br>: from "one" start to "two" end
    const texts = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE) as Text[];
    const r = document.createRange();
    r.setStart(texts[0]!, 0);
    r.setEnd(texts[texts.length - 1]!, (texts[texts.length - 1]!.nodeValue ?? "").length);
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
    expect(applyCellMark(el, mark("bold"))).toBe(true);
    // NOT one <strong>one<br>two</strong> (which serialises to `**one\ntwo**` → renderCellInline breaks it),
    // but a <strong> per line, so cellElToText closes the mark on each line.
    expect(el.querySelectorAll("strong").length).toBe(2);
    expect(el.querySelector("br")).toBeTruthy(); // the line break survives outside the marks
    expect(cellElToText(el)).toBe("**one**\n**two**");
    // and it re-renders WYSIWYG (both lines bold, no literal **)
    const el2 = cell("**one**\n**two**");
    expect(el2.querySelectorAll("strong").length).toBe(2);
    expect(el2.textContent).toBe("onetwo"); // no literal ** (happy-dom textContent drops the <br>)
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

  it("#236: fully marked selection → TOGGLES OFF (whole element)", () => {
    const el = cell("a **b** c");
    // select exactly the bold text "b" (inside the <strong>)
    const strong = el.querySelector("strong")!;
    const r = document.createRange();
    r.selectNodeContents(strong);
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
    expect(applyCellMark(el, mark("bold"))).toBe(true);
    expect(el.querySelector("strong")).toBeNull(); // mark removed
    expect(cellElToText(el)).toBe("a b c");
  });

  it("#236: sub-range of a marked element → only the selected part loses the mark (split)", () => {
    const el = cell("**abcdef**");
    const strong = el.querySelector("strong")!;
    const t = strong.firstChild as Text; // "abcdef"
    const r = document.createRange();
    r.setStart(t, 2); r.setEnd(t, 4); // "cd"
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
    expect(applyCellMark(el, mark("bold"))).toBe(true);
    expect(cellElToText(el)).toBe("**ab**cd**ef**"); // outside parts keep the mark
  });

  it("#236: MIXED selection (marked + plain) → unify-applies once, second press removes (edge case)", () => {
    const el = cell("a **b** c");
    const r = document.createRange();
    r.selectNodeContents(el); // whole cell: plain "a ", bold "b", plain " c"
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
    expect(applyCellMark(el, mark("bold"))).toBe(true);
    expect(el.querySelectorAll("strong").length).toBe(1); // ONE unified span (no nesting/adjacent frags)
    expect(cellElToText(el)).toBe("**a b c**");
    // second press on the (re-selected whole cell) removes it all
    expect(applyCellMark(el, mark("bold"))).toBe(true);
    expect(el.querySelector("strong")).toBeNull();
    expect(cellElToText(el)).toBe("a b c");
  });

  it("#236: removing bold KEEPS a nested italic (other marks preserved)", () => {
    const el = cell("**a *i* b**");
    const strong = el.querySelector("strong")!;
    const r = document.createRange();
    r.selectNodeContents(strong);
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
    expect(applyCellMark(el, mark("bold"))).toBe(true);
    expect(el.querySelector("strong")).toBeNull();
    expect(el.querySelector("em")?.textContent).toBe("i"); // italic survives
    expect(cellElToText(el)).toBe("a *i* b");
  });

  it("#236: multi-line (<br>) fully marked selection toggles OFF on both lines", () => {
    const el = cell("**one**\n**two**");
    const r = document.createRange();
    r.selectNodeContents(el); // both bold lines + the <br>
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
    expect(applyCellMark(el, mark("bold"))).toBe(true);
    expect(el.querySelector("strong")).toBeNull();
    expect(el.querySelector("br")).toBeTruthy(); // the line break survives
    expect(cellElToText(el)).toBe("one\ntwo");
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
