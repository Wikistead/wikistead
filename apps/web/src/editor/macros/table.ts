import type { DirectiveMacro, MacroTier, MacroLevel } from "./registry";
import { asMacroSource } from "./registry";
import { parseHtml, styleToCss, parseTableSource, toHtml, toPipe, representableAsPipe, type Grid } from "./table-model";
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
    return representableAsPipe(parseTableSource(source)); // pipe only if span/style/complex-header free
  },
  toLevel(source, level) {
    const grid = parseTableSource(source);
    return asMacroSource(level.id === PIPE.id ? toPipe(grid) : ":::table\n" + toHtml(grid) + "\n:::");
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
  for (const row of grid) {
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
    out.appendChild(tr);
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
    const el = renderHtmlTable(body);
    el.setAttribute("data-testid", "macro-table");
    return el;
  },
  // The body is already HTML → it round-trips as-is. unsafeHtml marks the ONE place a macro
  // emits verbatim HTML: the server export pipeline (#85) MUST run this through its sanitizer
  // before serving to other users (ADR-045 escape hatch — greppable so that step isn't missed).
  htmlRender: tableHtmlRender,
};
