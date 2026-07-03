import { parseDirectiveOpen, isDirectiveClose } from "./directive-parser.js";
import { html, joinSafe, unsafeHtml, type SafeHtml } from "./safe-html.js";
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

// :::table body is TRUSTED HTML (ADR: the table macro emits HTML verbatim). unsafeHtml keeps parity
// with the editor; the server export path (#85 slice 3) runs a sanitize allowlist over the result.
export function tableHtmlRender(body: string): SafeHtml { return unsafeHtml(body); }
// :::transclude → a placeholder the export can later resolve to the referenced page (data-page).
export function transcludeHtmlRender(body: string): SafeHtml { return html`<div class="transclude" data-page="${body.trim()}"></div>`; }

// Fence (data-block) macros: a declarative text body rendered by client JS in the app view. In a
// static export the <pre> is the source (mermaid.js / plantuml render it where available).
export function mermaidHtmlRender(body: string): SafeHtml { return html`<pre class="mermaid">${body}</pre>`; }
export function plantumlHtmlRender(body: string): SafeHtml { return html`<pre class="plantuml">${body}</pre>`; }
export function excalidrawHtmlRender(): SafeHtml { return html`<div class="excalidraw-drawing">[Excalidraw drawing]</div>`; }

// The built-in directive descriptors (name → DOM-free export descriptor). exportFidelity mirrors each
// macro's contract in the editor (kept in lockstep — the value is the macro's, not the renderer's).
export const builtinDirectiveDescriptors: Record<string, MacroHtmlDescriptor> = {
  columns: { exportFidelity: "preserve", htmlRender: columnsHtmlRender },
  tabs: { exportFidelity: "preserve", htmlRender: tabsHtmlRender },
  details: { exportFidelity: "preserve", htmlRender: detailsHtmlRender },
  table: { exportFidelity: "preserve", htmlRender: tableHtmlRender },
  transclude: { exportFidelity: "preserve", htmlRender: transcludeHtmlRender },
  ...Object.fromEntries(
    CALLOUT_TYPES.map((t) => [t, { exportFidelity: "preserve", htmlRender: calloutHtmlRender(t) } satisfies MacroHtmlDescriptor]),
  ),
};

// The built-in fence descriptors (info-string language → descriptor).
export const builtinFenceDescriptors: Record<string, MacroHtmlDescriptor> = {
  mermaid: { exportFidelity: "preserve", htmlRender: mermaidHtmlRender },
  plantuml: { exportFidelity: "degrade", htmlRender: plantumlHtmlRender },
  excalidraw: { exportFidelity: "preserve", htmlRender: excalidrawHtmlRender },
};

// A MacroHtmlRegistry over ALL built-in macros, for the server export renderer.
export function builtinMacroRegistry(): MacroHtmlRegistry {
  return {
    fence: (lang) => builtinFenceDescriptors[lang],
    directive: (name) => builtinDirectiveDescriptors[name],
  };
}
