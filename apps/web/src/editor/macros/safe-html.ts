// #85: SafeHtml moved to the DOM-free @wikistead/macro-render package so the SERVER can consume the
// same XSS boundary when rendering published/static HTML (single source of truth, ADR-085). This shim
// re-exports it so the editor's existing `./safe-html` imports are unchanged.
export { SafeHtml, html, joinSafe, unsafeHtml, escapeHtml } from "@wikistead/macro-render";
