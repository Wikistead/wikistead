import type { DirectiveMacro } from "./registry";
import { renderMarkdownToDom } from "./md-render";
import { parseDirectiveOpen, isDirectiveClose } from "./directive-parser";

// M2 layout directives (#90, ADR-043 A′): columns / tabs. These need a side-by-side / tab frame
// that CodeMirror line decorations can't provide, so they render as a BLOCK-WIDGET ATOM (the
// table/mermaid model) that lays out its inner :::column / :::tab items, rendering each item's
// Markdown via the sanitized S0 renderer (the widget can't reach CM's renderers). Editing is
// reveal-on-cursor (revealOnCursor: the whole raw block shows while the caret is inside).

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Split a layout directive's body into its inner :::name items. Depth-tracking (push on any
// nested open, pop on a close) so a nested directive INSIDE an item (e.g. a callout in a column)
// doesn't prematurely close the item. Each item keeps its optional [label] + raw content.
export function parseLayoutItems(body: string, name: string): { label?: string; content: string }[] {
  const items: { label?: string; lines: string[] }[] = [];
  let cur: { label?: string; lines: string[] } | null = null;
  let depth = 0;
  for (const line of body.split("\n")) {
    const open = parseDirectiveOpen(line);
    if (open) {
      if (depth === 0) {
        if (open.name === name) { cur = { label: open.label, lines: [] }; items.push(cur); depth = 1; }
        continue; // an open of a different name at top level is ignored (only `name` items count)
      }
      cur!.lines.push(line); depth++; // nested open → part of the current item
      continue;
    }
    if (isDirectiveClose(line, 3)) {
      if (depth === 0) continue;
      depth--;
      if (depth === 0) cur = null; else cur!.lines.push(line); // the item's own close vs a nested close
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  return items.map((i) => ({ label: i.label, content: i.lines.join("\n").replace(/^\n+|\n+$/g, "") }));
}

export const columnsMacro: DirectiveMacro = {
  kind: "directive",
  name: "columns",
  exportFidelity: "preserve", // ::: stays plain text → lossless round-trip
  revealOnCursor: true, // edit via reveal-on-cursor (raw source), not a modal
  slash: {
    labelKey: "palette.columns",
    keywords: "columns layout grid side-by-side",
    insert: "::::columns\n:::column\n\n:::\n:::column\n\n:::\n::::",
    caret: 22, // ":::​:columns\n:::column\n" → the first column's blank body line
  },
  liveRender: (body) => {
    const row = document.createElement("div");
    row.className = "cm-lp-columns";
    row.setAttribute("data-testid", "macro-columns");
    for (const c of parseLayoutItems(body, "column")) {
      const col = document.createElement("div");
      col.className = "cm-lp-column";
      col.appendChild(renderMarkdownToDom(c.content));
      row.appendChild(col);
    }
    return row;
  },
  // M3 export wrapper (inner Markdown rendered server-side; escape as the safe fallback).
  htmlRender: (body) =>
    `<div class="columns">${parseLayoutItems(body, "column")
      .map((c) => `<div class="column">\n\n${escapeHtml(c.content)}\n\n</div>`)
      .join("")}</div>`,
};
