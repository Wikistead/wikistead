// #89 (rescoped, then comment 830): the inline-decoration toolbar for a table cell being edited. A cell is
// a contenteditable ISLAND with its OWN DOM selection (not CodeMirror's), and it is a WYSIWYG surface —
// pressing Bold must make the selection LOOK bold immediately (not insert literal `**`). So a mark WRAPS
// the DOM selection in the corresponding safe element (strong/em/s/code/a), built with createElement (never
// innerHTML — the ADR-037 / #89 XSS boundary). The cell's canonical Markdown round-trips via cellElToText
// (<strong> → `**…**`), and re-opening a cell shows the marks WYSIWYG via renderCellInline.

// Each mark is a factory for its wrapper element. `a` gets a placeholder href="url" that round-trips to
// `[text](url)`; the user edits the URL in Source view (Open formats).
type Mark = { id: string; label: string; el: () => HTMLElement };
export const CELL_MARKS: Mark[] = [
  { id: "bold", label: "B", el: () => document.createElement("strong") },
  { id: "italic", label: "I", el: () => document.createElement("em") },
  { id: "strike", label: "S", el: () => document.createElement("s") },
  { id: "code", label: "</>", el: () => document.createElement("code") },
  { id: "link", label: "Link", el: () => { const a = document.createElement("a"); a.setAttribute("href", "url"); return a; } },
];

// Wrap the current selection inside `el` with the mark's element — the decoration appears in place
// (WYSIWYG). Returns false for a collapsed / out-of-cell selection. DOM-space (no source-offset math), so
// it composes with existing marks (selecting bold text and pressing italic nests em>strong).
export function applyCellMark(el: HTMLElement, mark: Mark): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (range.collapsed || !el.contains(range.commonAncestorContainer)) return false;
  const wrapper = mark.el();
  try {
    wrapper.appendChild(range.extractContents());
    range.insertNode(wrapper);
  } catch {
    return false; // a range crossing element boundaries that can't be extracted cleanly — no-op
  }
  el.normalize(); // merge any split text nodes so cellElToText reads clean runs
  const r = document.createRange();
  r.selectNodeContents(wrapper);
  sel.removeAllRanges();
  sel.addRange(r);
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
