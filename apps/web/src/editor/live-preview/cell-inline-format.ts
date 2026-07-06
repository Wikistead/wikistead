// #89 (rescoped, 2026-07-06): the inline-decoration toolbar for a table cell being edited. A table cell is
// a contenteditable ISLAND with its OWN DOM selection (NOT CodeMirror's EditorSelection), so the CM
// floatingToolbar / `wrap(view, "**", "**")` can't reach it. This mounts a small floating toolbar that
// appears when text is selected inside the editing cell and applies the SAME inline marks (bold / italic /
// strikethrough / code / link) by wrapping the selected text in the cell's raw Markdown source.
//
// Offset-based, not DOM-splice-based: the cell renders raw text as text nodes + <br> (ADR-037: never
// innerHTML). We map the DOM selection to CHARACTER offsets in the cell text (cellElToText semantics —
// <br> = "\n"), wrap in offset space, re-render with setCellText, and restore the selection at the shifted
// offsets. This is robust across <br> boundaries and keeps the text-node + <br> XSS invariant (no innerHTML).

import { setCellText, cellElToText, stripZeroWidth } from "../macros/table-cell-dom";

// The inline marks, mirroring INLINE_FORMATS (commands.ts) — same set the CM toolbar / `\` palette apply,
// so a cell decorates identically to body text. `link` selects the inserted "url" placeholder afterwards.
export type Mark = { id: string; label: string; before: string; after: string; selectPlaceholder?: string };
export const CELL_MARKS: Mark[] = [
  { id: "bold", label: "B", before: "**", after: "**" },
  { id: "italic", label: "I", before: "*", after: "*" },
  { id: "strike", label: "S", before: "~~", after: "~~" },
  { id: "code", label: "</>", before: "`", after: "`" },
  { id: "link", label: "Link", before: "[", after: "](url)", selectPlaceholder: "url" },
];

// Character offset in the cell text of a DOM point (node, offset), counting text-node chars and each <br>
// as one "\n" — the same accounting as cellElToText, so offsets line up with the committed source.
function offsetOfPoint(root: HTMLElement, node: Node, nodeOffset: number): number {
  let acc = 0;
  let found = -1;
  const walk = (n: Node): boolean => {
    if (n === node && n.nodeType !== Node.ELEMENT_NODE) { found = acc + nodeOffset; return true; }
    if (n.nodeType === Node.TEXT_NODE) {
      acc += (n.nodeValue ?? "").length;
    } else if (n instanceof HTMLBRElement) {
      acc += 1; // "\n"
    } else if (n instanceof HTMLElement) {
      if (n.classList.contains("cm-lp-col-resize") || n.classList.contains("cm-lp-row-resize")) return false;
      for (let c = n.firstChild; c; c = c.nextSibling) { if (walk(c)) return true; }
      if (n === node) { found = acc; return true; } // element-node point = at the accumulated end
    }
    return false;
  };
  if (node === root && node.nodeType === Node.ELEMENT_NODE) {
    // a point expressed as (root, childIndex): sum the lengths of the first `nodeOffset` children
    let i = 0;
    for (let c = root.firstChild; c && i < nodeOffset; c = c.nextSibling, i++) {
      if (c.nodeType === Node.TEXT_NODE) acc += (c.nodeValue ?? "").length;
      else if (c instanceof HTMLBRElement) acc += 1;
    }
    return acc;
  }
  for (let c = root.firstChild; c; c = c.nextSibling) { if (walk(c)) break; }
  return found >= 0 ? found : acc;
}

// The reverse: a {node, offset} DOM point for a character offset, over a cell rebuilt by setCellText
// (a flat run of text nodes and <br>s).
function pointOfOffset(root: HTMLElement, target: number): { node: Node; offset: number } {
  let acc = 0;
  for (let c = root.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === Node.TEXT_NODE) {
      const len = (c.nodeValue ?? "").length;
      if (target <= acc + len) return { node: c, offset: target - acc };
      acc += len;
    } else if (c instanceof HTMLBRElement) {
      if (target <= acc) return { node: root, offset: indexOfChild(root, c) };
      acc += 1;
    }
  }
  return { node: root, offset: root.childNodes.length };
}
function indexOfChild(parent: HTMLElement, child: Node): number {
  let i = 0;
  for (let c = parent.firstChild; c; c = c.nextSibling, i++) if (c === child) return i;
  return i;
}

// Apply a mark to the current selection inside `el`, then reselect the wrapped inner text (or the mark's
// placeholder, e.g. "url"). Returns true if it acted (a real selection was present).
export function applyCellMark(el: HTMLElement, mark: Mark): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return false;
  const full = stripZeroWidth(cellElToText(el));
  let from = offsetOfPoint(el, range.startContainer, range.startOffset);
  let to = offsetOfPoint(el, range.endContainer, range.endOffset);
  if (from > to) [from, to] = [to, from];
  const inner = full.slice(from, to);
  const next = full.slice(0, from) + mark.before + inner + mark.after + full.slice(to);
  setCellText(el, next);
  // Restore a selection: for `link` on a wrap, select the "url" placeholder; otherwise select the inner text.
  let selFrom: number, selTo: number;
  if (mark.selectPlaceholder && mark.after.includes(mark.selectPlaceholder)) {
    const phAt = from + mark.before.length + inner.length + mark.after.indexOf(mark.selectPlaceholder);
    selFrom = phAt; selTo = phAt + mark.selectPlaceholder.length;
  } else {
    selFrom = from + mark.before.length; selTo = selFrom + inner.length;
  }
  const a = pointOfOffset(el, selFrom); const b = pointOfOffset(el, selTo);
  const r = document.createRange();
  r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset);
  sel.removeAllRanges(); sel.addRange(r);
  return true;
}

// Mount the floating toolbar for a cell in edit mode. It shows only while a non-collapsed selection sits
// inside `cellEl`, positioned above the selection; a button mousedown applies its mark WITHOUT blurring the
// cell (preventDefault keeps focus/selection). destroy() removes it + its listeners.
export function mountCellFormatToolbar(cellEl: HTMLElement): { destroy(): void } {
  const bar = document.createElement("div");
  bar.className = "cm-lp-cell-format-bar";
  bar.setAttribute("data-testid", "cell-format-bar");
  bar.style.display = "none";
  for (const mark of CELL_MARKS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cm-lp-cell-format-btn";
    b.textContent = mark.label;
    b.setAttribute("data-testid", `cell-format-${mark.id}`);
    b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); applyCellMark(cellEl, mark); position(); });
    bar.appendChild(b);
  }
  document.body.appendChild(bar);

  const position = () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !cellEl.contains(sel.anchorNode)) { bar.style.display = "none"; return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { bar.style.display = "none"; return; }
    bar.style.display = "flex";
    // measure after display so offsetWidth/Height are real
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    let left = rect.left + rect.width / 2 - bw / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - bw - 4));
    let top = rect.top - bh - 6;
    if (top < 4) top = rect.bottom + 6; // flip below if it would clip the top
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
  };
  const onSel = () => position();
  document.addEventListener("selectionchange", onSel);
  // reposition on scroll/resize while open
  window.addEventListener("scroll", onSel, true);
  window.addEventListener("resize", onSel);
  return {
    destroy() {
      document.removeEventListener("selectionchange", onSel);
      window.removeEventListener("scroll", onSel, true);
      window.removeEventListener("resize", onSel);
      bar.remove();
    },
  };
}
