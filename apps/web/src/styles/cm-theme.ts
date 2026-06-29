import { EditorView } from "@codemirror/view";

// CSS-variable-driven CodeMirror theme (Phase 3a). Every color resolves from the
// app's design tokens, so switching light/dark recolors the editor WITHOUT building
// a new EditorView — the collab connection / awareness presence is never rebuilt
// (ADR-013). Added to every surface (source, live-preview, published view).
//
// Scope is the editor chrome (background, text, caret, selection, gutters); syntax
// highlight token colors come from the language highlightStyle and are left as-is.
export const cmTheme = EditorView.theme({
  "&": { color: "var(--fg)", backgroundColor: "var(--bg)" },
  // #158-C1: the editor body uses the strict-monospace stack (UDEV Gothic lead → vim columns stay
  // exact; full-width = 2× half-width). Falls back to ui-monospace until the woff2 is vendored.
  ".cm-content": { caretColor: "var(--fg)", fontFamily: "var(--font-mono)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--selection)",
  },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--fg-dim)", border: "none" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--fg) 6%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--panel-2)" },
  ".cm-lineNumbers .cm-gutterElement": { color: "var(--fg-dim)" },
});
