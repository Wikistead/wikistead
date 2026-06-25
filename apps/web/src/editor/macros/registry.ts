// Macro registry — the platform extension point (ADR-022 / ADR-023).
//
// A macro turns a piece of canonical Markdown source (a language-tagged code fence
// in M1; a ::: directive in slice 2) into a rich rendering, while the source stays
// plain text in the single Y.Text. One registration carries every surface a macro
// needs, so the surfaces cannot drift (ADR-022 Part 4).
//
// TRUST BOUNDARY (ADR-023). A macro's render functions receive only `MacroContext`
// — deliberately tiny: enough to render from the macro's OWN source text, and
// NOTHING else. No EditorView/EditorState, no Yjs doc, no auth/session, no DB/FGA/
// storage. M1/M2 ship first-party macros only, but they are written against this
// same narrow API, so opening the registry to user macros later (Stage 2: sandbox)
// is *enforcing* a boundary first-party code already respects — not redrawing it.

export type MacroTheme = "light" | "dark";

// The entire host surface a macro may touch. Keep this minimal — every field added
// here widens the eventual sandbox's attack surface.
export interface MacroContext {
  readonly theme: MacroTheme;
}

export interface FenceMacro {
  readonly kind: "fence";
  // The fenced-code info string this macro claims, e.g. "mermaid" (```mermaid …).
  readonly lang: string;
  // Live (editor/published) render: build DOM from the fence body. May fill itself
  // in asynchronously INTO the returned element (like the image widget), but returns
  // synchronously so the CodeMirror widget stays sync. Returns display DOM only.
  liveRender(body: string, ctx: MacroContext): HTMLElement;
  // Static HTML for export / SSR (wired server-side in M3). Defined now so the
  // contract is complete. MUST be XSS-safe (escape/sanitize its own output).
  htmlRender(body: string): string;
  // One-line label for the folded summary ("▶ <summary>").
  summary(body: string): string;
  // REQUIRED on every macro (ADR-022 — degradation is never silent). "preserve" =
  // the source round-trips verbatim in Markdown (a code fence always does);
  // "degrade" = lossy, export emits a placeholder + warning (M3).
  readonly exportFidelity: "preserve" | "degrade";
  // M2: mouse rich-edit surface (modal for embedded React editors — keeps React out
  // of CodeMirror, ADR-013). Slot only in M1.
  readonly richEditUI?: { readonly present: "modal" | "inline" };
}

// Directive macros (kind: "directive") arrive in M1 slice 2 with the in-house lezer
// ::: parser. The union is ready for them.
export type Macro = FenceMacro;

const FENCE_MACROS = new Map<string, FenceMacro>();

// Register a macro. Throws on a duplicate claim so a real collision (two macros for
// the same fence language) fails loud at startup rather than silently shadowing.
export function registerMacro(macro: Macro): void {
  if (macro.kind === "fence") {
    const lang = macro.lang.toLowerCase();
    if (FENCE_MACROS.has(lang)) throw new Error(`duplicate fence macro for language: ${lang}`);
    FENCE_MACROS.set(lang, macro);
  }
}

// Look up the macro for a fenced-code info string (case-insensitive). Undefined → a
// plain code block (the existing renderer tints it).
export function findFenceMacro(lang: string): FenceMacro | undefined {
  return FENCE_MACROS.get(lang.toLowerCase());
}

export function registeredFenceLangs(): string[] {
  return [...FENCE_MACROS.keys()];
}
