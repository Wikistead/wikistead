import type { DirectiveMacro, MacroTier, MacroLevel } from "./registry";
import { asMacroSource } from "./registry";
import { parseHtml, styleToCss, parseTableSource, toHtml, toPipe, representableAsPipe, tableAlignOf, tableFence, type Grid } from "./table-model";
import { renderCellInline } from "./table-cell-dom";
import { tableInlineEditor } from "../live-preview/table-edit";
import { unsafeHtml } from "./safe-html";
import { macroPlaceholder } from "./placeholder"; // #600: one template for every "cannot show it" state
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
  // #600 bounce: the placeholder said "Empty table" in a Japanese UI, because this macro has no slash
  // entry (a table is inserted from the toolbar) and so had no localised name to fall back on. The
  // palette already had one; it is reused rather than a second name being written for the same block.
  nameKey: "palette.table",
  exportFidelity: "preserve", // HTML is standard Markdown; round-trips verbatim
  richEditUI: { present: "inline", editor: tableInlineEditor }, // #154: in-editor WYSIWYG table editing (was #86 modal)
  tier: tableTier, // ADR-025 step 3: host auto-demotes pipe ⟷ :::table
  liveRender: (body) => {
    const el = renderHtmlTable(body);
    el.setAttribute("data-testid", "macro-table");
    // #600: a table with no rows is a <table> with nothing in it — invisible, and indistinguishable
    // from a rendering failure. A caption keeps the element a TABLE (the inline editor mounts over it)
    // while giving the reader the one thing the empty box could not: what this block is.
    if (el.rows.length === 0) {
      const caption = document.createElement("caption");
      caption.className = "cm-lp-macro-empty";
      caption.textContent = macroPlaceholder(tableMacro, "empty-edit");
      el.appendChild(caption);
    }
    return el;
  },
  // The body is already HTML → it round-trips as-is. unsafeHtml marks the ONE place a macro
  // emits verbatim HTML: the server export pipeline (#85) MUST run this through its sanitizer
  // before serving to other users (ADR-045 escape hatch — greppable so that step isn't missed).
  htmlRender: tableHtmlRender,
};
