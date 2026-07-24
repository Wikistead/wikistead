import type { DirectiveMacro, MacroTier, MacroLevel } from "./registry";
import { asMacroSource } from "./registry";
import { parseHtml, styleToCss, parseTableSource, toHtml, toPipe, representableAsPipe, tableAlignOf, tableFence, type Grid } from "./table-model";
import { renderCellInline } from "./table-cell-dom";
import { tableInlineEditor } from "../live-preview/table-edit";
import { unsafeHtml } from "./safe-html";
import { tableHtmlRender } from "@wikistead/macro-render"; // #85: export htmlRender is shared, single source

// ADR-025 step 3: the table's tier. pipe (GFM) is the lowest, most portable level;
// :::table HTML (a directive) is the richest. canRepresentAt / toLevel both go through the
// shared grid model, so the host can AUTO-DEMOTE a styled/merged edit back to a plain pipe
// table the moment the richness is gone (open formats). This is the promote/demote rule that
// used to live in the table editor (serialize()), now declared as data the host applies.
const PIPE: MacroLevel = { id: "pipe", layer: "gfm" };
const HTML: MacroLevel = { id: "html", layer: "directive" };

export const tableTier: MacroTier = {
  levels: [PIPE, HTML],
  canRepresentAt(source, level) {
    if (level.id === HTML.id) return true; // HTML can express any grid
    // #393 (+): pipe (pure GFM) cannot carry the align attribute — a centred/right table STAYS
    // :::table (the tier never silently demotes the alignment away). LEFT is the default, so a pipe
    // table already expresses it and nothing is lost.
    return representableAsPipe(parseTableSource(source)) && tableAlignOf(String(source)) === "left";
  },
  toLevel(source, level) {
    const grid = parseTableSource(source);
    const align = tableAlignOf(String(source)); // #393: preserved across re-serialization
    return asMacroSource(level.id === PIPE.id ? toPipe(grid) : tableFence(align) + "\n" + toHtml(grid) + "\n:::");
  },
};

// :::table — the Tier-2 table macro. Body is an HTML <table> (rowspan/colspan), which
// a GFM pipe table promotes to when a merge is added (ADR-022 Part 10). The cell-merge
// mouse UI (promote/demote) lands in the next commit; here is the render + round-trip.

// Build a SANITIZED DOM table from a parsed grid. XSS-safe: cell text is set via DOM nodes
// (textContent + <br>, never innerHTML), and only integer colspan/rowspan are emitted. Shared
// by the read render and the edit-mode render so the two never diverge.
export function gridToTable(grid: Grid): HTMLTableElement {
  const out = document.createElement("table");
  out.className = "cm-lp-table cm-lp-table-merged";
  // #518: group the LEADING all-header rows into a <thead> so the shared sticky-header CSS
  // (`.cm-lp-table thead th { position: sticky; top: 0 }`) pins them exactly as it does for a GFM pipe
  // table (which is emitted with a <thead>). Before this, gridToTable put every <tr> directly under the
  // <table> with no <thead>, so `thead th` never matched a :::table and only the left-column `th:first-child`
  // rule applied — the header had `position: sticky` but `top: auto` (the device trace). Rows from the
  // first non-header row on — including a row-header <th> in a body row's first column — stay in <tbody>
  // (that th sticks LEFT, not top). Display-only: the source HTML is unchanged and round-trips verbatim.
  const isHeaderRow = (row: Grid[number]) => {
    const cells = row.filter(Boolean) as NonNullable<Grid[number][number]>[];
    return cells.length > 0 && cells.every((c) => c.header);
  };
  let inBody = false;
  let thead: HTMLTableSectionElement | null = null;
  let tbody: HTMLTableSectionElement | null = null;
  for (const row of grid) {
    if (!isHeaderRow(row)) inBody = true; // the first non-header row (and everything after) is the body
    const section = !inBody
      ? (thead ??= out.appendChild(document.createElement("thead")))
      : (tbody ??= out.appendChild(document.createElement("tbody")));
    const tr = document.createElement("tr");
    for (const cell of row) {
      if (!cell) continue; // covered position
      const el = document.createElement(cell.header ? "th" : "td");
      renderCellInline(el, cell.text); // #89 (830): inline-mark WYSIWYG (bold/italic/… shown, not literal **)
      if (cell.colspan > 1) el.colSpan = cell.colspan;
      if (cell.rowspan > 1) el.rowSpan = cell.rowspan;
      if (cell.style) el.setAttribute("style", styleToCss(cell.style)); // already allowlisted
      tr.appendChild(el);
    }
    section.appendChild(tr);
  }
  return out;
}

export function renderHtmlTable(html: string): HTMLTableElement {
  return gridToTable(parseHtml(html));
}

// #156 / #152-S4: the table MODAL editor (tableModalEditor) is removed — tables edit IN-EDITOR now
// (richEditUI below, present:"inline"). The modal was #86's original path; #154/#155 replaced it and #156
// deletes the dead fallback. Excalidraw keeps its modal (openMacroModal) as the non-text-macro exception.

export const tableMacro: DirectiveMacro = {
  kind: "directive",
  name: "table",
  exportFidelity: "preserve", // HTML is standard Markdown; round-trips verbatim
  richEditUI: { present: "inline", editor: tableInlineEditor }, // #154: in-editor WYSIWYG table editing (was #86 modal)
  tier: tableTier, // ADR-025 step 3: host auto-demotes pipe ⟷ :::table
  liveRender: (body) => {
    const table = renderHtmlTable(body);
    table.setAttribute("data-testid", "macro-table");
    // #518: put the table in the SAME horizontal-scroll + max-height box a GFM pipe table gets (its
    // TableWidget builds `.cm-lp-table-scroll` itself; md-render's pipe-table `case "table"` does too).
    // Without it a wide :::table stretched `.cm-lp-macro-wrap` → `.cm-content` and scrolled the WHOLE
    // editor sideways (point 2), and a tall one had no vertical scroll box for its sticky <thead>
    // to pin against. The box is the local scroll container: overflow-x gives the table its own
    // horizontal scrollbar and overflow-y + max-height (baseTheme / prose.css) keeps the header pinned.
    const box = document.createElement("div");
    box.className = "cm-lp-table-scroll";
    box.appendChild(table);
    return box;
  },
  // The body is already HTML → it round-trips as-is. unsafeHtml marks the ONE place a macro
  // emits verbatim HTML: the server export pipeline (#85) MUST run this through its sanitizer
  // before serving to other users (ADR-045 escape hatch — greppable so that step isn't missed).
  htmlRender: tableHtmlRender,
};
