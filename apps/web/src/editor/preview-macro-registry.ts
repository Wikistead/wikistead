import { builtinMacroRegistry, type MacroHtmlRegistry } from "@wikistead/macro-render";

// #267: the macro registry for CLIENT-side, unsanitized previews (the template picker / templates page).
//
// The server export path renders with builtinMacroRegistry() and THEN passes everything through the single
// XSS trust boundary (sanitizeExportHtml, ADR-059). A client preview renders straight into the DOM via
// dangerouslySetInnerHTML with NO such sanitizer, so it may only use htmlRenders that are safe BY
// CONSTRUCTION — the `html` tagged template escapes every interpolated value. Exactly ONE first-party
// htmlRender breaks that rule: `:::table` (tableHtmlRender = unsafeHtml, TRUSTED passthrough, relying on the
// downstream server sanitizer). Rendering it here would inject a template author's raw HTML — a stored XSS
// vector (e.g. `<img onerror>`) against anyone who previews the template. So `table` is dropped from the
// preview registry (it degrades to safe, escaped source, exactly as before). Rendering tables in the client
// preview would require sharing the server sanitizer client-side — a separate design decision (#267).
export function previewMacroRegistry(): MacroHtmlRegistry {
  const base = builtinMacroRegistry();
  return {
    fence: base.fence, // mermaid/plantuml/excalidraw — all SafeHtml (escaped / static placeholder)
    directive: (name) => (name === "table" ? undefined : base.directive(name)), // exclude the one unsafeHtml macro
  };
}
