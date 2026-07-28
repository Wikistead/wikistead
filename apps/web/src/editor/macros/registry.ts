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

import type { SafeHtml } from "./safe-html";
import { ALLOWED_CAPABILITIES } from "./macro-registry"; // #450 §4b: the one capability vocabulary

export type MacroTheme = "light" | "dark";

// MacroSource (ADR-045 / #88 item 3) — a nominal brand for the canonical source text that crosses
// the host↔macro boundary (InnerEditHost / MacroModalEditor / MacroTier). It is still a string at
// runtime (parse/slice/concat all work), but a plain string is NOT assignable to a MacroSource slot
// without going through `asMacroSource`, so the host and a macro can't accidentally swap macro source
// for some other string at the boundary. The host is the producer (it extracts the body from the
// doc); a macro that returns rewritten source (tier.toLevel, getSource, getBody) brands its output.
declare const MACRO_SOURCE: unique symbol;
export type MacroSource = string & { readonly [MACRO_SOURCE]: true };
export function asMacroSource(s: string): MacroSource {
  return s as MacroSource;
}

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
//
// #450 slices 5a/5b: this IS the macro SDK. It is assembled per dispatch by `createMacroSdk`
// (macro-sdk.ts) from the macro's declared capabilities intersected with its caller's, and frozen. The
// optional members are absent unless the macro's effective set carries them, so "did the host give me
// this?" is answered by the object rather than by a flag a macro could lie about. `theme` stays
// required because every macro today reads it (a macro that declares capabilities without `theme`
// deliberately receives none, which its render sees immediately).
export interface MacroContext {
  readonly theme: MacroTheme;
  /** The effective capability set this render was granted (#450 5a). */
  readonly capabilities?: readonly string[];
  /** Render markdown from THIS macro's body at an offset inside it (#450 5b, ruling R1). */
  readonly renderMarkdown?: (src: string, relativeOffset?: number) => DocumentFragment;
  /** Opaque per-instance token for display-only state that must survive a re-render (#450 5b). */
  readonly instanceKey?: string;
  /** Ask the host for a slot it owns and fills — fixed schema, values only (#450 5c, ruling R3). */
  readonly hostSlot?: (params: { kind: "list"; source: "tagged" | "children"; query?: string }) => HTMLElement;
}

// Mouse rich-edit (ADR-022 Part 3). A "modal" editor mounts in a plain-DOM overlay
// OUTSIDE CodeMirror (so an embedded React editor like Excalidraw never enters CM —
// ADR-013) and returns the edited body to write back to the macro's source range.
export interface MacroModalController {
  getBody(): MacroSource; // current serialized body, written back on save
  destroy(): void; // unmount / cleanup
}
// #92 / ADR-093: a HOST-provided ephemeral collab session for level-2 co-editing (Excalidraw). It is
// passed as a SEPARATE optional argument to mount — NOT folded into MacroContext — so the general macro
// trust boundary ({theme}) is unchanged; only a collab-capable modal (excalidraw) reads it, and only
// the host ever supplies it. The scene lives in `doc` (a Y.Map, not the page Y.Text); destroy() tears
// the room down (the final scene is flushed to the fence via getBody on modal close).
export interface HostEphemeralCollab {
  readonly doc: import("yjs").Doc;
  readonly awareness?: unknown;
  destroy(): void;
}
export interface MacroModalEditor {
  // May be async — the editor (e.g. Excalidraw) is lazy-loaded. `hostCollab` is optional + host-only
  // (present only for a collab-capable macro when the host injects the ephemeral seam); macros that
  // don't co-edit ignore it, keeping the {theme} boundary intact.
  mount(container: HTMLElement, body: MacroSource, ctx: MacroContext, hostCollab?: HostEphemeralCollab): Promise<MacroModalController>;
}
// ADR-025: the narrow host an INLINE rich-editor (e.g. table) talks to. Like MacroContext
// it exposes NO editor / Yjs / app internals — only the macro's own source + theme + a
// commit/exit. The editor edits its own model and commits via replaceSource (per-op, ADR-025
// Q1); the host turns that into ONE offset-invariant Y.Text range edit (block-level LWW) and
// owns enter/exit. Keeps the ADR-023 trust boundary for inline editing (incl. future plugins).
export interface InnerEditHost {
  readonly theme: MacroTheme;
  getSource(): MacroSource; // the macro's current body (source text)
  replaceSource(next: MacroSource): void; // commit a new body
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
  // `collab: true` (modal only, #92) opts the macro into the host's ephemeral collab seam — the host
  // opens an ephemeral room and passes the session to mount's `hostCollab`. Others get single-user.
  | { readonly present: "modal"; readonly editor: MacroModalEditor; readonly collab?: boolean }
  | { readonly present: "inline"; readonly editor: InlineEditor };

// #174 / ADR-087: the UNIFIED macro edit-UI contract, generalising RichEditUI into ONE public API a
// third-party macro can implement. The macro renders its editor into the host-provided `container`;
// the host-API is `ctx = { theme }` ONLY (narrow trust boundary, ADR-024 — no EditorView/Y.Text/DB/FGA)
// plus `save(newSource)`, which the host applies to the single Y.Text offset-invariantly (the macro
// never touches the document). `present` picks an inline panel vs a modal. save granularity is the
// ADR-087 contract: `inline` ⇒ immediate Y.Text (concurrent edits merge via Y.Text); `modal` ⇒
// close-flush is permitted only for canvas editors (Excalidraw). The mount returns a controller the
// host destroys on exit. This subsumes RichEditUI (InnerEditHost/MacroModalEditor) as macros migrate.
// #243 / ADR-111 C3 slice 2b: `handlesEscape` lets an editUI whose editor is vim-capable (the CM6 source
// pane) tell the host "don't exit on THIS Escape — my editor will handle it" (vim insert→normal). Returns
// true ONLY while the nested editor needs the Escape (vim insert mode); the host exits on every other Escape.
// Optional + additive: a panel editUI without it (callout) keeps the plain "Escape exits" behaviour.
export interface EditUIController { destroy(): void; handlesEscape?(): boolean }
export interface EditUI {
  readonly present: "inline" | "modal";
  // #174 / ADR-087: what `source`/`save` operate on. "body" (default) = the macro's inner content only
  // (the host wraps it back into the fence) — right when the fence is fixed (mermaid). "block" = the
  // WHOLE block source incl. the `:::name[label]` / ```lang fences — needed when the editor changes the
  // fence itself (a callout's TYPE = its directive name, a `[label]`), so the macro reconstructs it.
  readonly sourceScope?: "body" | "block";
  // #243 / ADR-111 C3 (slice 2): `editEnv` carries mount-time host EDIT services — kept a SEPARATE param
  // (like the modal editor's hostCollab), NOT folded into MacroContext, so the render trust boundary stays
  // {theme} only (ADR-023). `vim` mirrors the OUTER editor's vim ON/OFF so a CM6 source pane can enable vim
  // (the same @replit/codemirror-vim the host uses — not a second engine); absent ⇒ vim off.
  mount(container: HTMLElement, source: MacroSource, ctx: MacroContext, save: (newSource: MacroSource) => void, editEnv?: EditEnv): EditUIController;
}
// #456 S1 (editUI contract v2). Three additions, all optional and additive, so every macro that
// exists today keeps working unchanged.
//
// (1) The editUI body should BE the shared live-preview surface, not a per-macro editor. Macros
// cannot build that themselves — it belongs to the host (it is the same factory the layout slot
// islands use, so vim, the slash palette, completion and nested rendering come with it rather than
// being re-implemented per macro). So the host offers it through editEnv, keeping the render-time
// trust boundary at {theme}: a macro asks for a surface and gets a handle, never an EditorView.
export interface HostSurfaceOptions {
  readonly parent: HTMLElement;
  readonly doc: MacroSource;
  // "markdown" = the content IS prose (a callout body, a layout slot) → the surface keeps the
  // reading typography. "code" = the source IS code (mermaid, plantuml) → code face. The host owns
  // what each means; the macro only states which it is.
  readonly kind?: "markdown" | "code";
  readonly testid?: string;
  onInput?(value: MacroSource): void; // every keystroke — for a local preview; never a doc write
  onCommit?(value: MacroSource): void; // blur / explicit commit — the host makes it ONE Y.Text edit
}
export interface HostSurfaceHandle {
  getValue(): MacroSource;
  focus(): void;
  inVimInsert(): boolean; // so the host's Escape handling can defer to vim (see EditUIController)
  destroy(): void;
}

// (2) Declarative settings. A macro that wants mouse-driven configuration (a code fence's language,
// highlighted lines, filename, wrap) DECLARES controls and supplies two PURE functions over its own
// source; the host renders the controls and applies the result. The macro never touches the DOM, the
// document or the editor, so a third-party macro gets the same settings UI as a first-party one
// without widening the host-API. Control kinds are a closed set on purpose — the host renders only
// what it knows how to render safely, and an unknown kind is ignored rather than guessed at.
export type MacroControl =
  | { readonly kind: "select"; readonly key: string; readonly label: string; readonly options: readonly { readonly value: string; readonly label: string }[] }
  | { readonly kind: "toggle"; readonly key: string; readonly label: string }
  | { readonly kind: "text"; readonly key: string; readonly label: string; readonly placeholder?: string }
  | { readonly kind: "lineRange"; readonly key: string; readonly label: string; readonly placeholder?: string };
export const MACRO_CONTROL_KINDS = ["select", "toggle", "text", "lineRange"] as const;
export type MacroSettingValues = Readonly<Record<string, string | boolean>>;
export interface MacroSettings {
  readonly controls: readonly MacroControl[];
  // Both PURE and source-only (no DOM, no editor, no Yjs) — the host may call them at any time,
  // including to preview a change it then discards.
  read(source: MacroSource): MacroSettingValues;
  write(source: MacroSource, values: MacroSettingValues): MacroSource;
}

// (3) What Ctrl+↵ means for a macro that CONTAINS editable regions. A container (tabs, columns) has
// no single body to edit: entering it means entering one of its slots. Rather than the host
// hardcoding "tabs → active tab, columns → first column", the macro declares it — so a third-party
// container defines its own entry the same way. Returning null means "no inner target", and the host
// falls back to the normal editUI.
export interface EnterContext {
  readonly anchor: number; // document offset of the macro's body — the key display state is stored under
}
export interface EnterTarget {
  // The slot's offset range within the macro's own source. The host maps it to the document and
  // mounts the surface there — the macro does no coordinate work of its own.
  readonly from: number;
  readonly to: number;
}
export interface EditEnv {
  readonly vim?: boolean;
  // #456 S1: present when the host can lend its shared surface. Optional so a macro can fall back
  // to its own pane (and so tests can mount an editUI with no host).
  mountSurface?(opts: HostSurfaceOptions): HostSurfaceHandle;
  // #525: host-mediated diagram render for an editUI's PREVIEW pane. The read surface already swaps a
  // host-renderable fence (plantuml) for image bytes it fetched itself (HOST_RENDERABLE + the
  // diagramRenderer facet), but an OPEN editUI had no such seam, so the edit panel kept showing source
  // while the same block rendered a diagram once closed. The macro still never fetches (ADR-024): it
  // hands over its source and gets bytes back, or null to keep degrading to source (Open formats).
  // Absent when the host configures no renderer, or for a macro that renders client-side (mermaid).
  renderDiagram?(source: MacroSource): Promise<import("../live-preview/decorations").DiagramRenderResult>;
}

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
  canRepresentAt(source: MacroSource, level: MacroLevel): boolean;
  // Re-serialize `source` at `level` (round-trips through the macro's own model).
  toLevel(source: MacroSource, level: MacroLevel): MacroSource;
}

export interface FenceMacro {
  readonly kind: "fence";
  // The fenced-code info string this macro claims, e.g. "mermaid" (```mermaid …).
  readonly lang: string;
  // Live (editor/published) render: build DOM from the fence body. May fill itself
  // in asynchronously INTO the returned element (like the image widget), but returns
  // synchronously so the CodeMirror widget stays sync. Returns display DOM only.
  liveRender(body: string, ctx: MacroContext): HTMLElement;
  // Static HTML for export / SSR (wired server-side in M3). Returns SafeHtml (ADR-045 / #88):
  // XSS-safety is enforced by the TYPE — the body must be built via html``/unsafeHtml, not raw
  // string concatenation. The server pipeline (#85) reads `.value`.
  htmlRender(body: string): SafeHtml;
  // One-line label for the folded summary ("▶ <summary>").
  summary(body: string): string;
  // REQUIRED on every macro (ADR-022 — degradation is never silent). "preserve" =
  // the source round-trips verbatim in Markdown (a code fence always does);
  // "degrade" = lossy, export emits a placeholder + warning (M3).
  // #450 / ADR-177 §4b: the host services this macro asks for. Enforced at registration (validateMacro
  // refuses anything the host does not broker) and intersected with the caller's set at dispatch, so a
  // nested macro can never hold more than the one rendering it. Absent = the default narrow surface.
  readonly capabilities?: readonly string[];
  readonly exportFidelity: "preserve" | "degrade";
  // Mouse rich-edit surface (modal for embedded React editors — keeps React out of
  // CodeMirror, ADR-013).
  readonly richEditUI?: RichEditUI;
  // #174 / ADR-087: the unified edit-UI (supersedes richEditUI as macros migrate). When present, the
  // host opens `editUI.mount` behind the single edit button; `editUI.present` also drives editModeOf.
  readonly editUI?: EditUI;
  // #456 S1: declarative mouse settings (host-rendered controls over pure source functions).
  readonly settings?: MacroSettings;
  // Tier levels for host auto-demote (ADR-025 step 3). Optional — most fence macros are
  // single-level (mermaid/excalidraw round-trip verbatim in their fence).
  readonly tier?: MacroTier;
  // #174 / ADR-087: whether the block shows the fold (collapse) button. Default true (a data fence like
  // a code block benefits from collapsing a large body). Set false for a rendered DIAGRAM where collapse
  // is meaningless (mermaid) — the reviewer flagged the mermaid collapse button for removal.
  readonly foldable?: boolean;
  readonly slash?: MacroSlash; // appears in the `/` palette
}

// A directive macro (:::name … :::). Unlike a fence macro, its body stays Markdown (parsed as
// nested nodes, decorated by the existing live-preview renderers). It renders one of TWO mutually
// exclusive ways — a CONTAINER (a CSS box whose content stays Markdown, e.g. a callout) or a BLOCK
// (a display widget built from the body, e.g. the HTML table). ADR-045 / #88 makes that exclusivity
// a TYPE, not a comment: the two shapes are a discriminated union, so a macro CANNOT declare both
// `containerClass` and `liveRender` (a real registration bug — which mode does it render?) and the
// mode-specific fields (icon/collapsible vs revealOnCursor) can't cross to the wrong mode. Every
// field is present on both members (as its real type or `never`), so reading `macro.containerClass`
// / `macro.liveRender` on the union stays ergonomic for the renderers that branch on them.
interface DirectiveMacroBase {
  readonly kind: "directive";
  readonly name: string; // :::name
  // Static HTML for export / SSR (M3): wrap the rendered body. The inner Markdown is
  // rendered by the server pipeline; this supplies the wrapper. Returns SafeHtml (ADR-045 /
  // #88) — XSS-safety enforced by the type (build via html``/unsafeHtml, never raw concat).
  htmlRender(body: string): SafeHtml;
  // #450 / ADR-177 §4b: the host services this macro asks for. Enforced at registration (validateMacro
  // refuses anything the host does not broker) and intersected with the caller's set at dispatch, so a
  // nested macro can never hold more than the one rendering it. Absent = the default narrow surface.
  readonly capabilities?: readonly string[];
  readonly exportFidelity: "preserve" | "degrade";
  readonly richEditUI?: RichEditUI;
  readonly editUI?: EditUI; // #174 / ADR-087 — unified edit UI (see FenceMacro.editUI)
  readonly settings?: MacroSettings; // #456 S1 — declarative mouse settings (see FenceMacro.settings)
  // #456 S1: where Ctrl+↵ lands for a CONTAINER (tabs → the active tab, columns → the first column).
  // Reads the macro's own source and answers in its own offsets, like the tier.
  // #456 S2: `ctx.anchor` is the document offset of the macro's BODY. Some containers' entry depends on
  // DISPLAY state the host keeps rather than on the source — which tab is on screen is the obvious case,
  // and it is keyed by exactly that anchor. Optional: a container whose entry is source-only (columns)
  // ignores it, and a caller without an anchor still gets a sensible answer.
  enter?(source: MacroSource, ctx?: EnterContext): EnterTarget | null;
  // Tier levels for host auto-demote (ADR-025 step 3). The table declares this (pipe ⟷
  // :::table); container directives without alternate representations omit it.
  readonly tier?: MacroTier;
  readonly slash?: MacroSlash; // appears in the `/` palette
}
// CONTAINER (callout / details): a CSS box over its lines; the content stays Markdown (nested),
// the ::: markers hide (reveal-on-cursor). No liveRender.
export interface ContainerDirectiveMacro extends DirectiveMacroBase {
  readonly containerClass: string;
  // Optional header icon (#150 typed callouts). When set, the open line always renders a header
  // (icon [+ label]); display-only, shown via data-icon.
  readonly icon?: string;
  // #90 details: a collapsible container — caret-away collapses to a "▸ summary" bar (one block
  // widget), caret-in reveals the raw source (reveal-on-cursor). Pairs with containerClass.
  readonly collapsible?: boolean;
  readonly liveRender?: never;
  readonly revealOnCursor?: never;
}
// BLOCK (table / columns / tabs / transclude): render the body as a display widget (like a fence
// macro). No containerClass.
export interface BlockDirectiveMacro extends DirectiveMacroBase {
  readonly liveRender: (body: string, ctx: MacroContext) => HTMLElement;
  // #90 (A′): REVEAL the raw source when the caret is inside the range (like the GFM table /
  // mermaid atoms) instead of entering explicitly. Used by the layout directives (columns/tabs).
  readonly revealOnCursor?: boolean;
  // #332: with revealOnCursor, an EMPTY caret resting on the block SELECTS the atom (rendered card +
  // ring, the image-atom model) instead of revealing its raw source; the raw reveals only on explicit
  // entry (Ctrl+Enter → macroRenderActiveField) or a non-empty selection. For a picker-completed atom
  // (embed-page) whose id is edited via the ⇆ retarget button / Ctrl+Enter — there is nothing to type
  // in place, so caret-in-reveals-raw would only strand the caret. Omit → caret-in reveals raw (default).
  // #395 / ADR-156 (the codified policy): set this for every macro with NOTHING TO TYPE at the block
  // itself — picker-chosen references, modal-edited scenes, zero-argument dynamic blocks. Registration
  // review must place each new macro in one class; a caret affordance on a nothing-to-type body is a
  // review-blocking defect (the `:::children` straggler this policy closed).
  readonly atomSelectable?: boolean;
  readonly containerClass?: never;
  readonly icon?: never;
  readonly collapsible?: never;
}
export type DirectiveMacro = ContainerDirectiveMacro | BlockDirectiveMacro;

export type Macro = FenceMacro | DirectiveMacro;

// #174 / ADR-087: resolve how the mouse edits a macro. The unified `editUI.present` wins; otherwise a
// modal richEditUI (Excalidraw) ⇒ "modal" (click selects, the edit button opens the editor), else
// "inline" (table/callout/mermaid — the edit button opens the in-place editor). One source of truth for
// the interaction matrix. (The legacy `editMode` attribute was folded into editUI.present — ADR-087 (4).)
export function editModeOf(macro: { editUI?: EditUI; richEditUI?: RichEditUI }): "inline" | "modal" {
  return macro.editUI?.present ?? (macro.richEditUI?.present === "modal" ? "modal" : "inline");
}

// #174 / ADR-087: does this macro expose ANY rich edit UI (the unified editUI OR the legacy richEditUI)?
// The host shows the single edit button when true. One predicate so the button logic is migration-safe.
export function hasEditUI(macro: { editUI?: EditUI; richEditUI?: RichEditUI }): boolean {
  return !!macro.editUI || !!macro.richEditUI;
}

const FENCE_MACROS = new Map<string, FenceMacro>();
const DIRECTIVE_MACROS = new Map<string, DirectiveMacro>();

// A fence lang / directive name must be a single token: the fence info-string parser matches
// [A-Za-z0-9_+-] and the directive name is a bare word, so anything else (spaces, colons, empty)
// could never be looked up — or worse, silently shadow. Reject it at registration.
const MACRO_NAME_RE = /^[A-Za-z0-9_+-]+$/;

// Runtime validation of a macro registration (ADR-045 / #88 item 5). The TYPES are the first line
// of defense for first-party TS code; this is the fortress for a registration that reaches the
// registry with the types bypassed (a JS caller, or a future user-macro sandbox loading untrusted
// descriptors). It re-checks the same invariants the union encodes — exclusive render mode, a valid
// single-token name, the required render/export/summary members — so a malformed macro fails LOUD at
// register time instead of rendering nothing (or the wrong mode) later. Never widens the trust
// boundary; it only rejects.
function validateMacro(macro: Macro): void {
  // Validate through a LOOSE view: the point of item 5 is to guard registrations that reached here
  // with the types bypassed, so we must not let TS's narrowing of the (trusted) union assume fields
  // are well-formed. Every check is a runtime `typeof`.
  const m = macro as {
    kind?: unknown; exportFidelity?: unknown; htmlRender?: unknown; summary?: unknown;
    lang?: unknown; name?: unknown; containerClass?: unknown; liveRender?: unknown;
    richEditUI?: { present?: unknown; editor?: { mount?: unknown } };
  };
  if (m.kind !== "fence" && m.kind !== "directive")
    throw new Error(`macro.kind must be "fence" or "directive" (got ${JSON.stringify(m.kind)})`);
  if (m.exportFidelity !== "preserve" && m.exportFidelity !== "degrade")
    throw new Error(`macro exportFidelity must be "preserve" | "degrade" (got ${JSON.stringify(m.exportFidelity)})`);
  if (typeof m.htmlRender !== "function") throw new Error("macro htmlRender must be a function");
  // #450 / ADR-177 rev2 §4b: capabilities are enforced at REGISTRATION, not merely disclosed. The narrow
  // host-API (ADR-024) is an invariant, and an invariant checked only in a manifest reviewed by a human is
  // an invariant until someone is in a hurry. A macro may declare only what the host actually brokers.
  const caps = (macro as { capabilities?: unknown }).capabilities;
  if (caps !== undefined) {
    if (!Array.isArray(caps)) throw new Error("macro capabilities must be an array when present");
    for (const c of caps) {
      if (typeof c !== "string" || !ALLOWED_CAPABILITIES.has(c)) {
        throw new Error(`macro capability ${JSON.stringify(c)} is not brokered by the host (allowed: ${[...ALLOWED_CAPABILITIES].join(", ")})`);
      }
    }
    // A host-resolved list is, by construction, not something a static file can reproduce — its content
    // depends on the workspace at read time. Declaring it while claiming `preserve` would promise an export
    // fidelity the macro cannot keep, which is the Open-formats contract (ADR-023) told as a lie.
    if (caps.includes("host-list") && m.exportFidelity !== "degrade") {
      throw new Error('a macro declaring "host-list" must set exportFidelity: "degrade" — a host-resolved list cannot be reproduced in a static export');
    }
  }
  const rich = m.richEditUI;
  if (rich !== undefined) {
    if (rich.present !== "modal" && rich.present !== "inline")
      throw new Error(`macro richEditUI.present must be "modal" | "inline" (got ${JSON.stringify(rich.present)})`);
    if (!rich.editor || typeof rich.editor.mount !== "function")
      throw new Error("macro richEditUI.editor must expose a mount() function");
  }
  if (m.kind === "fence") {
    if (typeof m.lang !== "string" || !MACRO_NAME_RE.test(m.lang))
      throw new Error(`invalid fence macro lang: ${JSON.stringify(m.lang)} (must match ${MACRO_NAME_RE})`);
    if (typeof m.liveRender !== "function") throw new Error(`fence macro "${m.lang}" must define liveRender`);
    if (typeof m.summary !== "function") throw new Error(`fence macro "${m.lang}" must define summary`);
  } else {
    if (typeof m.name !== "string" || !MACRO_NAME_RE.test(m.name))
      throw new Error(`invalid directive macro name: ${JSON.stringify(m.name)} (must match ${MACRO_NAME_RE})`);
    const hasContainer = typeof m.containerClass === "string";
    const hasBlock = typeof m.liveRender === "function";
    if (hasContainer && hasBlock)
      throw new Error(`directive macro "${m.name}" declares BOTH containerClass and liveRender — pick one render mode`);
    if (!hasContainer && !hasBlock)
      throw new Error(`directive macro "${m.name}" declares neither containerClass nor liveRender — needs one render mode`);
  }
}

// Register a macro. Validates the registration (ADR-045 item 5) then throws on a duplicate claim so
// a real collision (two macros for the same fence language / directive name) fails loud at startup
// rather than shadowing.
export function registerMacro(macro: Macro): void {
  validateMacro(macro);
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
