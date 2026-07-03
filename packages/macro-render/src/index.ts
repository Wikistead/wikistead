// @wikistead/macro-render — the DOM-free macro export boundary (#85 / ADR-085). Shared by the editor
// (apps/web) and the server so client and server render published/static HTML from a single source of
// truth. DOM-free (tsconfig lib excludes DOM): no `document`/`window`, only strings + the SafeHtml
// XSS boundary. The editor re-exports safe-html / directive-parser from here (zero-churn shims).
export { SafeHtml, html, joinSafe, unsafeHtml, escapeHtml } from "./safe-html.js";
export { parseDirectiveOpen, isDirectiveClose, directiveExtension } from "./directive-parser.js";
export { renderMarkdownToHtml } from "./render.js";
export type { MacroHtmlDescriptor, MacroHtmlRegistry } from "./render.js";
export {
  parseLayoutItems,
  columnsHtmlRender, tabsHtmlRender, detailsHtmlRender,
  CALLOUT_TYPES, calloutHtmlRender,
  tableHtmlRender, transcludeHtmlRender,
  mermaidHtmlRender, plantumlHtmlRender, excalidrawHtmlRender,
  builtinDirectiveDescriptors, builtinFenceDescriptors, builtinMacroRegistry,
} from "./directives.js";
export type { CalloutType } from "./directives.js";
export { parseFenceInfo, parseFenceLine, serializeFenceInfo } from "./fence-info.js";
export type { FenceInfo } from "./fence-info.js";
