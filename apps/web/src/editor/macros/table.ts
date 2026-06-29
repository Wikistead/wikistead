import type { DirectiveMacro, MacroTier, MacroLevel, MacroModalEditor, InnerEditHost, InlineController } from "./registry";
import { parseHtml, styleToCss, parseTableSource, toHtml, toPipe, representableAsPipe, type Grid } from "./table-model";
import { setCellText } from "./table-cell-dom";
import { tableInlineEditor } from "../live-preview/table-edit";

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
    return level.id === PIPE.id ? toPipe(grid) : ":::table\n" + toHtml(grid) + "\n:::";
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
      setCellText(el, cell.text);
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

// The table's MODAL editor (#86 / ADR-036): mounts the existing view-free tableInlineEditor in
// the modal overlay (OUTSIDE CodeMirror), so a cell can be contenteditable without CM stealing
// focus. openTableModal passes the table block's FULL current source (pipe table OR :::table);
// the editor parses both. A toolbar op (merge/style/…) calls replaceSource → we re-render so the
// modal reflects it; getBody returns the current source (openTableModal applies the tier on save,
// demoting a span/style-free table back to a plain pipe table — open formats).
export const tableModalEditor: MacroModalEditor = {
  async mount(container, body, ctx) {
    let current = body;
    let ctrl: InlineController | null = null;
    const render = () => {
      ctrl?.destroy();
      container.replaceChildren();
      ctrl = tableInlineEditor.mount(container, host);
      // The modal frame owns Save/Cancel, so the editor's in-toolbar "Done" (host.exit, a
      // no-op here) is redundant — drop it to avoid a dead button (#86).
      container.querySelector('[data-testid="table-done"]')?.remove();
    };
    const host: InnerEditHost = {
      theme: ctx.theme,
      getSource: () => current,
      replaceSource: (next) => { current = next; render(); },
      exit: () => { /* the modal frame owns close/save */ },
      // #153 / ADR-054: in the MODAL path there is no EditorView to fight for focus, so this is a
      // plain focus hand-off (the modal frame owns focus). The CM-host bridge (macro-edit.ts) is
      // where the focus-guard semantics matter; the in-editor WYSIWYG cell path (#154) uses that.
      beginTextEdit: (target: HTMLElement) => { target.focus(); return { end: () => {} }; },
    };
    render();
    return { getBody: () => current, destroy: () => ctrl?.destroy() };
  },
};

export const tableMacro: DirectiveMacro = {
  kind: "directive",
  name: "table",
  exportFidelity: "preserve", // HTML is standard Markdown; round-trips verbatim
  richEditUI: { present: "modal", editor: tableModalEditor }, // #86: whole-table editing in a modal (outside CM)
  tier: tableTier, // ADR-025 step 3: host auto-demotes pipe ⟷ :::table
  liveRender: (body) => {
    const el = renderHtmlTable(body);
    el.setAttribute("data-testid", "macro-table");
    return el;
  },
  // The body is already HTML → it round-trips as-is. (M3 server export must sanitize
  // before serving to other users.)
  htmlRender: (body) => body,
};
