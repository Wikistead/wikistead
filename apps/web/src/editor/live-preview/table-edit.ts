import { mergeRect, unmergeAt, serialize, styleToCss, insertColAt, insertRowAt, deleteColAt, deleteRowAt, parseTableSource, type Grid, type CellStyle } from "../macros/table-model";
import type { InnerEditHost, InlineEditor, InlineController } from "../macros/registry";

// Spreadsheet-style column label: A, B … Z, AA, AB … (so the handle band reads like a
// spreadsheet header — unmistakably NOT a data cell, #2).
function colLabel(n: number): string {
  let s = "";
  for (let i = n; i >= 0; i = Math.floor(i / 26) - 1) s = String.fromCharCode(65 + (i % 26)) + s;
  return s;
}

// ADR-025 step 2: the table's INLINE rich-editor — VIEW-FREE. It mounts its DOM into
// `container` and talks ONLY to InnerEditHost (theme/getSource/replaceSource/exit); it never
// touches the EditorView/Yjs (a host-layer bridge widget wires it in). Cells select on click;
// the toolbar merges/unmerges/aligns/colours/sizes/header-toggles/insert-deletes. Each op
// rewrites the block source via the grid model + serialize → pipes (Tier 1) or :::table
// HTML (Tier 2) — the auto promote/demote — committed via host.replaceSource (one
// offset-invariant Y.Text edit, per-op). The grid is parsed from host.getSource at mount.
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
      sw.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); patchStyle({ bg: p.value }); });
      bar.appendChild(sw);
    }
    bar.appendChild(doneBtn);

    const selected = new Set<string>(); // "r,c" of selected origin cells
    const cellEls = new Map<string, HTMLElement>();
    const ncols = grid.reduce((m, row) => Math.max(m, row.length), 0);
    let dragging = false;
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
      selMode = "cells"; selCol = -1; selRow = -1;
      const lr = Math.min(r1, r2), hr = Math.max(r1, r2), lc = Math.min(c1, c2), hc = Math.max(c1, c2);
      for (let r = lr; r <= hr; r++) for (let c = lc; c <= hc; c++) if (grid[r]?.[c]) selected.add(`${r},${c}`);
      applySel();
    };
    const selectCol = (c: number) => { selected.clear(); selMode = "col"; selCol = c; selRow = -1; grid.forEach((row, r) => { if (row[c]) selected.add(`${r},${c}`); }); applySel(); };
    const selectRow = (r: number) => { selected.clear(); selMode = "row"; selRow = r; selCol = -1; (grid[r] ?? []).forEach((cell, c) => { if (cell) selected.add(`${r},${c}`); }); applySel(); };
    const selectAll = () => { selected.clear(); selMode = "cells"; selCol = -1; selRow = -1; grid.forEach((row, r) => row.forEach((cell, c) => { if (cell) selected.add(`${r},${c}`); })); applySel(); };

    // A border drag handle: tracks the pointer, previews the size, commits on release.
    const dragSize = (e: PointerEvent, axis: "x" | "y", ref: HTMLElement, commit: (px: number) => void) => {
      const target = e.target as HTMLElement;
      const start = axis === "x" ? e.clientX : e.clientY;
      const startSize = axis === "x" ? ref.getBoundingClientRect().width : ref.getBoundingClientRect().height;
      target.setPointerCapture(e.pointerId);
      // #5: a column grows only until the TABLE fills the visible width, then it STOPS — it
      // never steals width from the neighbouring columns. The visible width is the editor
      // container's width (VIEW-FREE — no EditorView.scrollDOM).
      const tableEl = ref.closest("table");
      const slackX = tableEl ? Math.max(0, container.clientWidth - 24 - tableEl.getBoundingClientRect().width) : 0;
      const maxW = startSize + slackX;
      // #4: shrinking a row only follows live if EVERY cell in the row follows — one cell
      // can't pull the row shorter than its siblings. Apply the live height to all of them.
      const rowCells = axis === "y" ? (Array.from(ref.closest("tr")?.children ?? []) as HTMLElement[]) : [];
      const size = (ev: PointerEvent) => {
        const raw = Math.round(startSize + ((axis === "x" ? ev.clientX : ev.clientY) - start));
        return axis === "x" ? Math.min(maxW, Math.max(40, raw)) : Math.max(24, raw);
      };
      const move = (ev: PointerEvent) => {
        const s = size(ev);
        if (axis === "x") ref.style.width = s + "px";
        else for (const c of rowCells) c.style.height = s + "px";
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

    // Spreadsheet handle band: corner (select all) + a select handle per column.
    const htr = document.createElement("tr");
    const corner = document.createElement("th");
    corner.className = "cm-lp-table-handle cm-lp-table-corner";
    corner.setAttribute("data-testid", "table-select-all");
    corner.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); selectAll(); });
    htr.appendChild(corner);
    for (let c = 0; c < ncols; c++) {
      const ch = document.createElement("th");
      ch.className = "cm-lp-table-handle cm-lp-table-colhandle";
      ch.textContent = colLabel(c); // spreadsheet column letter (#2 — reads as a header)
      ch.setAttribute("data-testid", "table-col-select-" + c);
      ch.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); selectCol(c); });
      htr.appendChild(ch);
    }
    table.appendChild(htr);

    grid.forEach((row, r) => {
      const trow = document.createElement("tr");
      const rh = document.createElement("th");
      rh.className = "cm-lp-table-handle cm-lp-table-rowhandle";
      rh.textContent = String(r + 1); // spreadsheet row number (#2 — reads as a header)
      rh.setAttribute("data-testid", "table-row-select-" + r);
      rh.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); selectRow(r); });
      trow.appendChild(rh);
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
        el.appendChild(resizeHandle("cm-lp-col-resize", r === 0 ? "table-col-resize-" + c : "", (e) => dragSize(e, "x", el, (px) => applyColWidths(dragCols(c), px + "px"))));
        el.appendChild(resizeHandle("cm-lp-row-resize", c === 0 ? "table-row-resize-" + r : "", (e) => dragSize(e, "y", el, (px) => applyRowHeights(dragRows(r), px + "px"))));
        // Rectangular drag-select: pointerdown anchors here; moving extends the rectangle.
        el.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          dragging = true;
          anchor = [r, c];
          setRect(r, c, r, c);
          const end = () => { dragging = false; window.removeEventListener("pointerup", end); };
          window.addEventListener("pointerup", end);
        });
        trow.appendChild(el);
      });
      table.appendChild(trow);
    });
    table.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const t = (e.target as HTMLElement)?.closest?.("[data-cellkey]") as HTMLElement | null;
      if (t?.dataset.cellkey) { const [r, c] = t.dataset.cellkey.split(",").map(Number) as [number, number]; setRect(anchor[0], anchor[1], r, c); }
    });

    const apply = (next: Grid) => {
      const { tier, text } = serialize(next);
      const src = tier === "html" ? ":::table\n" + text + "\n:::" : text;
      // STAY in edit mode: host.replaceSource re-points render-active at the rewritten range
      // (per-op LWW; the user exits only via Done/Esc — ADR-022 review #2).
      host.replaceSource(src);
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
      bar.style.left = Math.max(0, cellRect.left - wrapRect.left) + "px";
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

    // Persistent, ALWAYS-VISIBLE action bar (#1). The earlier add affordance was a 10px
    // "+" cell in the handle band — easy to miss and scrolled off-screen on wide tables.
    // This labeled bar sits below the table, left-aligned (never clipped by table width),
    // and is visible the whole time you're in edit mode — no selection required.
    const actions = document.createElement("div");
    actions.className = "cm-lp-table-actions";
    const addColBtn = btn("＋ Column", "table-add-col");
    addColBtn.title = "Add a column on the right";
    addColBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); apply(insertColAt(grid, ncols)); });
    const addRowBtn = btn("＋ Row", "table-add-row");
    addRowBtn.title = "Add a row at the bottom";
    addRowBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); apply(insertRowAt(grid, grid.length)); });
    const hint = document.createElement("span");
    hint.className = "cm-lp-table-actions-hint";
    hint.textContent = "Click a row/column header (1/A) to insert beside or delete it";
    actions.append(addColBtn, addRowBtn, hint);

    container.append(bar, table, actions);
    return { destroy() { /* no resources beyond the DOM, which the host removes */ } };
  },
};
