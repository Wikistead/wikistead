import { EditorView, WidgetType } from "@codemirror/view";
import { mergeRect, unmergeAt, serialize, type Grid, type CellStyle } from "../macros/table-model";
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
    const table = document.createElement("table");
    table.className = "cm-lp-table cm-lp-table-merged";
    this.grid.forEach((row, r) => {
      const tr = document.createElement("tr");
      row.forEach((cell, c) => {
        if (!cell) return; // covered position
        const el = document.createElement(cell.header ? "th" : "td");
        el.textContent = cell.text || " ";
        if (cell.colspan > 1) el.colSpan = cell.colspan;
        if (cell.rowspan > 1) el.rowSpan = cell.rowspan;
        const key = `${r},${c}`;
        el.dataset.cellkey = key;
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (selected.has(key)) { selected.delete(key); el.classList.remove("cm-lp-cell-sel"); }
          else { selected.add(key); el.classList.add("cm-lp-cell-sel"); }
          updateToolbar();
        });
        // Column width: a drag handle on the right edge of the header row's cells.
        if (r === 0) {
          const handle = document.createElement("span");
          handle.className = "cm-lp-col-resize";
          handle.setAttribute("data-testid", "table-col-resize-" + c);
          handle.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const startW = el.getBoundingClientRect().width;
            handle.setPointerCapture(e.pointerId);
            const width = (ev: PointerEvent) => Math.max(40, Math.round(startW + (ev.clientX - startX)));
            const onMove = (ev: PointerEvent) => { el.style.width = width(ev) + "px"; };
            const onUp = (ev: PointerEvent) => {
              handle.removeEventListener("pointermove", onMove);
              handle.removeEventListener("pointerup", onUp);
              applyColWidth(c, width(ev) + "px");
            };
            handle.addEventListener("pointermove", onMove);
            handle.addEventListener("pointerup", onUp);
          });
          el.appendChild(handle);
        }
        tr.appendChild(el);
      });
      table.appendChild(tr);
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
      const cellEl = table.querySelector(`[data-cellkey="${[...selected][0]}"]`) as HTMLElement | null;
      if (!cellEl) return;
      const wrapRect = wrap.getBoundingClientRect();
      const cellRect = cellEl.getBoundingClientRect();
      bar.style.top = Math.max(0, cellRect.top - wrapRect.top - bar.offsetHeight - 4) + "px";
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
    // Set a column's width on its header cell (browsers apply it to the column).
    const applyColWidth = (c: number, width: string) => {
      const next: Grid = this.grid.map((row) => row.map((cell) => (cell ? { ...cell, style: cell.style ? { ...cell.style } : undefined } : null)));
      const head = next[0]?.[c];
      if (head) head.style = { ...(head.style ?? {}), width };
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
