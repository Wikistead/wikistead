import { EditorView, WidgetType } from "@codemirror/view";
import { mergeRect, unmergeAt, serialize, styleToCss, type Grid, type CellStyle } from "../macros/table-model";
import { setMacroRenderActive } from "./macro-edit";

// Render-active table EDIT mode (ADR-022 Part 10/11). Cells select on click; the toolbar
// merges the selected rectangle or un-merges a span. Each op rewrites the block source
// via the grid model and serialize() → pipes (Tier 1) or :::table HTML (Tier 2): that is
// the auto promote/demote. Display-only until the user acts; the rewrite is one
// offset-invariant range edit on the shared Y.Text.
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

export class TableEditWidget extends WidgetType {
  constructor(readonly grid: Grid, readonly from: number, readonly to: number) {
    super();
  }
  eq(o: TableEditWidget) {
    return o.from === this.from && o.to === this.to && JSON.stringify(o.grid) === JSON.stringify(this.grid);
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-table-edit";
    wrap.setAttribute("data-testid", "table-edit");

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
    bar.append(mergeBtn, unmergeBtn, alignL, alignC, alignR, headerBtn);
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
    const ncols = this.grid.reduce((m, row) => Math.max(m, row.length), 0);
    let dragging = false;
    let anchor: [number, number] = [0, 0];

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
      for (let r = lr; r <= hr; r++) for (let c = lc; c <= hc; c++) if (this.grid[r]?.[c]) selected.add(`${r},${c}`);
      applySel();
    };
    const selectCol = (c: number) => { selected.clear(); this.grid.forEach((row, r) => { if (row[c]) selected.add(`${r},${c}`); }); applySel(); };
    const selectRow = (r: number) => { selected.clear(); (this.grid[r] ?? []).forEach((cell, c) => { if (cell) selected.add(`${r},${c}`); }); applySel(); };
    const selectAll = () => { selected.clear(); this.grid.forEach((row, r) => row.forEach((cell, c) => { if (cell) selected.add(`${r},${c}`); })); applySel(); };

    // A border drag handle: tracks the pointer, previews the size, commits on release.
    const dragSize = (e: PointerEvent, axis: "x" | "y", ref: HTMLElement, commit: (px: number) => void) => {
      const target = e.target as HTMLElement;
      const start = axis === "x" ? e.clientX : e.clientY;
      const startSize = axis === "x" ? ref.getBoundingClientRect().width : ref.getBoundingClientRect().height;
      target.setPointerCapture(e.pointerId);
      const size = (ev: PointerEvent) => Math.max(axis === "x" ? 40 : 24, Math.round(startSize + ((axis === "x" ? ev.clientX : ev.clientY) - start)));
      const move = (ev: PointerEvent) => { ref.style[axis === "x" ? "width" : "height"] = size(ev) + "px"; };
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
      ch.setAttribute("data-testid", "table-col-select-" + c);
      ch.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); selectCol(c); });
      htr.appendChild(ch);
    }
    table.appendChild(htr);

    this.grid.forEach((row, r) => {
      const trow = document.createElement("tr");
      const rh = document.createElement("th");
      rh.className = "cm-lp-table-handle cm-lp-table-rowhandle";
      rh.setAttribute("data-testid", "table-row-select-" + r);
      rh.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); selectRow(r); });
      trow.appendChild(rh);
      row.forEach((cell, c) => {
        if (!cell) return; // covered position
        const el = document.createElement(cell.header ? "th" : "td");
        el.textContent = cell.text || " ";
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
      // STAY in edit mode: re-point render-active at the rewritten block's new range
      // (don't clear it). The user exits only via Done/Esc — editing operations never
      // kick them back to reveal (ADR-022 review #2: edit mode persists until exit).
      view.dispatch({ changes: { from: this.from, to: this.to, insert: src }, effects: setMacroRenderActive.of({ from: this.from, to: this.from + src.length }) });
      view.focus();
    };
    // Show/position the floating toolbar above the first selected cell; hide when nothing
    // is selected (#1 — contextual, not always-on).
    const updateToolbar = () => {
      if (!selected.size) { bar.style.display = "none"; return; }
      bar.style.display = "flex";
      const cellEl = cellEls.get([...selected][0]!);
      if (!cellEl) return;
      const wrapRect = wrap.getBoundingClientRect();
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
      const next: Grid = this.grid.map((row) => row.map((c) => (c ? { ...c, style: c.style ? { ...c.style } : undefined } : null)));
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
      const next: Grid = this.grid.map((row) => row.map((cell) => (cell ? { ...cell, style: cell.style ? { ...cell.style } : undefined } : null)));
      for (const c of cols) { const head = next[0]?.[c]; if (head) head.style = { ...(head.style ?? {}), width }; }
      apply(next);
    };
    // Set height on each given row's first cell (browsers apply it to the row).
    const applyRowHeights = (rows: number[], height: string) => {
      const next: Grid = this.grid.map((row) => row.map((cell) => (cell ? { ...cell, style: cell.style ? { ...cell.style } : undefined } : null)));
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
      const allHeader = cs.every(([r, c]) => this.grid[r]?.[c]?.header);
      const next: Grid = this.grid.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
      for (const [r, c] of cs) { const cell = next[r]?.[c]; if (cell) cell.header = !allHeader; }
      apply(next);
    });
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
      apply(mergeRect(this.grid, Math.min(...rs), Math.min(...colsS), Math.max(...rs), Math.max(...colsS)));
    });
    unmergeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cs = coords();
      if (cs.length !== 1) return;
      apply(unmergeAt(this.grid, cs[0]![0], cs[0]![1]));
    });
    doneBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({ effects: setMacroRenderActive.of(null) });
      view.focus();
    });

    wrap.append(bar, table);
    return wrap;
  }
  ignoreEvent() {
    return true; // the widget handles its own events; clicks don't move the caret
  }
}
