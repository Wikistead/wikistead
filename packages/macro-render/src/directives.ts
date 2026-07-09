import { parseDirectiveOpen, isDirectiveClose } from "./directive-parser.js";
import { html, joinSafe, unsafeHtml, type SafeHtml } from "./safe-html.js";
import { type MacroHtmlDescriptor, type MacroHtmlRegistry } from "./render.js";

// #85 slice 2 / ADR-085: the DOM-FREE export half of the M2 layout directives (columns / tabs /
// details) lives here — the SINGLE source of truth for their HTML. The editor (apps/web
// layout-directives.ts) composes these htmlRenders with its DOM liveRender; the server export
// (renderMarkdownToHtml) dispatches to them via builtinMacroRegistry(). No double-management.

// Split a layout directive's body into its inner :::name items. Depth-tracking (push on any nested
// open, pop on a close) so a nested directive INSIDE an item (e.g. a callout in a column) doesn't
// prematurely close the item. Each item keeps its optional [label] + raw content. Pure + DOM-free.
// #215 / ADR-100: `contentOffset` is the byte offset WITHIN `body` where the item's (post-trim)
// content begins — the source anchor the editor uses to tag nested-macro DOM (`data-mac-pos`). It is
// derived, not guessed: each item's first content line starts right after its open fence (tracked in
// `firstLineStart`), and the leading blank lines the trim strips map 1:1 to leading "\n" bytes, so
// `firstLineStart + leadingNewlines` is exactly the trimmed content's first byte in `body`. Existing
// callers destructure `{label, content}` and ignore the new field (additive, no behaviour change).
export function parseLayoutItems(body: string, name: string): { label?: string; content: string; contentOffset: number }[] {
  const items: { label?: string; lines: string[]; firstLineStart: number }[] = [];
  let cur: { label?: string; lines: string[]; firstLineStart: number } | null = null;
  let depth = 0;
  let pos = 0; // byte offset of the current line's start in `body`
  for (const line of body.split("\n")) {
    pos += line.length + 1; // advance to the NEXT line's start (past this line + its "\n")
    const open = parseDirectiveOpen(line);
    if (open) {
      if (depth === 0) {
        if (open.name === name) { cur = { label: open.label, lines: [], firstLineStart: pos }; items.push(cur); depth = 1; }
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
  return items.map((i) => {
    const joined = i.lines.join("\n");
    const leading = joined.length - joined.replace(/^\n+/, "").length; // leading blank lines the trim removes
    return { label: i.label, content: joined.replace(/^\n+|\n+$/g, ""), contentOffset: i.firstLineStart + leading };
  });
}

// #85: `renderInner` recursively renders a nested Markdown body to HTML (SafeHtml). When absent (a caller
// that hasn't wired it) we fall back to the raw content (escaped by html``) — backward compatible.
type Inner = ((md: string) => SafeHtml) | undefined;
const inner = (content: string, renderInner: Inner): SafeHtml | string => (renderInner ? renderInner(content) : content);

// columns → each column's content in order (a plain reader stacks them; nothing dropped). #85: the column
// body is rendered recursively so a nested table / list / directive becomes real HTML, not flattened text.
export function columnsHtmlRender(body: string, renderInner?: (md: string) => SafeHtml): SafeHtml {
  return html`<div class="columns">${joinSafe(
    parseLayoutItems(body, "column").map((c) => html`<div class="column">\n\n${inner(c.content, renderInner)}\n\n</div>`),
  )}</div>`;
}

// tabs → each tab degrades to a VISIBLE heading (label) + body (#90: meaning-preserving — a non-tab
// reader keeps which content belongs to which tab). Label escaped via html`` (XSS-safe). #85: body recurses.
export function tabsHtmlRender(body: string, renderInner?: (md: string) => SafeHtml): SafeHtml {
  return html`<div class="tabs">${joinSafe(
    parseLayoutItems(body, "tab").map(
      (t, i) => html`<section class="tab"><h3 class="tab-label">${t.label || `Tab ${i + 1}`}</h3>\n\n${inner(t.content, renderInner)}\n\n</section>`,
    ),
  )}</div>`;
}

// details → standard HTML <details> (Markdown-compatible). The [label] summary lives on the fence
// line (not in body), so the server export path (#85 slice 3) will thread it in; generic for now. #85: recurse.
export function detailsHtmlRender(body: string, renderInner?: (md: string) => SafeHtml): SafeHtml {
  return html`<details><summary>Details</summary>\n\n${inner(body, renderInner)}\n\n</details>`;
}

// Typed callouts (#150 / ADR-049): each admonition type is its own directive (:::note / :::info /
// :::tip / :::warning / :::danger). The type list is the single source of truth here; the editor
// (callout.ts) maps its icons onto it. The export HTML is a per-type wrapper (escaped body).
export const CALLOUT_TYPES = ["note", "info", "tip", "warning", "danger"] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

export function calloutHtmlRender(type: string): (body: string, renderInner?: (md: string) => SafeHtml) => SafeHtml {
  return (body, renderInner) => html`<div class="callout callout-${type}">\n\n${inner(body, renderInner)}\n\n</div>`; // #85: recurse
}

// #290 / ADR-114: :::todo — the promoted form of a GFM task list. The static export is the task list wrapped
// in a container (the progress ring is display-only, per ADR-114, so it is NOT exported). Body is escaped.
export function todoHtmlRender(body: string, renderInner?: (md: string) => SafeHtml): SafeHtml { return html`<div class="todo">\n\n${inner(body, renderInner)}\n\n</div>`; } // #85: recurse the task list

// :::table body is TRUSTED HTML (ADR: the table macro emits HTML verbatim). unsafeHtml keeps parity
// with the editor; the server export path (#85 slice 3) runs a sanitize allowlist over the result — the
// final fortress that neutralises any raw <iframe>/<script> a cell's text might contain.
// #89 (rescoped, 2026-07-05): cells are inline text only. The block-cell reparse path (data-block →
// renderMarkdownToHtml) was removed with the block-content feature — cell text is emitted verbatim (already
// entity-escaped by cellTextToHtml) and the downstream #85 sanitizer stays the authoritative XSS boundary.
export function tableHtmlRender(body: string): SafeHtml {
  return unsafeHtml(body);
}
// :::embed-page → a placeholder the export can later resolve to the referenced page (data-page).
// (#205: syntax renamed from `:::transclude`; the function keeps its name to limit churn.)
export function transcludeHtmlRender(body: string): SafeHtml { return html`<div class="embed-page" data-page="${body.trim()}"></div>`; }
// :::embed → in exported/static HTML an external embed DEGRADES to a link (the sanitizer forbids
// <iframe>; the client renders the sandboxed iframe live). Only http(s) becomes a link; anything else
// renders as inert text so a javascript:/data: scheme can't smuggle a link (the final sanitizer also
// strips it). html`` escapes the URL in both attribute and text position.
export function embedHtmlRender(body: string): SafeHtml {
  const url = body.trim();
  if (/^https?:\/\//i.test(url)) return html`<a class="embed-link" href="${url}" rel="noopener noreferrer nofollow" target="_blank">${url}</a>`;
  return html`<span class="embed-link">${url}</span>`;
}

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
  todo: { exportFidelity: "preserve", htmlRender: todoHtmlRender }, // #290

  table: { exportFidelity: "preserve", htmlRender: tableHtmlRender },
  "embed-page": { exportFidelity: "preserve", htmlRender: transcludeHtmlRender }, // #205: renamed from `transclude`
  "embed-external": { exportFidelity: "degrade", htmlRender: embedHtmlRender }, // #205: renamed from `embed`
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
