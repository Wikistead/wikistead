// @wikistead/macro-render — the DOM-free macro export boundary (#85 / ADR-085). Shared by the editor
// (apps/web) and the server so client and server render published/static HTML from a single source of
// truth. DOM-free (tsconfig lib excludes DOM): no `document`/`window`, only strings + the SafeHtml
// XSS boundary. The editor re-exports safe-html / directive-parser from here (zero-churn shims).
export { SafeHtml, html, joinSafe, unsafeHtml, escapeHtml } from "./safe-html.js";
export { safeHref } from "./url-safety.js"; // #384: the single URL-scheme XSS judge for both markdown sinks
export { HEADINGS, footnoteRefLabel } from "./md-nodes.js"; // #384: shared heading-tag map + footnote-label extractor
export { parseDirectiveOpen, isDirectiveClose, directiveExtension, resolveDirectiveRanges, type ResolvedDirective } from "./directive-parser.js";
export { highlightExtension } from "./highlight-ext.js"; // #334 / ADR-129: shared `==` → <mark> grammar
export { footnoteExtension } from "./footnote-ext.js"; // #335 / ADR-130: shared `[^1]` / `[^1]:` grammar
export { renderMarkdownToHtml, mdParser } from "./render.js";
export type { MacroHtmlDescriptor, MacroHtmlRegistry } from "./render.js";
// #384 / ADR-160: the ONE markdown tree-walk; the DOM sink (apps/web md-render.ts) and the SafeHtml sink
// (render.ts) are the two consumers.
export { walkMarkdown, walkInlineMarkdown } from "./md-visitor.js";
export type { MdSink, MdOpenRole, MdLeafRole, MdRoleData } from "./md-visitor.js";
export { slugify, extractHeadingsFromMarkdown, sliceSectionBySlug, sliceBlockByAnchor } from "./headings.js"; // #325 / ADR-137: shared slug + section/block extractor
export type { MdHeading } from "./headings.js";
export {
  parseLayoutItems,
  columnsHtmlRender, tabsHtmlRender, detailsHtmlRender,
  CALLOUT_TYPES, calloutHtmlRender, todoHtmlRender,
  tableHtmlRender, transcludeHtmlRender, embedHtmlRender,
  mermaidHtmlRender, plantumlHtmlRender, excalidrawHtmlRender,
  builtinDirectiveDescriptors, builtinFenceDescriptors, builtinMacroRegistry,
} from "./directives.js";
export type { CalloutType } from "./directives.js";
export { parseFenceInfo, parseFenceLine, serializeFenceInfo } from "./fence-info.js";
export type { FenceInfo, FenceAlign } from "./fence-info.js";
