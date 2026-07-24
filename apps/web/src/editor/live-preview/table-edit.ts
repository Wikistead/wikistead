import { mergeRect, unmergeAt, toHtml, styleToCss, insertColAt, insertRowAt, deleteColAt, deleteRowAt, parseTableSource, tableAlignOf, tableFence, type Grid, type CellStyle } from "../macros/table-model";
import type { InnerEditHost, InlineEditor, InlineController } from "../macros/registry";
import { asMacroSource } from "../macros/registry";
import { renderCellInline, cellElToText, insertBrAtCaret, insertTextAtCaret, stripZeroWidth } from "../macros/table-cell-dom";
import { renderInlineMarkdownToDom } from "../macros/md-render"; // #223 comment 910: render a linkify result to a real <a>
import { mountCellFormatToolbar } from "./cell-inline-format";
import { linkifyPaste } from "./paste-linkify";

// #223 comment 910 (C): insert an inline DOM fragment (e.g. an <a> link) at the cell's caret, replacing
// the selection. Keeps text+<br> only (the fragment is built by renderInlineMarkdownToDom via createElement,
// never innerHTML — the ADR-037 XSS boundary). Falls back to nothing if there is no cell selection.
function insertInlineDomAtCaret(frag: DocumentFragment): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(frag);
  range.collapse(false); // caret after the inserted content
  sel.removeAllRanges();
  sel.addRange(range);
}

// #154: the uniform multi-select resize size — PURE so it is unit-testable (the previous impl set
// every selected column to draggedWidth+delta, ballooning the block so the dragged edge didn't track
// the pointer). `per` = the size EACH of the `n` affected columns/rows takes so the block's dragged
// (right/bottom) edge lands exactly at `pointer`: (pointer − blockStart) / n. Clamped to `min`, and
// (columns) to maxBlock/n so the whole table can't overflow the visible width (#5). n=1 → the single
// column/row's edge follows the pointer (the prior single-resize behaviour).
export function uniformResizeSize(pointer: number, blockStart: number, n: number, min: number, maxBlock: number): number {
  let per = Math.round((pointer - blockStart) / n);
  per = Math.max(min, per);
  if (per * n > maxBlock) per = Math.floor(maxBlock / n);
  return per;
}

// ADR-025 step 2: the table's INLINE rich-editor — VIEW-FREE. It mounts its DOM into
// `container` and talks ONLY to InnerEditHost (theme/getSource/replaceSource/exit); it never
// touches the EditorView/Yjs (a host-layer bridge widget wires it in). Cells select on click;
// the toolbar merges/unmerges/aligns/colours/sizes/header-toggles/insert-deletes. Each op
// rewrites the block by handing the host a LOSSLESS :::table source; the HOST's MacroTier
// auto-demotes it to the lowest representable level — pipes (Tier 1) or :::table HTML
// (Tier 2) (ADR-025 step 3). Committed via host.replaceSource (one offset-invariant Y.Text
// edit, per-op). The grid is parsed from host.getSource at mount.
// Controlled background palette: undefined = clear; var(--accent) stays on theme; the
// tints are safe hex (pass the style allowlist). Not a free color picker (ADR-022 #2).
const BG_PRESETS: { id: string; value: string | undefined; title: string }[] = [
  { id: "clear", value: undefined, title: "No fill" },
  { id: "accent", value: "var(--accent)", title: "Accent" },
  { id: "red", value: "#fde8e8", title: "Red" },
  { id: "yellow", value: "#fef3c7", title: "Yellow" },
  { id: "green", value: "#e7f6e7", title: "Green" },
  { id: "blue", value: "#e6f0fb", title: "Blue" },
];

// #209: pick a legible text colour for a cell's background — dark text on a light fill, light on a
// dark one — so a coloured cell reads in BOTH themes. The palette tints are LIGHT, so in dark mode the
// theme's light text would vanish on them without this. undefined bg (clear) → clear the colour too
// (inherit the theme). var(--accent) → the accent's paired foreground token (already contrast-safe).
export function contrastColor(bg: string | undefined): string | undefined {
  if (!bg) return undefined;
  if (bg.startsWith("var(")) return "var(--accent-fg)"; // the palette's only var() is --accent
  const m = /^#([0-9a-f]{6})$/i.exec(bg.trim());
  if (!m) return undefined;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; // sRGB relative luminance (simple)
  return lum > 0.6 ? "#1f2328" : "#ffffff";
}

function btn(label: string, testid: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cm-lp-table-edit-btn";
  b.textContent = label;
  b.setAttribute("data-testid", testid);
  return b;
}

// Static, trusted inline SVG icons (no user data → innerHTML is safe here). Recognizable
// text-align bars and cell merge/split glyphs (ADR-022 review #3).
const I = (paths: string) => `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">${paths}</svg>`;
const ICON: Record<string, string> = {
  merge: I('<rect x="2" y="3.5" width="12" height="9" rx="1"/><path d="M8 3.5v9" stroke-dasharray="1.5 1.5"/><path d="M5.5 8h5M9 6l1.5 2L9 10M6.5 6L5 8l1.5 2"/>'),
  unmerge: I('<rect x="2" y="3.5" width="12" height="9" rx="1"/><path d="M8 3.5v9"/>'),
  alignLeft: I('<path d="M2 4h12M2 8h7M2 12h10"/>'),
  alignCenter: I('<path d="M2 4h12M5 8h6M3 12h10"/>'),
  alignRight: I('<path d="M2 4h12M7 8h7M4 12h10"/>'),
  // #256: insert/delete/no-fill were Unicode glyphs (U+229E ⊞, ✕, ⌀) that fall back to system fonts and
  // break (tofu / mixed weight) on some environments. Replace with trusted static SVG (Lucide-family look
  // thin round strokes at 16px, matching the merge/align icons above) so no font fallback ever occurs.
  colInsBefore: I('<rect x="9" y="2.5" width="4.5" height="11" rx="1"/><path d="M3.5 8h3.5M5.25 6.25v3.5"/>'),
  colInsAfter: I('<rect x="2.5" y="2.5" width="4.5" height="11" rx="1"/><path d="M9 8h3.5M10.75 6.25v3.5"/>'),
  rowInsAbove: I('<rect x="2.5" y="9" width="11" height="4.5" rx="1"/><path d="M6.25 5.25h3.5M8 3.5v3.5"/>'),
  rowInsBelow: I('<rect x="2.5" y="2.5" width="11" height="4.5" rx="1"/><path d="M6.25 10.75h3.5M8 9v3.5"/>'),
  del: I('<path d="M3 4.5h10M6.5 4.5V3.2a.7.7 0 0 1 .7-.7h1.6a.7.7 0 0 1 .7.7v1.3M4.6 4.5l.6 8a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.6-8M6.6 7v3.5M9.4 7v3.5"/>'),
  noFill: I('<circle cx="8" cy="8" r="5.5"/><path d="M4.1 4.1l7.8 7.8"/>'),
};
function svgBtn(svg: string, testid: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cm-lp-table-edit-btn";
  b.innerHTML = svg; // trusted static icon
  b.dataset.tip = title; // #530: fast tooltip (was native title)
  b.setAttribute("data-testid", testid);
  return b;
}

export const tableInlineEditor: InlineEditor = {
  mount(container: HTMLElement, host: InnerEditHost): InlineController {
    const grid: Grid = parseTableSource(host.getSource());
    container.className = "cm-lp-table-edit";
    container.setAttribute("data-testid", "table-edit");

    // Floating contextual toolbar (ADR-022 review #1): shown near the selected cells,
    // not as an always-on bar. Hidden until something is selected.
    const bar = document.createElement("div");
    bar.className = "cm-lp-table-edit-bar";
    bar.style.display = "none";
    const mergeBtn = svgBtn(ICON.merge!, "table-merge", "Merge cells");
    const unmergeBtn = svgBtn(ICON.unmerge!, "table-unmerge", "Unmerge cells");
    const alignL = svgBtn(ICON.alignLeft!, "table-align-left", "Align left");
    const alignC = svgBtn(ICON.alignCenter!, "table-align-center", "Align center");
    const alignR = svgBtn(ICON.alignRight!, "table-align-right", "Align right");
    const headerBtn = btn("H", "table-header");
    headerBtn.dataset.tip = "Toggle header cells"; // #530
    const doneBtn = btn("Done", "table-done");
    // Structural ops (#1): insert/delete the selected column or row. Each group is shown
    // only when its kind is selected (via the column/row handle), so before/after is clear.
    const colOps = document.createElement("span");
    colOps.className = "cm-lp-table-ops";
    const colInsL = svgBtn(ICON.colInsBefore!, "table-col-insert-before", "Insert column before");
    const colInsR = svgBtn(ICON.colInsAfter!, "table-col-insert-after", "Insert column after");
    const colDel = svgBtn(ICON.del!, "table-col-delete", "Delete column");
    colDel.classList.add("cm-lp-table-edit-btn-danger"); // #256 comment 1035: destructive → --danger (red)
    colOps.append(colInsL, colInsR, colDel);
    const rowOps = document.createElement("span");
    rowOps.className = "cm-lp-table-ops";
    const rowInsT = svgBtn(ICON.rowInsAbove!, "table-row-insert-above", "Insert row above");
    const rowInsB = svgBtn(ICON.rowInsBelow!, "table-row-insert-below", "Insert row below");
    const rowDel = svgBtn(ICON.del!, "table-row-delete", "Delete row");
    rowDel.classList.add("cm-lp-table-edit-btn-danger"); // #256 comment 1035: destructive → --danger (red)
    rowOps.append(rowInsT, rowInsB, rowDel);
    // #217 (comment 772): the bar WRAPS at a narrow width (flex-wrap on the bar) but each LOGICAL GROUP is
    // an indivisible unit (a `cm-lp-table-ops` span with flex-shrink:0 and no internal wrap), so groups
    // wrap whole — merge / align / header / column-ops / row-ops / colour / done never scatter mid-group.
    const mkGroup = (...els: HTMLElement[]) => { const g = document.createElement("span"); g.className = "cm-lp-table-ops"; g.append(...els); return g; };
    // Background-color presets (ADR-022 review #2): a controlled palette (theme accent + soft tints),
    // NOT a free picker — keeps tables on-theme, accessible, round-trip-safe. Grouped so they wrap together.
    const colorGroup = document.createElement("span");
    colorGroup.className = "cm-lp-table-ops";
    for (const p of BG_PRESETS) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "cm-lp-table-swatch";
      sw.dataset.tip = p.title; // #530
      sw.setAttribute("data-testid", "table-bg-" + p.id);
      sw.style.background = p.value ?? "transparent";
      if (!p.value) sw.innerHTML = ICON.noFill!; // #256: "no fill" — trusted static SVG, not a font glyph
      // #209: set the background AND a contrast-matched text colour so the cell is legible in both themes.
      sw.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); patchStyle({ bg: p.value, color: contrastColor(p.value) }); });
      colorGroup.appendChild(sw);
    }
    bar.append(mkGroup(mergeBtn, unmergeBtn), mkGroup(alignL, alignC, alignR), mkGroup(headerBtn), colOps, rowOps, colorGroup, mkGroup(doneBtn));

    const selected = new Set<string>(); // "r,c" of selected origin cells
    const cellEls = new Map<string, HTMLElement>();
    const ncols = grid.reduce((m, row) => Math.max(m, row.length), 0);
    let dragging = false;
    let editing = false; // a cell is in contenteditable text-edit mode (#86)
    let anchor: [number, number] = [0, 0];
    // Whole-column / whole-row selection drives the structural-op group in the toolbar (so
    // "insert before/after" has an unambiguous target). -1 = not a single col/row select.
    let selMode: "cells" | "col" | "row" = "cells";
    let selCol = -1;
    let selRow = -1;
    // #260: the selection's OUTER right/bottom edge (span-aware), so "insert after / below" a MULTI-cell
    // selection lands OUTSIDE the selection instead of in its middle. Single selection → equals selCol/selRow.
    let selColEnd = -1;
    let selRowEnd = -1;

    const applySel = () => {
      // Light fill on every selected cell; a thick accent border ONLY on the selection's
      // OUTER edges (a side whose neighbor isn't selected) — the spreadsheet look (#3).
      for (const [k, el] of cellEls) {
        const sel = selected.has(k);
        el.classList.toggle("cm-lp-cell-sel", sel);
        const [r, c] = k.split(",").map(Number) as [number, number];
        el.classList.toggle("cm-lp-sel-t", sel && !selected.has(`${r - 1},${c}`));
        el.classList.toggle("cm-lp-sel-b", sel && !selected.has(`${r + 1},${c}`));
        el.classList.toggle("cm-lp-sel-l", sel && !selected.has(`${r},${c - 1}`));
        el.classList.toggle("cm-lp-sel-r", sel && !selected.has(`${r},${c + 1}`));
      }
      updateToolbar();
    };
    const setRect = (r1: number, c1: number, r2: number, c2: number) => {
      selected.clear();
      const lr = Math.min(r1, r2), hr = Math.max(r1, r2), lc = Math.min(c1, c2), hc = Math.max(c1, c2);
      for (let r = lr; r <= hr; r++) for (let c = lc; c <= hc; c++) if (grid[r]?.[c]) selected.add(`${r},${c}`);
      // #197 (comment 638): ANY selection targets its top-left cell's column AND row for the structural
      // ops — no need to select a whole column/row. selCol/selRow = the rectangle's left/top edge (so
      // "insert before/after/delete" act on that column/row); both op groups show whenever something is
      // selected. selMode still drives the col/row FILL styling for a full-axis drag.
      const fullH = lr === 0 && hr === grid.length - 1;
      const fullW = lc === 0 && hc === ncols - 1;
      selMode = fullH && lc === hc ? "col" : fullW && lr === hr ? "row" : "cells";
      selCol = lc;
      selRow = lr;
      // #260: outer edges for "insert after / below". Start from the rectangle's right/bottom, then extend
      // past any merged cell that spans beyond it (rowspan/colspan) so the edge is the merge's OUTER side.
      selColEnd = hc;
      selRowEnd = hr;
      for (const k of selected) {
        const [r, c] = k.split(",").map(Number) as [number, number];
        const cell = grid[r]?.[c];
        if (!cell) continue;
        selColEnd = Math.max(selColEnd, c + cell.colspan - 1);
        selRowEnd = Math.max(selRowEnd, r + cell.rowspan - 1);
      }
      applySel();
    };

    // A border drag handle: tracks the pointer, previews the size, commits on release.
    // #154 (revised): a UNIFORM multi-select resize whose DRAGGED EDGE follows the pointer, like a
    // spreadsheet. The `n` affected columns/rows (previewEls = every cell of each) all take the SAME
    // size, chosen so the block's dragged (right/bottom) edge sits exactly at the pointer
    // size = (pointer − blockStart) / n
    // The block's start edge is frozen at drag-start (columns/rows before the block are unaffected, so
    // it never moves). For a single column/row (n=1) this reduces to "that one edge follows the
    // pointer" — the previous single-resize behaviour, unchanged. previewEls == the exact cells the
    // commit writes, so the preview never jumps on release (#146 / ADR-041).
    const dragSize = (e: PointerEvent, axis: "x" | "y", previewEls: HTMLElement[], n: number, commit: (px: number) => void) => {
      const target = e.target as HTMLElement;
      target.setPointerCapture(e.pointerId);
      const startEdge = (el: HTMLElement) => (axis === "x" ? el.getBoundingClientRect().left : el.getBoundingClientRect().top);
      const endEdge = (el: HTMLElement) => (axis === "x" ? el.getBoundingClientRect().right : el.getBoundingClientRect().bottom);
      const blockStart = Math.min(...previewEls.map(startEdge)); // left/top of the leftmost/topmost affected col/row
      const blockSize0 = Math.max(...previewEls.map(endEdge)) - blockStart; // current total size of the affected block
      const min = axis === "x" ? 40 : 24;
      // #5 (x only): the table grows only until it fills the visible width, then STOPS (never steals
      // from neighbouring columns). Cap the block's TOTAL size so the whole table can't exceed the
      // container width (VIEW-FREE — the editor container, not EditorView.scrollDOM).
      const tableEl = previewEls[0]?.closest("table");
      const maxBlock = axis === "x" && tableEl
        ? Math.max(n * min, container.clientWidth - 24 - (tableEl.getBoundingClientRect().width - blockSize0))
        : Infinity;
      const size = (ev: PointerEvent) => uniformResizeSize(axis === "x" ? ev.clientX : ev.clientY, blockStart, n, min, maxBlock);
      // Every cell of every affected column/row takes the uniform size, so the preview == what commit
      // writes (no jump on release), and multi-select columns/rows are equalised.
      const move = (ev: PointerEvent) => {
        const s = size(ev) + "px";
        for (const el of previewEls) { if (axis === "x") el.style.width = s; else el.style.height = s; }
      };
      const up = (ev: PointerEvent) => { target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", up); commit(size(ev)); };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
    };
    const resizeHandle = (cls: string, testid: string, start: (e: PointerEvent) => void) => {
      const h = document.createElement("span");
      h.className = cls;
      h.setAttribute("data-testid", testid);
      h.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); start(e); });
      return h;
    };

    const table = document.createElement("table");
    table.className = "cm-lp-table cm-lp-table-merged cm-lp-table-grid";
    // #216 / ADR-101: the table is focusable so a SELECTED cell can receive keystrokes (Excel "type to
    // overwrite"). tabIndex -1 keeps it out of the tab order; contentEditable=false on the root means CM's
    // focus-delegation guard (ADR-054) won't reclaim focus while a cell edits.
    table.tabIndex = -1;

    // Columns/rows affected by a border drag: if the dragged cell is part of a multi-cell
    // selection, resize ALL selected columns/rows uniformly; otherwise just this one.
    const dragCols = (c: number) => { const sset = new Set(coords().map(([, cc]) => cc)); return selected.has(`${anchor[0]},${c}`) && sset.size > 1 ? [...sset] : [c]; };
    const dragRows = (r: number) => { const sset = new Set(coords().map(([rr]) => rr)); return selected.has(`${r},${anchor[1]}`) && sset.size > 1 ? [...sset] : [r]; };
    // Cells (origin only — handles excluded) of a given column / row, for the live resize preview (#146).
    const colCellsOf = (ci: number) => [...cellEls].filter(([k]) => Number(k.split(",")[1]) === ci).map(([, el]) => el);
    const rowCellsOf = (ri: number) => [...cellEls].filter(([k]) => Number(k.split(",")[0]) === ri).map(([, el]) => el);

    // #197 (comment 638): the always-on A/B/1/2 labels + handles AND the standalone top/bottom "+" bars
    // are all REMOVED — insert/delete for a column OR row is now on the selected cell's op toolbar
    // (any selection targets its cell's col+row), so the extra chrome was redundant.

    // Cell text editing (#86 / #154): double-click a cell to type into it. The cell becomes
    // contenteditable IN PLACE. Focus is handed over via host.beginTextEdit — a plain focus in the
    // MODAL path (no CM), but the CM focus-DELEGATION guard in the in-editor path (#153/ADR-054
    // root contenteditable=false + ignoreEvent means CM won't reclaim the nested island's focus), so
    // the same editor works BOTH in the modal and inline in CodeMirror. Enter commits; Shift+Enter
    // inserts an in-cell <br>; paste is forced to text/plain; blur commits. Every commit rewrites the
    // block via apply (one Y.Text edit) and remounts from the canonical source.
    let editHandle: { end(): void } | null = null;
    // #216 / ADR-101 (comment 787): `overwrite` = the Excel "select a cell then just type" path — the
    // cell's content is REPLACED with the typed text and edit starts (vs double-click / F2 which edits the
    // EXISTING text in place). undefined = edit the current text (double-click path).
    const beginEdit = (el: HTMLElement, r: number, c: number, overwrite?: string) => {
      const cur = grid[r]?.[c];
      if (!cur || editing) return;
      editing = true;
      selected.clear();
      applySel();
      // Drop the resize handles + the " " placeholder; render the cell's real text.
      el.querySelectorAll(".cm-lp-col-resize, .cm-lp-row-resize").forEach((h) => h.remove());
      renderCellInline(el, overwrite !== undefined ? overwrite : cur.text); // #89 (830): WYSIWYG inline marks
      el.contentEditable = "true";
      el.classList.add("cm-lp-cell-editing");
      editHandle = host.beginTextEdit(el); // #154: focus via the host (CM-safe in the inline path)
      // #89 (rescoped): a selection inside the cell shows the inline-decoration toolbar (bold/italic/etc.),
      // the cell-island counterpart of the CM floatingToolbar (which can't reach the contenteditable).
      const fmtBar = mountCellFormatToolbar(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false); // caret at end
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      const finish = (commit: boolean) => {
        if (!editing) return;
        editing = false;
        fmtBar.destroy(); // #89: tear down the cell inline-format toolbar
        el.removeEventListener("blur", onBlur);
        el.removeEventListener("keydown", onKey);
        el.removeEventListener("paste", onPaste);
        editHandle?.end(); // #154: hand focus back (view.focus() inline; no-op in the modal)
        editHandle = null;
        if (!commit) {
          // #266: Esc DISCARDS the typed text and exits cell-edit, staying in the table editor (Excel/
          // Sheets/Notion semantics; a second Esc — via escExit — exits the whole table editor). The grid is
          // unchanged, so apply(grid)→host.replaceSource is a no-op and would leave the cell's contenteditable
          // DOM (holding the discarded text) in place. Restore the cell's display in place and re-select it.
          el.classList.remove("cm-lp-cell-editing");
          el.removeAttribute("contenteditable");
          paintCellDisplay(el, r, c, cur);
          selected.clear(); selected.add(`${r},${c}`); anchor = [r, c]; applySel();
          return;
        }
        const text = stripZeroWidth(cellElToText(el));
        const next: Grid = grid.map((row) => row.map((cl) => (cl ? { ...cl } : null)));
        const target = next[r]?.[c];
        if (target) target.text = text;
        apply(next); // → host.replaceSource → tier demote → remount
      };
      // #89 comment 886 (②): moving focus INTO the cell-link URL popover must NOT commit/exit the cell edit
      // the popover edits THIS cell's selection and returns focus on confirm/cancel. Any other blur commits.
      const onBlur = (e: FocusEvent) => {
        const to = e.relatedTarget as HTMLElement | null;
        if (to && to.closest?.(".cm-lp-cell-link-popover")) return;
        finish(true);
      };
      let plainPaste = false; // #223: Ctrl+Shift+V requests the next paste be plain (skip linkify)
      const onKey = (ev: KeyboardEvent) => {
        ev.stopPropagation(); // keep keystrokes off the table drag/select handlers
        if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && (ev.key === "v" || ev.key === "V")) plainPaste = true;
        if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); finish(true); }
        else if (ev.key === "Enter" && ev.shiftKey) { ev.preventDefault(); insertBrAtCaret(); }
        else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
      };
      const onPaste = (ev: ClipboardEvent) => {
        ev.preventDefault();
        const plain = ev.clipboardData?.getData("text/plain") ?? "";
        // #223: linkify a pasted URL / rich link into Markdown [text](url), inserted as TEXT (text+<br>,
        // ADR-037 — the [](url) is plain text the cell serializer already round-trips, and renderCellInline
        // shows it clickable). Ctrl+Shift+V (plainNext) bypasses. safeHref is the only scheme judgment.
        const md = plainPaste ? null : linkifyPaste({ text: plain, html: ev.clipboardData?.getData("text/html") ?? "", selectedText: window.getSelection()?.toString() ?? "" });
        plainPaste = false;
        // #223 comment 910 (C): a linkify result is a Markdown `[text](url)`. The cell is a WYSIWYG
        // surface, so inserting it as LITERAL text showed the raw `[text](url)` until commit. Render it to a
        // real <a> (renderInlineMarkdownToDom builds an <a class=cm-lp-link> via createElement — never
        // innerHTML) and insert THAT, so the link shows immediately; cellElToText round-trips it back to
        // `[text](url)`. A plain (non-linkified) paste stays verbatim text.
        if (md != null) insertInlineDomAtCaret(renderInlineMarkdownToDom(md));
        else insertTextAtCaret(plain);
      };
      el.addEventListener("blur", onBlur);
      el.addEventListener("keydown", onKey);
      el.addEventListener("paste", onPaste);
    };

    // #266: paint a cell's NON-EDITING display — its inline content (or the placeholder) plus the border
    // resize handles. Used at mount AND to restore a cell after its edit is DISCARDED (Esc): the grid is
    // unchanged then, so a host.replaceSource remount never fires and the cell's contenteditable DOM (with
    // the typed-but-discarded text) would otherwise linger.
    const paintCellDisplay = (el: HTMLElement, r: number, c: number, cell: NonNullable<Grid[number][number]>) => {
      el.replaceChildren();
      if (cell.text) renderCellInline(el, cell.text); else el.textContent = " ";
      el.appendChild(resizeHandle("cm-lp-col-resize", r === 0 ? "table-col-resize-" + c : "", (e) => {
        const cols = dragCols(c); // affected set, fixed at drag start (selection can't change mid-drag)
        dragSize(e, "x", cols.flatMap(colCellsOf), cols.length, (px) => applyColWidths(cols, px + "px"));
      }));
      el.appendChild(resizeHandle("cm-lp-row-resize", c === 0 ? "table-row-resize-" + r : "", (e) => {
        const rows = dragRows(r);
        dragSize(e, "y", rows.flatMap(rowCellsOf), rows.length, (px) => applyRowHeights(rows, px + "px"));
      }));
    };

    grid.forEach((row, r) => {
      const trow = document.createElement("tr");
      // #197: no row-select handle (the 1/2 number column is removed); rows start with data cells.
      row.forEach((cell, c) => {
        if (!cell) return; // covered position
        const el = document.createElement(cell.header ? "th" : "td");
        if (cell.colspan > 1) el.colSpan = cell.colspan;
        if (cell.rowspan > 1) el.rowSpan = cell.rowspan;
        if (cell.style) el.setAttribute("style", styleToCss(cell.style)); // #1: render style live (allowlisted)
        const key = `${r},${c}`;
        el.dataset.cellkey = key;
        cellEls.set(key, el);
        // #89 (857): render the cell's inline markdown (bold/italic/strike/code/link) in the RichUI grid so it
        // matches the non-editing table; plus the border resize handles (#1) — right edge = column width,
        // bottom edge = row height (the interior is for drag-select). Factored so a discarded edit restores
        // the exact same display (#266).
        paintCellDisplay(el, r, c, cell);
        // Rectangular drag-select: pointerdown anchors here; moving extends the rectangle.
        el.addEventListener("pointerdown", (e) => {
          if (editing) return; // a cell is being typed into — let the browser place the caret
          e.preventDefault();
          e.stopPropagation();
          dragging = true;
          anchor = [r, c];
          setRect(r, c, r, c);
          table.focus({ preventScroll: true }); // #216: so a following keystroke lands on the selected cell
          const end = () => { dragging = false; window.removeEventListener("pointerup", end); };
          window.addEventListener("pointerup", end);
        });
        // Double-click → edit the cell's text in place (#86).
        el.addEventListener("dblclick", (e) => { e.preventDefault(); e.stopPropagation(); beginEdit(el, r, c); });
        trow.appendChild(el);
      });
      table.appendChild(trow);
    });
    // #197 (comment 638): the trailing add-row "+" is removed — add/insert a row via the selected
    // cell's row-op toolbar (insert above/below) instead.
    table.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const t = (e.target as HTMLElement)?.closest?.("[data-cellkey]") as HTMLElement | null;
      if (t?.dataset.cellkey) { const [r, c] = t.dataset.cellkey.split(",").map(Number) as [number, number]; setRect(anchor[0], anchor[1], r, c); }
    });
    // #216 / ADR-101 (comment 787): Excel "select then type" — with a cell selected (not yet editing), a
    // single printable keystroke starts editing the ACTIVE cell (anchor) with the typed char, REPLACING its
    // content. Enter/F2 fall through to normal edit-of-existing (below). Modifier combos (Ctrl/Cmd/Alt) are
    // left for shortcuts (Ctrl+Enter = exit to RichUI/host). Nav/whitespace-only keys don't start an edit.
    table.addEventListener("keydown", (e) => {
      if (editing || !selected.size) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return; // shortcuts (e.g. Ctrl+Enter) — not a character
      if (e.key === "Enter" || e.key === "F2") { // Excel F2 / Enter → edit the EXISTING text of the active cell
        e.preventDefault();
        const el = cellEls.get(`${anchor[0]},${anchor[1]}`);
        if (el) beginEdit(el, anchor[0], anchor[1]);
        return;
      }
      if (e.key.length !== 1 || e.key === " ") return; // only a single printable char overwrites (skip nav/space)
      e.preventDefault();
      const el = cellEls.get(`${anchor[0]},${anchor[1]}`);
      if (el) beginEdit(el, anchor[0], anchor[1], e.key); // overwrite the cell with the typed char
    });
    // #223 comment 885: PASTE onto a SELECTED (non-editing) cell. The CM-body pasteLinkify bypasses when a
    // nested island has focus (activeElement = this table, not contentDOM), so without this the paste was
    // dropped at the atom boundary. Capture the paste HERE and start editing the active cell with the
    // (linkified) content — the Excel-style select-then-paste, the paste analogue of select-then-type above.
    // safeHref stays the only scheme judge; the result is inserted as TEXT (text+<br>, ADR-037). Ctrl+Shift+V
    // requests a plain paste (skip linkify).
    let tablePlainPaste = false;
    table.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "v" || e.key === "V")) tablePlainPaste = true;
    }, true);
    table.addEventListener("paste", (e) => {
      if (editing || !selected.size) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const plain = e.clipboardData?.getData("text/plain") ?? "";
      const md = tablePlainPaste ? null : linkifyPaste({ text: plain, html: e.clipboardData?.getData("text/html") ?? "", selectedText: "" });
      tablePlainPaste = false;
      const el = cellEls.get(`${anchor[0]},${anchor[1]}`);
      if (el) beginEdit(el, anchor[0], anchor[1], md ?? plain); // overwrite the active cell with the pasted content
    }, true);

    const apply = (next: Grid) => {
      // Hand the host a LOSSLESS source (the richest :::table form) and let IT pick the level
      // (ADR-025 step 3): the host's tier auto-demotes to a pipe table when the grid is
      // span/style/complex-header free. The editor no longer decides pipe-vs-:::table.
      // STAY in edit mode: host.replaceSource re-points render-active at the rewritten range
      // (per-op LWW; the user exits only via Done/Esc — ADR-022 review #2).
      // #393 / ADR-151: carry the CURRENT source's block-align attribute onto the rewritten fence — a
      // cell edit must never strip `:::table{align=…}` (center stays a bare fence; the host tier keeps
      // the demote rule honest).
      host.replaceSource(asMacroSource(tableFence(tableAlignOf(host.getSource())) + "\n" + toHtml(next) + "\n:::"));
    };
    // Show/position the floating toolbar above the first selected cell; hide when nothing
    // is selected (#1 — contextual, not always-on).
    const updateToolbar = () => {
      if (!selected.size) { bar.style.display = "none"; return; }
      bar.style.display = "flex";
      // #197 (comment 638): both structural-op groups are available for ANY selection — they target the
      // selected cell's column (selCol) and row (selRow), no whole-axis selection required.
      colOps.style.display = "inline-flex";
      rowOps.style.display = "inline-flex";
      const cellEl = cellEls.get([...selected][0]!);
      if (!cellEl) return;
      const wrapRect = container.getBoundingClientRect();
      const cellRect = cellEl.getBoundingClientRect();
      // Place the toolbar ABOVE the first selected cell; if there's no room (it would
      // clip the top / cover the cell), flip BELOW it (#2: never overlap the cell).
      const above = cellRect.top - wrapRect.top - bar.offsetHeight - 6;
      bar.style.top = (above >= 0 ? above : cellRect.bottom - wrapRect.top + 6) + "px";
      // Horizontal: left-align to the cell, but NEVER let the bar clip off the right edge
      // (a rightmost cell would push it off-screen). Clamp the left so the bar stays inside
      // BOTH the editor container and the viewport — so it flips to hug the right edge for a
      // right-side cell instead of overflowing (#2).
      const barW = bar.offsetWidth;
      const containerMax = container.clientWidth - barW - 2; // 2px for the container border
      const viewportMax = window.innerWidth - 4 - barW - wrapRect.left; // bar.left is relative to wrap
      const maxLeft = Math.max(0, Math.min(containerMax, viewportMax));
      bar.style.left = Math.max(0, Math.min(cellRect.left - wrapRect.left, maxLeft)) + "px";
    };
    const coords = () => [...selected].map((s) => s.split(",").map(Number) as [number, number]);
    // Apply a style patch to the selected cells (a key set to undefined clears it). An
    // empty style object becomes undefined so the cell can demote back to a pipe cell.
    const patchStyle = (patch: Partial<CellStyle>) => {
      const cs = coords();
      if (!cs.length) return;
      const next: Grid = grid.map((row) => row.map((c) => (c ? { ...c, style: c.style ? { ...c.style } : undefined } : null)));
      for (const [r, c] of cs) {
        const cell = next[r]?.[c];
        if (!cell) continue;
        const s: CellStyle = { ...(cell.style ?? {}), ...patch };
        (Object.keys(s) as (keyof CellStyle)[]).forEach((k) => s[k] === undefined && delete s[k]);
        cell.style = Object.keys(s).length ? s : undefined;
      }
      apply(next);
    };
    // Set width on each given column's header cell (browsers apply it to the column).
    const applyColWidths = (cols: number[], width: string) => {
      const next: Grid = grid.map((row) => row.map((cell) => (cell ? { ...cell, style: cell.style ? { ...cell.style } : undefined } : null)));
      for (const c of cols) { const head = next[0]?.[c]; if (head) head.style = { ...(head.style ?? {}), width }; }
      apply(next);
    };
    // Set height on each given row's first cell (browsers apply it to the row).
    const applyRowHeights = (rows: number[], height: string) => {
      const next: Grid = grid.map((row) => row.map((cell) => (cell ? { ...cell, style: cell.style ? { ...cell.style } : undefined } : null)));
      for (const r of rows) { const first = (next[r] ?? []).find((cell): cell is NonNullable<typeof cell> => !!cell); if (first) first.style = { ...(first.style ?? {}), height }; }
      apply(next);
    };
    // Toggle the selected cells between header (<th>) and data (<td>). A header in a body
    // row is pipe-inexpressible → promotes; clearing it back demotes.
    headerBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cs = coords();
      if (!cs.length) return;
      const allHeader = cs.every(([r, c]) => grid[r]?.[c]?.header);
      const next: Grid = grid.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
      for (const [r, c] of cs) { const cell = next[r]?.[c]; if (cell) cell.header = !allHeader; }
      apply(next);
    });
    // Structural ops (#1) — operate on the selected column / row (selCol / selRow).
    colInsL.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); if (selCol >= 0) apply(insertColAt(grid, selCol)); });
    colInsR.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); if (selCol >= 0) apply(insertColAt(grid, selColEnd + 1)); }); // #260: after the selection's RIGHT edge
    colDel.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); if (selCol >= 0) apply(deleteColAt(grid, selCol)); });
    rowInsT.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); if (selRow >= 0) apply(insertRowAt(grid, selRow)); });
    rowInsB.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); if (selRow >= 0) apply(insertRowAt(grid, selRowEnd + 1)); }); // #260: below the selection's BOTTOM edge
    rowDel.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); if (selRow >= 0) apply(deleteRowAt(grid, selRow)); });
    alignL.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); patchStyle({ align: "left" }); });
    alignC.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); patchStyle({ align: "center" }); });
    alignR.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); patchStyle({ align: "right" }); });
    mergeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cs = coords();
      if (cs.length < 2) return;
      const rs = cs.map((x) => x[0]);
      const colsS = cs.map((x) => x[1]);
      apply(mergeRect(grid, Math.min(...rs), Math.min(...colsS), Math.max(...rs), Math.max(...colsS)));
    });
    unmergeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cs = coords();
      if (cs.length !== 1) return;
      apply(unmergeAt(grid, cs[0]![0], cs[0]![1]));
    });
    doneBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      host.exit();
    });

    container.append(bar, table);
    return { destroy() { /* no resources beyond the DOM, which the host removes */ } };
  },
};
