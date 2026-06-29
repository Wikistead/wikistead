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
  // #153 / ADR-054 (M1 spike GO): delegate focus to a host-managed editable element for in-editor
  // WYSIWYG cell editing. The host (which holds the EditorView) focuses `target` and, while
  // active, does not reclaim focus / sync its selection over it. focus/selection ONLY — NO
  // view.dispatch, NO state, NO Yjs; doc still commits via replaceSource; the inner editor's
  // contenteditable never writes Yjs. Returns a release handle; end() restores editor focus.
  // (M1 mechanism proven by the spike: an atomic widget root [contenteditable=false + ignoreEvent]
  // with a nested contenteditable island holds focus and CM doesn't reclaim it — vim and non-vim.)
  beginTextEdit(target: HTMLElement): { end(): void };
}
export interface InlineController {
  destroy(): void; // unmount / cleanup
}
// ADR-025 step 2: an INLINE rich-editor mounts its own DOM into `container` and talks ONLY
// to InnerEditHost — it never sees CodeMirror/EditorView (a host-layer bridge widget wires
// it in). Mirrors MacroModalEditor for the modal path; table is the first implementation.
export interface InlineEditor {
  mount(container: HTMLElement, host: InnerEditHost): InlineController;
}
export type RichEditUI =
  | { readonly present: "modal"; readonly editor: MacroModalEditor }
  | { readonly present: "inline"; readonly editor: InlineEditor };

// ADR-025 step 3: a macro's source can often be written at more than one "level" — a
// standard, portable form (CommonMark / GFM) or a richer non-standard one (a ::: directive
// or HTML). A MacroTier declares those levels (lowest = most standard/portable first) plus
// how to test and convert a source between them. The HOST consults it to AUTO-DEMOTE on every
// edit: persist at the LOWEST level that can represent the content (open formats — a plain
// GFM table stays a pipe table; only a merged/styled one promotes to :::table). Both fence
// and directive macros may declare a tier; a macro without one (e.g. mermaid) is single-level
// and the host writes its source verbatim. The tier operates ONLY on source strings (it
// round-trips through the macro's own model) — no EditorView/Yjs, same trust boundary.
export type StandardLayer = "commonmark" | "gfm" | "directive";
export interface MacroLevel {
  readonly id: string; // macro-local id, e.g. "pipe" | "html"
  readonly layer: StandardLayer; // which standard layer this level lives in
}
export interface MacroTier {
  readonly levels: readonly MacroLevel[]; // ordered LOWEST (most standard) → highest
  // Can `source` be written at `level` with NO loss? (e.g. a merged table can't be pipe)
  canRepresentAt(source: string, level: MacroLevel): boolean;
  // Re-serialize `source` at `level` (round-trips through the macro's own model).
  toLevel(source: string, level: MacroLevel): string;
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
  // Tier levels for host auto-demote (ADR-025 step 3). Optional — most fence macros are
  // single-level (mermaid/excalidraw round-trip verbatim in their fence).
  readonly tier?: MacroTier;
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
  // Optional header icon for a container directive (#150 typed callouts). When set, the open
  // line always renders a header (icon [+ label]); display-only, shown via data-icon.
  readonly icon?: string;
  // #90 details: a collapsible container — caret-away collapses to a "▸ summary" bar (one block
  // widget), caret-in reveals the raw source (reveal-on-cursor). Pairs with containerClass.
  readonly collapsible?: boolean;
  readonly liveRender?: (body: string, ctx: MacroContext) => HTMLElement;
  // #90 (A′): a liveRender directive that REVEALS its raw source when the caret is inside its
  // range (like the GFM table / mermaid atoms) instead of being entered explicitly. Used by the
  // layout directives (columns/tabs) so editing is reveal-on-cursor, not a modal.
  readonly revealOnCursor?: boolean;
  // Static HTML for export / SSR (M3): wrap the rendered body. The inner Markdown is
  // rendered by the server pipeline; this supplies the wrapper. MUST be XSS-safe.
  htmlRender(body: string): string;
  readonly exportFidelity: "preserve" | "degrade";
  readonly richEditUI?: RichEditUI;
  // Tier levels for host auto-demote (ADR-025 step 3). The table declares this (pipe ⟷
  // :::table); container directives without alternate representations omit it.
  readonly tier?: MacroTier;
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
