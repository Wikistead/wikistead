// #85: the directive parser (DOM-free) moved to the @wikistead/macro-render package so the server-side
// HTML renderer parses `:::` directives from the SAME grammar as the editor (single source of truth,
// ADR-085). This shim re-exports it so the editor's existing `./directive-parser` imports are unchanged.
export { parseDirectiveOpen, isDirectiveClose, directiveExtension, resolveDirectiveRanges, type ResolvedDirective } from "@wikistead/macro-render";
