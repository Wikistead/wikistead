import type { DirectiveMacro } from "./registry";
import { parseHtml, styleToCss, type Grid } from "./table-model";
import { tableInlineEditor } from "../live-preview/table-edit";

// :::table — the Tier-2 table macro. Body is an HTML <table> (rowspan/colspan), which
// a GFM pipe table promotes to when a merge is added (ADR-022 Part 10). The cell-merge
// mouse UI (promote/demote) lands in the next commit; here is the render + round-trip.

// Build a SANITIZED DOM table from a parsed grid. XSS-safe: cell text is set via
// textContent (never innerHTML), and only integer colspan/rowspan are emitted. Shared
// by the read render and the edit-mode render so the two never diverge.
export function gridToTable(grid: Grid): HTMLTableElement {
  const out = document.createElement("table");
  out.className = "cm-lp-table cm-lp-table-merged";
  for (const row of grid) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      if (!cell) continue; // covered position
      const el = document.createElement(cell.header ? "th" : "td");
      el.textContent = cell.text;
      if (cell.colspan > 1) el.colSpan = cell.colspan;
      if (cell.rowspan > 1) el.rowSpan = cell.rowspan;
      if (cell.style) el.setAttribute("style", styleToCss(cell.style)); // already allowlisted
      tr.appendChild(el);
    }
    out.appendChild(tr);
  }
  return out;
}

export function renderHtmlTable(html: string): HTMLTableElement {
  return gridToTable(parseHtml(html));
}

export const tableMacro: DirectiveMacro = {
  kind: "directive",
  name: "table",
  exportFidelity: "preserve", // HTML is standard Markdown; round-trips verbatim
  richEditUI: { present: "inline", editor: tableInlineEditor }, // ADR-025: the view-free table InlineEditor
  liveRender: (body) => {
    const el = renderHtmlTable(body);
    el.setAttribute("data-testid", "macro-table");
    return el;
  },
  // The body is already HTML → it round-trips as-is. (M3 server export must sanitize
  // before serving to other users.)
  htmlRender: (body) => body,
};
