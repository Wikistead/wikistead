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

// How a macro appears in the `/` slash palette (ADR-017/018): one registration ⇒ the
// macro is insertable. labelKey is an i18n key; insert is the template; caret is the
// offset within it to place the cursor after insert.
export interface MacroSlash {
  readonly labelKey: string;
  readonly keywords: string;
  readonly insert: string;
  readonly caret?: number;
}

// The entire host surface a macro may touch. Keep this minimal — every field added
// here widens the eventual sandbox's attack surface.
export interface MacroContext {
  readonly theme: MacroTheme;
}

// Mouse rich-edit (ADR-022 Part 3). A "modal" editor mounts in a plain-DOM overlay
// OUTSIDE CodeMirror (so an embedded React editor like Excalidraw never enters CM —
// ADR-013) and returns the edited body to write back to the macro's source range.
export interface MacroModalController {
  getBody(): string; // current serialized body, written back on save
  destroy(): void; // unmount / cleanup
}
export interface MacroModalEditor {
  // May be async — the editor (e.g. Excalidraw) is lazy-loaded.
  mount(container: HTMLElement, body: string, ctx: MacroContext): Promise<MacroModalController>;
}
export type RichEditUI =
  | { readonly present: "modal"; readonly editor: MacroModalEditor }
  | { readonly present: "inline" };

// ADR-025: the narrow host an INLINE rich-editor (e.g. table) talks to. Like MacroContext
// it exposes NO editor / Yjs / app internals — only the macro's own source + theme + a
// commit/exit. The editor edits its own model and commits via replaceSource (per-op, ADR-025
// Q1); the host turns that into ONE offset-invariant Y.Text range edit (block-level LWW) and
// owns enter/exit. Keeps the ADR-023 trust boundary for inline editing (incl. future plugins).
export interface InnerEditHost {
  readonly theme: MacroTheme;
  getSource(): string; // the macro's current body (source text)
  replaceSource(next: string): void; // commit a new body
  exit(): void; // leave inline edit (Done / Esc)
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
  // Mouse rich-edit surface (modal for embedded React editors — keeps React out of
  // CodeMirror, ADR-013).
  readonly richEditUI?: RichEditUI;
  readonly slash?: MacroSlash; // appears in the `/` palette
}

// A container directive (:::name … :::). Unlike a fence macro, its body stays
// Markdown (parsed as nested nodes, decorated by the existing live-preview renderers),
// so a directive macro does NOT return a widget — it styles the CONTAINER. M1 needs
// only a CSS class for the box; a leading label / custom header comes later.
export interface DirectiveMacro {
  readonly kind: "directive";
  readonly name: string; // :::name
  // A directive renders one of two ways (mutually exclusive):
  //  - containerClass: a CONTAINER (callout) — a CSS box over its lines; the content
  //    stays Markdown (nested), the ::: markers hide (reveal-on-cursor); OR
  //  - liveRender: a BLOCK (table) — render the body (e.g. an HTML <table>) as a
  //    display widget (reveal-on-cursor shows the raw source), like a fence macro.
  readonly containerClass?: string;
  readonly liveRender?: (body: string, ctx: MacroContext) => HTMLElement;
  // Static HTML for export / SSR (M3): wrap the rendered body. The inner Markdown is
  // rendered by the server pipeline; this supplies the wrapper. MUST be XSS-safe.
  htmlRender(body: string): string;
  readonly exportFidelity: "preserve" | "degrade";
  readonly richEditUI?: RichEditUI;
  readonly slash?: MacroSlash; // appears in the `/` palette
}

export type Macro = FenceMacro | DirectiveMacro;

const FENCE_MACROS = new Map<string, FenceMacro>();
const DIRECTIVE_MACROS = new Map<string, DirectiveMacro>();

// Register a macro. Throws on a duplicate claim so a real collision (two macros for the
// same fence language / directive name) fails loud at startup rather than shadowing.
export function registerMacro(macro: Macro): void {
  if (macro.kind === "fence") {
    const lang = macro.lang.toLowerCase();
    if (FENCE_MACROS.has(lang)) throw new Error(`duplicate fence macro for language: ${lang}`);
    FENCE_MACROS.set(lang, macro);
  } else {
    const name = macro.name.toLowerCase();
    if (DIRECTIVE_MACROS.has(name)) throw new Error(`duplicate directive macro for name: ${name}`);
    DIRECTIVE_MACROS.set(name, macro);
  }
}

// Look up the macro for a fenced-code info string (case-insensitive). Undefined → a
// plain code block (the existing renderer tints it).
export function findFenceMacro(lang: string): FenceMacro | undefined {
  return FENCE_MACROS.get(lang.toLowerCase());
}

// Look up the macro for a :::name directive. Undefined → leave the raw ::: as text.
export function findDirectiveMacro(name: string): DirectiveMacro | undefined {
  return DIRECTIVE_MACROS.get(name.toLowerCase());
}

export function registeredFenceLangs(): string[] {
  return [...FENCE_MACROS.keys()];
}

export function registeredDirectiveNames(): string[] {
  return [...DIRECTIVE_MACROS.keys()];
}

// All registered macros (fence + directive) — used to build the `/` slash palette so a
// single registration makes a macro insertable (ADR-017/018).
export function registeredMacros(): Macro[] {
  return [...FENCE_MACROS.values(), ...DIRECTIVE_MACROS.values()];
}
