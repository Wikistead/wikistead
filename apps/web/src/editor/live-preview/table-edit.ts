import { mergeRect, unmergeAt, toHtml, styleToCss, insertColAt, insertRowAt, deleteColAt, deleteRowAt, parseTableSource, type Grid, type CellStyle } from "../macros/table-model";
import type { InnerEditHost, InlineEditor, InlineController } from "../macros/registry";
import { asMacroSource } from "../macros/registry";
import { setCellText, cellElToText, insertBrAtCaret, insertTextAtCaret, stripZeroWidth } from "../macros/table-cell-dom";

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
};
function svgBtn(svg: string, testid: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cm-lp-table-edit-btn";
  b.innerHTML = svg; // trusted static icon
  b.title = title;
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
    headerBtn.title = "Toggle header cells";
    const doneBtn = btn("Done", "table-done");
    // Structural ops (#1): insert/delete the selected column or row. Each group is shown
    // only when its kind is selected (via the column/row handle), so before/after is clear.
    const colOps = document.createElement("span");
    colOps.className = "cm-lp-table-ops";
    const colInsL = btn("⊞←", "table-col-insert-before"); colInsL.title = "Insert column before";
    const colInsR = btn("⊞→", "table-col-insert-after"); colInsR.title = "Insert column after";
    const colDel = btn("✕", "table-col-delete"); colDel.title = "Delete column";
    colOps.append(colInsL, colInsR, colDel);
    const rowOps = document.createElement("span");
    rowOps.className = "cm-lp-table-ops";
    const rowInsT = btn("⊞↑", "table-row-insert-above"); rowInsT.title = "Insert row above";
    const rowInsB = btn("⊞↓", "table-row-insert-below"); rowInsB.title = "Insert row below";
    const rowDel = btn("✕", "table-row-delete"); rowDel.title = "Delete row";
    rowOps.append(rowInsT, rowInsB, rowDel);
    bar.append(mergeBtn, unmergeBtn, alignL, alignC, alignR, headerBtn, colOps, rowOps);
    // Background-color presets (ADR-022 review #2): a controlled palette (theme accent +
    // soft tints), NOT a free picker — keeps tables on-theme, accessible, round-trip-safe.
    for (const p of BG_PRESETS) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "cm-lp-table-swatch";
      sw.title = p.title;
      sw.setAttribute("data-testid", "table-bg-" + p.id);
      sw.style.background = p.value ?? "transparent";
      if (!p.value) sw.textContent = "⌀"; // "no fill"
      // #209: set the background AND a contrast-matched text colour so the cell is legible in both themes.
      sw.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); patchStyle({ bg: p.value, color: contrastColor(p.value) }); });
      bar.appendChild(sw);
    }
    bar.appendChild(doneBtn);

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
      // #197: with the spreadsheet select handles removed, DRAG-SELECT now drives the column/row ops. A
      // rectangle spanning EVERY row of a SINGLE column ⇒ that column is selected (insert/delete-column
      // toolbar shows, targeting selCol); every column of a SINGLE row ⇒ that row. Anything else (multi
      // column/row, or a partial block) stays "cells" — colour still applies, single-axis ops hidden.
      const fullH = lr === 0 && hr === grid.length - 1;
      const fullW = lc === 0 && hc === ncols - 1;
      if (fullH && lc === hc) { selMode = "col"; selCol = lc; selRow = -1; }
      else if (fullW && lr === hr) { selMode = "row"; selRow = lr; selCol = -1; }
      else { selMode = "cells"; selCol = -1; selRow = -1; }
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

    // Columns/rows affected by a border drag: if the dragged cell is part of a multi-cell
    // selection, resize ALL selected columns/rows uniformly; otherwise just this one.
    const dragCols = (c: number) => { const sset = new Set(coords().map(([, cc]) => cc)); return selected.has(`${anchor[0]},${c}`) && sset.size > 1 ? [...sset] : [c]; };
    const dragRows = (r: number) => { const sset = new Set(coords().map(([rr]) => rr)); return selected.has(`${r},${anchor[1]}`) && sset.size > 1 ? [...sset] : [r]; };
    // Cells (origin only — handles excluded) of a given column / row, for the live resize preview (#146).
    const colCellsOf = (ci: number) => [...cellEls].filter(([k]) => Number(k.split(",")[1]) === ci).map(([, el]) => el);
    const rowCellsOf = (ri: number) => [...cellEls].filter(([k]) => Number(k.split(",")[0]) === ri).map(([, el]) => el);

    // #197 (approved): the always-on A/B/1/2 spreadsheet labels + select handles are REMOVED — multi
    // column/row selection is done by dragging across cells (unchanged), so the labels/handles were
    // redundant chrome. A single "+" bar remains to add a column at the end (a table-attached affordance).
    const htr = document.createElement("tr");
    const addColCell = document.createElement("th");
    addColCell.className = "cm-lp-table-handle cm-lp-table-addcol";
    addColCell.textContent = "+";
    addColCell.title = "Add a column";
    addColCell.colSpan = ncols; // no row-handle column now → span the data columns
    addColCell.setAttribute("data-testid", "table-add-col");
    addColCell.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); apply(insertColAt(grid, ncols)); });
    htr.appendChild(addColCell);
    table.appendChild(htr);

    // Cell text editing (#86 / #154): double-click a cell to type into it. The cell becomes
    // contenteditable IN PLACE. Focus is handed over via host.beginTextEdit — a plain focus in the
    // MODAL path (no CM), but the CM focus-DELEGATION guard in the in-editor path (#153/ADR-054
    // root contenteditable=false + ignoreEvent means CM won't reclaim the nested island's focus), so
    // the same editor works BOTH in the modal and inline in CodeMirror. Enter commits; Shift+Enter
    // inserts an in-cell <br>; paste is forced to text/plain; blur commits. Every commit rewrites the
    // block via apply (one Y.Text edit) and remounts from the canonical source.
    let editHandle: { end(): void } | null = null;
    const beginEdit = (el: HTMLElement, r: number, c: number) => {
      const cur = grid[r]?.[c];
      if (!cur || editing) return;
      editing = true;
      selected.clear();
      applySel();
      // Drop the resize handles + the " " placeholder; render the cell's real text.
      el.querySelectorAll(".cm-lp-col-resize, .cm-lp-row-resize").forEach((h) => h.remove());
      setCellText(el, cur.text);
      el.contentEditable = "true";
      el.classList.add("cm-lp-cell-editing");
      editHandle = host.beginTextEdit(el); // #154: focus via the host (CM-safe in the inline path)
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false); // caret at end
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      const finish = (commit: boolean) => {
        if (!editing) return;
        editing = false;
        el.removeEventListener("blur", onBlur);
        el.removeEventListener("keydown", onKey);
        el.removeEventListener("paste", onPaste);
        editHandle?.end(); // #154: hand focus back (view.focus() inline; no-op in the modal)
        editHandle = null;
        if (!commit) { apply(grid); return; } // Esc → discard: remount from the current grid
        const text = stripZeroWidth(cellElToText(el));
        const next: Grid = grid.map((row) => row.map((cl) => (cl ? { ...cl } : null)));
        const target = next[r]?.[c];
        if (target) target.text = text;
        apply(next); // → host.replaceSource → tier demote → remount
      };
      const onBlur = () => finish(true);
      const onKey = (ev: KeyboardEvent) => {
        ev.stopPropagation(); // keep keystrokes off the table drag/select handlers
        if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); finish(true); }
        else if (ev.key === "Enter" && ev.shiftKey) { ev.preventDefault(); insertBrAtCaret(); }
        else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
      };
      const onPaste = (ev: ClipboardEvent) => {
        ev.preventDefault();
        insertTextAtCaret(ev.clipboardData?.getData("text/plain") ?? "");
      };
      el.addEventListener("blur", onBlur);
      el.addEventListener("keydown", onKey);
      el.addEventListener("paste", onPaste);
    };

    grid.forEach((row, r) => {
      const trow = document.createElement("tr");
      // #197: no row-select handle (the 1/2 number column is removed); rows start with data cells.
      row.forEach((cell, c) => {
        if (!cell) return; // covered position
        const el = document.createElement(cell.header ? "th" : "td");
        el.textContent = cell.text || " ";
        if (cell.colspan > 1) el.colSpan = cell.colspan;
        if (cell.rowspan > 1) el.rowSpan = cell.rowspan;
        if (cell.style) el.setAttribute("style", styleToCss(cell.style)); // #1: render style live (allowlisted)
        const key = `${r},${c}`;
        el.dataset.cellkey = key;
        cellEls.set(key, el);
        // Resize on the cell BORDERS (#1): right edge = column width, bottom edge = row
        // height. The interior is for drag-select. Border handles stopPropagation so they
        // never start a selection. testid only on the representative cell per col/row.
        el.appendChild(resizeHandle("cm-lp-col-resize", r === 0 ? "table-col-resize-" + c : "", (e) => {
          const cols = dragCols(c); // affected set, fixed at drag start (selection can't change mid-drag)
          dragSize(e, "x", cols.flatMap(colCellsOf), cols.length, (px) => applyColWidths(cols, px + "px"));
        }));
        el.appendChild(resizeHandle("cm-lp-row-resize", c === 0 ? "table-row-resize-" + r : "", (e) => {
          const rows = dragRows(r);
          dragSize(e, "y", rows.flatMap(rowCellsOf), rows.length, (px) => applyRowHeights(rows, px + "px"));
        }));
        // Rectangular drag-select: pointerdown anchors here; moving extends the rectangle.
        el.addEventListener("pointerdown", (e) => {
          if (editing) return; // a cell is being typed into — let the browser place the caret
          e.preventDefault();
          e.stopPropagation();
          dragging = true;
          anchor = [r, c];
          setRect(r, c, r, c);
          const end = () => { dragging = false; window.removeEventListener("pointerup", end); };
          window.addEventListener("pointerup", end);
        });
        // Double-click → edit the cell's text in place (#86).
        el.addEventListener("dblclick", (e) => { e.preventDefault(); e.stopPropagation(); beginEdit(el, r, c); });
        trow.appendChild(el);
      });
      table.appendChild(trow);
    });
    // Trailing "+" attached below the last row: append a row at the end (#3 — table-attached,
    // mirrors the column "+"; replaces the disconnected " Row" bottom button).
    const addRowTr = document.createElement("tr");
    const addRowCell = document.createElement("th");
    addRowCell.className = "cm-lp-table-handle cm-lp-table-addrow";
    addRowCell.textContent = "+";
    addRowCell.title = "Add a row";
    addRowCell.setAttribute("data-testid", "table-add-row");
    addRowCell.colSpan = ncols; // #197: no row-handle column now → span the data columns
    addRowCell.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); apply(insertRowAt(grid, grid.length)); });
    addRowTr.appendChild(addRowCell);
    table.appendChild(addRowTr);
    table.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const t = (e.target as HTMLElement)?.closest?.("[data-cellkey]") as HTMLElement | null;
      if (t?.dataset.cellkey) { const [r, c] = t.dataset.cellkey.split(",").map(Number) as [number, number]; setRect(anchor[0], anchor[1], r, c); }
    });

    const apply = (next: Grid) => {
      // Hand the host a LOSSLESS source (the richest :::table form) and let IT pick the level
      // (ADR-025 step 3): the host's tier auto-demotes to a pipe table when the grid is
      // span/style/complex-header free. The editor no longer decides pipe-vs-:::table.
      // STAY in edit mode: host.replaceSource re-points render-active at the rewritten range
      // (per-op LWW; the user exits only via Done/Esc — ADR-022 review #2).
      host.replaceSource(asMacroSource(":::table\n" + toHtml(next) + "\n:::"));
    };
    // Show/position the floating toolbar above the first selected cell; hide when nothing
    // is selected (#1 — contextual, not always-on).
    const updateToolbar = () => {
      if (!selected.size) { bar.style.display = "none"; return; }
      bar.style.display = "flex";
      // Structural ops only make sense for a whole column / whole row selection.
      colOps.style.display = selMode === "col" ? "inline-flex" : "none";
      rowOps.style.display = selMode === "row" ? "inline-flex" : "none";
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
    colInsR.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); if (selCol >= 0) apply(insertColAt(grid, selCol + 1)); });
    colDel.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); if (selCol >= 0) apply(deleteColAt(grid, selCol)); });
    rowInsT.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); if (selRow >= 0) apply(insertRowAt(grid, selRow)); });
    rowInsB.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); if (selRow >= 0) apply(insertRowAt(grid, selRow + 1)); });
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
