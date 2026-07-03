import { parseDirectiveOpen, isDirectiveClose } from "./directive-parser.js";
import { html, joinSafe, type SafeHtml } from "./safe-html.js";
import type { MacroHtmlDescriptor, MacroHtmlRegistry } from "./render.js";

// #85 slice 2 / ADR-085: the DOM-FREE export half of the M2 layout directives (columns / tabs /
// details) lives here — the SINGLE source of truth for their HTML. The editor (apps/web
// layout-directives.ts) composes these htmlRenders with its DOM liveRender; the server export
// (renderMarkdownToHtml) dispatches to them via builtinMacroRegistry(). No double-management.

// Split a layout directive's body into its inner :::name items. Depth-tracking (push on any nested
// open, pop on a close) so a nested directive INSIDE an item (e.g. a callout in a column) doesn't
// prematurely close the item. Each item keeps its optional [label] + raw content. Pure + DOM-free.
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

// columns → each column's content in order (a plain reader stacks them; nothing dropped).
export function columnsHtmlRender(body: string): SafeHtml {
  return html`<div class="columns">${joinSafe(
    parseLayoutItems(body, "column").map((c) => html`<div class="column">\n\n${c.content}\n\n</div>`),
  )}</div>`;
}

// tabs → each tab degrades to a VISIBLE heading (label) + body (#90: meaning-preserving — a non-tab
// reader keeps which content belongs to which tab). Label escaped via html`` (XSS-safe).
export function tabsHtmlRender(body: string): SafeHtml {
  return html`<div class="tabs">${joinSafe(
    parseLayoutItems(body, "tab").map(
      (t, i) => html`<section class="tab"><h3 class="tab-label">${t.label || `Tab ${i + 1}`}</h3>\n\n${t.content}\n\n</section>`,
    ),
  )}</div>`;
}

// details → standard HTML <details> (Markdown-compatible). The [label] summary lives on the fence
// line (not in body), so the server export path (#85 slice 3) will thread it in; generic for now.
export function detailsHtmlRender(body: string): SafeHtml {
  return html`<details><summary>Details</summary>\n\n${body}\n\n</details>`;
}

// Typed callouts (#150 / ADR-049): each admonition type is its own directive (:::note / :::info /
// :::tip / :::warning / :::danger). The type list is the single source of truth here; the editor
// (callout.ts) maps its icons onto it. The export HTML is a per-type wrapper (escaped body).
export const CALLOUT_TYPES = ["note", "info", "tip", "warning", "danger"] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

export function calloutHtmlRender(type: string): (body: string) => SafeHtml {
  return (body) => html`<div class="callout callout-${type}">\n\n${body}\n\n</div>`;
}

// The built-in directive descriptors (name → DOM-free export descriptor). All exportFidelity
// "preserve": the ::: source round-trips losslessly; the htmlRender is the rendered HTML.
export const builtinDirectiveDescriptors: Record<string, MacroHtmlDescriptor> = {
  columns: { exportFidelity: "preserve", htmlRender: columnsHtmlRender },
  tabs: { exportFidelity: "preserve", htmlRender: tabsHtmlRender },
  details: { exportFidelity: "preserve", htmlRender: detailsHtmlRender },
  ...Object.fromEntries(
    CALLOUT_TYPES.map((t) => [t, { exportFidelity: "preserve", htmlRender: calloutHtmlRender(t) } satisfies MacroHtmlDescriptor]),
  ),
};

// A MacroHtmlRegistry over the built-in macros, for the server export renderer. Fence macros
// (mermaid / excalidraw / …) are added in later slices as their htmlRenders are extracted here.
export function builtinMacroRegistry(): MacroHtmlRegistry {
  return {
    fence: () => undefined,
    directive: (name) => builtinDirectiveDescriptors[name],
  };
}
