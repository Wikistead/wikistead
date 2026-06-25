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

    const bar = document.createElement("div");
    bar.className = "cm-lp-table-edit-bar";
    const mergeBtn = btn("Merge", "table-merge");
    const unmergeBtn = btn("Unmerge", "table-unmerge");
    const alignL = btn("⌫", "table-align-left");
    const alignC = btn("≡", "table-align-center");
    const alignR = btn("⌦", "table-align-right");
    alignL.title = "Align left"; alignC.title = "Align center"; alignR.title = "Align right";
    const doneBtn = btn("Done", "table-done");
    bar.append(mergeBtn, unmergeBtn, alignL, alignC, alignR);
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
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (selected.has(key)) { selected.delete(key); el.classList.remove("cm-lp-cell-sel"); }
          else { selected.add(key); el.classList.add("cm-lp-cell-sel"); }
        });
        tr.appendChild(el);
      });
      table.appendChild(tr);
    });

    const apply = (next: Grid) => {
      const { tier, text } = serialize(next);
      const src = tier === "html" ? ":::table\n" + text + "\n:::" : text;
      view.dispatch({ changes: { from: this.from, to: this.to, insert: src }, effects: setMacroRenderActive.of(null) });
      view.focus();
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
