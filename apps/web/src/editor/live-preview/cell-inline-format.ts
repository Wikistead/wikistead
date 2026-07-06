import { safeHref } from "../macros/md-render"; // #89 comment 886 (②): the ONLY scheme judge for a cell link

// #89 (rescoped, then comment 830): the inline-decoration toolbar for a table cell being edited. A cell is
// a contenteditable ISLAND with its OWN DOM selection (not CodeMirror's), and it is a WYSIWYG surface —
// pressing Bold must make the selection LOOK bold immediately (not insert literal `**`). So a mark WRAPS
// the DOM selection in the corresponding safe element (strong/em/s/code/a), built with createElement (never
// innerHTML — the ADR-037 / #89 XSS boundary). The cell's canonical Markdown round-trips via cellElToText
// (<strong> → `**…**`), and re-opening a cell shows the marks WYSIWYG via renderCellInline.

// Each mark is a factory for its wrapper element. `link` needs a URL, so it is NOT a plain wrapper — the
// toolbar routes it through the URL popover (applyCellLink) instead of applyCellMark.
type Mark = { id: string; label: string; el: () => HTMLElement };
export const CELL_MARKS: Mark[] = [
  { id: "bold", label: "B", el: () => document.createElement("strong") },
  { id: "italic", label: "I", el: () => document.createElement("em") },
  { id: "strike", label: "S", el: () => document.createElement("s") },
  { id: "code", label: "</>", el: () => document.createElement("code") },
];

// #89 comment 886 (③): wrap a range's contents PER LINE, so a mark that spans a <br> becomes
// `<strong>a</strong><br><strong>b</strong>` — NOT `<strong>a<br>b</strong>`. The latter serialises to
// `**a\nb**` (cellElToText), which renderCellInline then splits per line into `**a` + `b**` (both literal,
// unclosed) — the reported "multi-line cell decoration breaks". Grouping the extracted fragment's top-level
// nodes at <br> boundaries and wrapping each group keeps every line's mark self-closed and round-trippable.
function wrapPerLine(fragment: DocumentFragment, makeEl: () => HTMLElement): DocumentFragment {
  const out = document.createDocumentFragment();
  let current: HTMLElement | null = null;
  for (const node of Array.from(fragment.childNodes)) {
    if (node instanceof HTMLBRElement) { out.appendChild(node); current = null; continue; } // line break — end the run
    if (!current) { current = makeEl(); out.appendChild(current); }
    current.appendChild(node);
  }
  return out;
}

// Wrap the current selection inside `mark`'s element(s) — the decoration appears in place (WYSIWYG). Returns
// false for a collapsed / out-of-cell selection. DOM-space (no source-offset math), so it composes with
// existing marks (selecting bold text and pressing italic nests em>strong). A selection crossing <br>s is
// wrapped per line (see wrapPerLine).
export function applyCellMark(el: HTMLElement, mark: Mark): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (range.collapsed || !el.contains(range.commonAncestorContainer)) return false;
  let inserted: DocumentFragment;
  try {
    inserted = wrapPerLine(range.extractContents(), mark.el);
    range.insertNode(inserted);
  } catch {
    return false; // a range crossing element boundaries that can't be extracted cleanly — no-op
  }
  el.normalize(); // merge any split text nodes so cellElToText reads clean runs
  const r = document.createRange();
  r.selectNodeContents(el); // re-select the whole cell (multiple wrappers may exist after a per-line wrap)
  sel.removeAllRanges();
  sel.addRange(r);
  return true;
}

// #89 comment 886 (②): apply a LINK with a real destination. Wraps each selected line's contents in an
// `<a href>` (per line, like applyCellMark), but ONLY if `url` passes safeHref — the SAME single scheme
// judge (ADR-037; no new XSS boundary). A dangerous/empty URL is a no-op (the text stays plain). Built with
// createElement, never innerHTML. Returns false for a collapsed / out-of-cell selection or a rejected URL.
export function applyCellLink(el: HTMLElement, url: string, safeHref: (u: string) => string | null, range?: Range): boolean {
  const href = safeHref(url.trim());
  if (!href) return false;
  const sel = window.getSelection();
  // Operate on the EXPLICIT range when given (the URL popover snapshots the cell selection before its input
  // steals focus — a focused <input> has its own selection, so window.getSelection() no longer points at the
  // cell). extractContents/insertNode work on any Range, independent of the document selection.
  const r = range ?? (sel && sel.rangeCount ? sel.getRangeAt(0) : null);
  if (!r || r.collapsed || !el.contains(r.commonAncestorContainer)) return false;
  try {
    const inserted = wrapPerLine(r.extractContents(), () => { const a = document.createElement("a"); a.setAttribute("href", href); return a; });
    r.insertNode(inserted);
  } catch {
    return false;
  }
  el.normalize();
  if (sel && !range) { const sr = document.createRange(); sr.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(sr); }
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
  // #89 comment 886 (②): the Link button opens a small URL input (the missing "enter the destination" step —
  // previously it wrapped a fixed placeholder href="url" that couldn't be edited). mousedown-preventDefault
  // keeps the cell's selection; we snapshot the range, then on confirm restore it and wrap via applyCellLink
  // (safeHref is the only scheme judge). Escape / blur cancels.
  const linkBtn = document.createElement("button");
  linkBtn.type = "button";
  linkBtn.className = "cm-lp-cell-format-btn";
  linkBtn.textContent = "Link";
  linkBtn.setAttribute("data-testid", "cell-format-link");
  let savedRange: Range | null = null;
  let popover: HTMLElement | null = null;
  let dismissPopover: ((e: Event) => void) | null = null;
  const closePopover = () => {
    if (dismissPopover) { document.removeEventListener("pointerdown", dismissPopover, true); dismissPopover = null; }
    popover?.remove();
    popover = null;
    savedRange = null;
  };
  linkBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !cellEl.contains(sel.anchorNode)) return;
    closePopover(); // clear any prior popover FIRST (it nulls savedRange) — then snapshot the selection
    savedRange = sel.getRangeAt(0).cloneRange();
    popover = document.createElement("div");
    popover.className = "cm-lp-cell-link-popover";
    popover.setAttribute("data-testid", "cell-link-popover");
    const input = document.createElement("input");
    input.type = "url";
    input.placeholder = "https://…";
    input.setAttribute("data-testid", "cell-link-url");
    const confirm = () => {
      if (savedRange) applyCellLink(cellEl, input.value, safeHref, savedRange); // operate on the snapshot range
      closePopover();
      cellEl.focus(); // hand focus back to the cell so editing continues (its blur skipped the popover)
      position();
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") { ev.preventDefault(); confirm(); }
      else if (ev.key === "Escape") { ev.preventDefault(); closePopover(); }
    });
    popover.appendChild(input);
    document.body.appendChild(popover);
    const r = savedRange.getBoundingClientRect();
    popover.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - popover.offsetWidth - 4))}px`;
    popover.style.top = `${r.bottom + 6}px`;
    input.focus();
    // Click-away cancels (a pointerdown outside the popover). Deferred so THIS mousedown doesn't self-dismiss.
    // Not a blur handler — blur races with test drivers and focus churn; an explicit outside-pointerdown is
    // deterministic (mirrors the callout type menu).
    dismissPopover = (ev: Event) => { if (popover && !popover.contains(ev.target as Node)) closePopover(); };
    setTimeout(() => { if (dismissPopover) document.addEventListener("pointerdown", dismissPopover, true); }, 0);
  });
  bar.appendChild(linkBtn);
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
      closePopover();
      bar.remove();
    },
  };
}
