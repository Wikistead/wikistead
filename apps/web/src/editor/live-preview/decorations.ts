import { syntaxTree, foldedRanges, foldEffect, unfoldEffect } from "@codemirror/language";
import { Facet, StateField, StateEffect, EditorState, EditorSelection, Prec, type Range, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { findFenceMacro, findDirectiveMacro, editModeOf, hasEditUI, asMacroSource, type FenceMacro, type MacroTheme, type MacroSource, type MacroTier, type EditUI, type EditUIController } from "../macros/registry";
import { autoDemote } from "../macros/tier-cap";
export type { MacroTheme }; // #200: re-exported so the Editor can type the redrawMacros payload
import { fenceLang, fenceBody, macroFenceAt, directiveMacroAt, directiveChainAt, tableBlockAt } from "../macros/fence";
import { currentMacroTheme } from "../macros/theme";
import { parseDirectiveOpen, resolveDirectiveRanges } from "../macros/directive-parser";
import { parseFenceLine, parseFenceInfo, serializeFenceInfo, CALLOUT_TYPES, type FenceAlign } from "@wikistead/macro-render"; // #198: code-fence attribute parser; #174: callout types; #255: align rewrite
// #255: rendered diagram macros are centred by default and take a fence `align=` attribute (others don't).
const DIAGRAM_MACROS = new Set(["mermaid", "plantuml", "excalidraw"]);
import { renderMarkdownToDom, renderCalloutPanel, setPendingBaseOffset } from "../macros/md-render";
import { buildEmbedElement } from "../macros/embed";
import { noteCalloutMacro } from "../macros/callout";
import { calloutTypeOption } from "../macros/callout-type-ui";
import { renderCellInline } from "../macros/table-cell-dom";
import { openMacroModal } from "./macro-modal";
import { macroRenderActiveField, setMacroRenderActive, makeInnerEditHost, nestedSelectionField, setNestedSelection, nestedEditActiveField, setNestedEditActive, type NestedSelection } from "./macro-edit";
import { tableInlineEditor } from "./table-edit";
import { tableTier } from "../macros/table";
import type { InlineController } from "../macros/registry";

// Whether the vim keymap is active. Set from the vim Compartment (Editor.tsx). Macros no
// longer reveal-on-cursor (ADR-024: atoms are entered explicitly), so this no longer gates
// macro reveal; kept for vim-aware interaction (e.g. enter-key vs click) and so the
// decoration field can still rebuild on a mode change if needed.
export const vimEnabled = Facet.define<boolean, boolean>({ combine: (v) => (v.length ? v[v.length - 1]! : false) });

// Editor display mode (ADR-056 / #164) — an editor-wide axis, orthogonal to vim, that decides how
// syntax is shown. Set from a Compartment (Editor.tsx). Phase 1: "live" (reveal-on-cursor, the
// default) and "source" (syntax ALWAYS raw = force reveal everywhere). "reading" (read-only clean
// render) + "wysiwyg" (ADR-051 B / #153) are later phases. This is DISPLAY-ONLY: it never touches
// the doc/offsets/presence, so collaborators each pick their own mode.
export type DisplayMode = "live" | "source" | "reading" | "wysiwyg";
export const displayMode = Facet.define<DisplayMode, DisplayMode>({ combine: (v) => (v.length ? v[v.length - 1]! : "live") });

// Mode-based rich edit (ADR-022 Part 11): a CLICK on a table enters edit mode in BOTH
// modes (the mouse is independent of vim; vim still reveals on the keyboard). Returns true
// if it entered edit mode (caller preventDefaults so the caret isn't also placed).
function openTableEditing(view: EditorView, pos: number): boolean {
  // Reading mode is read-only (#165 keeps it focusable so vim navigates, so the static TableWidget's
  // click handler still fires here — guard it): never enter table editing when read-only (#174-#4).
  if (view.state.readOnly) return false;
  const tb = tableBlockAt(view.state, pos);
  if (!tb) return false;
  // #216 comment 802 (ADR-101 4-quadrant): an EXPLICIT open (Ctrl+Enter / click) mounts the in-editor
  // WYSIWYG table editor (#154) for EVERY quadrant — including vim × pipe, which previously only revealed
  // raw here and so left vim users with NO way to reach the RichUI. Raw row-by-row editing is still fully
  // available in Live × vim by just navigating the caret INTO the table (the pipe renderer reveals raw on
  // caret-entry via rangeRevealed — independent of this explicit path); Ctrl+Enter is the deliberate
  // "give me the rich editor" gesture. The M1 spike (ADR-054) proved the nested contenteditable holds
  // focus inside an atomic widget even under vim, so there is no focus reason to special-case vim.
  view.dispatch({ effects: setMacroRenderActive.of({ from: tb.from, to: tb.to }) });
  view.focus();
  return true;
}

// Force a full reload on HMR: this module's decorations/state are baked into the
// EditorView at creation (built once, not re-run on hot-swap), so a hot update would
// leave a STALE editor running old behaviour (a fix wouldn't take effect until a manual
// reload). Self-accept + reload so the running editor always reflects the latest code.
// Dev-only (stripped from prod builds).
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());

// Obsidian-style live preview: hide/style markdown syntax via CodeMirror
// decorations.
//
// INVARIANT (ADR-008 — the one non-obvious interaction in this surface)
// decorations are DISPLAY-ONLY and OFFSET-INVARIANT. `Decoration.replace` hides
// glyphs but never mutates the document; the CM doc stays 1:1 with the canonical
// Y.Text (kept in sync by yCollab). Remote collaborators' carets are drawn at
// Y.Text offsets (yCollab maps a Y RelativePosition -> absolute doc index ->
// doc.lineAt(index)), so any offset shift introduced here would misplace their
// cursors. Therefore this plugin ONLY ever returns a DecorationSet — it never
// dispatches a document change. reveal-on-cursor toggles WHICH markers are drawn,
// not the document length, so offsets are stable whether syntax is shown or not.

const strongMark = Decoration.mark({ class: "cm-lp-strong" });
const emphasisMark = Decoration.mark({ class: "cm-lp-emphasis" });
const strikeMark = Decoration.mark({ class: "cm-lp-strike" });
const inlineCodeMark = Decoration.mark({ class: "cm-lp-inline-code" });
const linkMark = Decoration.mark({ class: "cm-lp-link" });
const hide = Decoration.replace({});

const headingLine = (level: number) =>
  Decoration.line({ attributes: { class: `cm-lp-h cm-lp-h${level}` } });
const quoteLine = Decoration.line({ attributes: { class: "cm-lp-quote" } });
const hrLine = Decoration.line({ attributes: { class: "cm-lp-hr" } });

// #198 / ADR-094: a header band shown ABOVE a code fence that carries attributes — a filename/title
// plus a muted language label. Display-only (contenteditable=false, ignoreEvent), block widget on the
// side:-1 of the opening fence line. eq keys on lang+title so it's reused while they're stable.
// #198 / ADR-094 (comment 724): the attributed code-fence chrome on the opening line — a FILENAME TAB
// (B) at the top-left that reads like an editor tab connected to the code card, plus a COPY button at
// the top-right shown only in a VIEW mode (Live/Reading), not Source. The row spans the opening line
// (justify-between). copy reads the fence's code body (not the info line/header) → clipboard, with a
// transient ✓ feedback. XSS-safe (textContent only).
class FenceHeaderWidget extends WidgetType {
  constructor(readonly lang: string, readonly title: string | undefined, readonly code: string, readonly canCopy: boolean) { super(); }
  eq(o: FenceHeaderWidget) { return o.lang === this.lang && o.title === this.title && o.code === this.code && o.canCopy === this.canCopy; }
  toDOM() {
    const row = document.createElement("div");
    row.className = "cm-lp-code-header";
    row.contentEditable = "false";
    // The filename tab (title + lang label) — top-left, editor-tab look.
    const tab = document.createElement("span");
    tab.className = "cm-lp-code-tab";
    if (this.title) {
      const t = document.createElement("span");
      t.className = "cm-lp-code-title";
      t.textContent = this.title; // XSS-safe: textContent, never innerHTML
      tab.appendChild(t);
    }
    if (this.lang) {
      const l = document.createElement("span");
      l.className = "cm-lp-code-lang";
      l.textContent = this.lang;
      tab.appendChild(l);
    }
    // #174 comment 948: a lang-less fence (copy button only) must NOT emit an EMPTY tab — the
    // .cm-lp-code-tab CSS (padding/bg/border/radius) would render it as a small empty tab "stub". Only
    // append the tab when it actually has a title or lang; otherwise the header is just the copy button
    // (kept right by margin-left:auto), and the card's rounded top-left corner stays intact.
    if (this.title || this.lang) row.appendChild(tab);
    // The copy button — view mode only (Source can select the raw text directly).
    if (this.canCopy) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cm-lp-code-copy";
      btn.setAttribute("aria-label", "Copy code");
      btn.title = "Copy code";
      btn.innerHTML = COPY_ICON; // trusted constant SVG (no user input → XSS-safe)
      btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard?.writeText(this.code).then(() => {
          btn.classList.add("cm-lp-code-copied");
          btn.innerHTML = CHECK_ICON;
          setTimeout(() => { btn.classList.remove("cm-lp-code-copied"); btn.innerHTML = COPY_ICON; }, 1400);
        }).catch(() => { /* clipboard denied (insecure ctx / permission) — no-op */ });
      });
      row.appendChild(btn);
    }
    return row;
  }
  ignoreEvent(e: Event) { return e.type !== "mousedown" && e.type !== "click"; }
}

// Shared by every BLOCK widget (image / table / macro / table-edit). A widget's rendered
// height can change AFTER CM first measures it — an <img>/SVG loading async, child elements
// mounting, edit-mode chrome appearing. When it does, CM's line geometry for everything
// BELOW it goes stale and vim's visual-geometry j/k drift across that whole region. Observe
// the widget's size and ask CM to re-measure on any change, so geometry always tracks the
// real height — for ANY block widget, however its height changes. Disconnect in destroy.
export function observeBlockResize(view: EditorView, dom: HTMLElement): ResizeObserver {
  const ro = new ResizeObserver(() => view.requestMeasure());
  ro.observe(dom);
  return ro;
}

// #202: nested bullet lists get a hierarchy glyph per level (Notion/editors convention) so nesting
// reads at a glance: level 0 = •, 1 = ◦, 2 = ▪, then cycle. Level = indentation / 2 (the markdown
// nesting convention used by list-edit.ts indent/outdent).
const BULLET_GLYPHS = ["•", "◦", "▪"];
class BulletWidget extends WidgetType {
  constructor(readonly level: number) { super(); }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-lp-bullet";
    span.textContent = BULLET_GLYPHS[this.level % BULLET_GLYPHS.length]!;
    return span;
  }
  eq(o: BulletWidget) {
    return o.level === this.level;
  }
}

// #202 (comment 761): nested ORDERED lists mirror the bullet hierarchy — each nesting level counts
// independently (a nested list restarts, not merged into the parent's run) and gets its own ordinal
// STYLE: level 0 = decimal (1.), 1 = lower-alpha (a.), 2 = lower-roman (i.), then cycle. The DISPLAYED
// ordinal is the item's POSITION in its list (from the syntax tree), NOT the raw source number, so
// `1. / 2. / 3.` typed at any indent renders as the correct per-level sequence. Display-only (the source
// markers round-trip unchanged — Open formats).
function toAlpha(n: number): string {
  let s = "";
  while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s || "a";
}
function toRoman(n: number): string {
  const map: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let s = "";
  for (const [v, r] of map) while (n >= v) { s += r; n -= v; }
  return s || "i";
}
function orderedLabel(level: number, ordinal: number): string {
  const style = level % 3; // 0 decimal, 1 lower-alpha, 2 lower-roman
  const body = style === 1 ? toAlpha(ordinal) : style === 2 ? toRoman(ordinal) : String(ordinal);
  return body + ".";
}
class OrderedWidget extends WidgetType {
  constructor(readonly level: number, readonly ordinal: number) { super(); }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-lp-ordinal";
    span.textContent = orderedLabel(this.level, this.ordinal);
    return span;
  }
  eq(o: OrderedWidget) { return o.level === this.level && o.ordinal === this.ordinal; }
}
// The runtime node is a real @lezer SyntaxNodeRef (fuller than RenderNode's minimal typing), so we reach
// .parent/.prevSibling here for the tree walks.
type TreeNode = { readonly name: string; readonly prevSibling: TreeNode | null; readonly parent: TreeNode | null };
const asTree = (node: RenderNode): TreeNode => node.node as unknown as TreeNode;
// The item's 1-based position within its immediate list (independent per nesting level — a nested list
// starts at 1). Counts preceding ListItem siblings in the syntax tree, so "wrong" source numbers still
// render the correct per-level sequence.
function orderedOrdinal(node: RenderNode): number {
  const item = asTree(node).parent; // ListMark -> ListItem
  let n = 1;
  let sib = item?.prevSibling ?? null;
  while (sib) { if (sib.name === "ListItem") n++; sib = sib.prevSibling; }
  return n;
}
// #202 (comment 761): the NESTING DEPTH (0 = top-level) from the syntax tree — counts ancestor list
// nodes. Bullets AND ordered lists both key their per-level style off this SAME metric, so their hierarchy
// reads consistently (a single nest is level 1 for both), independent of the raw indent width.
function listDepth(node: RenderNode): number {
  let count = 0;
  let p = asTree(node).parent; // start at ListItem
  while (p) { if (p.name === "OrderedList" || p.name === "BulletList") count++; p = p.parent; }
  return Math.max(0, count - 1);
}

// GFM task checkbox (ADR-019). The `[ ]`/`[x]` TaskMarker renders as a real checkbox
// (reveal-on-cursor still shows the raw markers for editing). How a click is handled
// depends on the surface, supplied via this facet
// - { mode: "edit" } editable draft surface → flip the char in the doc
// directly (a normal offset-invariant Y.Text edit).
// - { mode: "view", onToggle } read-only published surface → the host persists it
// (flip the live draft over its collab connection +
// the no-revision endpoint). See Editor.tsx.
// - null no edit permission → rendered DISABLED (display only;
// the server is the bastion regardless — D3).
export type CheckboxControl =
  | { mode: "edit" }
  | { mode: "view"; onToggle: (index: number, from: number, checked: boolean) => void }
  | null;
export const checkboxControl = Facet.define<CheckboxControl, CheckboxControl>({
  combine: (values) => (values.length ? values[values.length - 1] : null),
});

// MUST match the server's TASK_MARKER (apps/server/src/routes/pages.ts) so the ordinal
// index the client sends lines up 1:1 with the server's task enumeration. The server's
// "checkbox-only diff" guard is the safety net if they ever disagree (→ 409, never
// corruption).
const TASK_RE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\](?=[ \t])/gm;
// Ordinal of the task marker whose `[` is at `markerFrom`, counting all task markers
// before it in document order (matches the server's matchAll ordering).
function taskIndexAt(docText: string, markerFrom: number): number {
  let i = 0;
  for (const m of docText.matchAll(TASK_RE)) {
    const bracket = m.index + m[1].length; // offset of "["
    if (bracket < markerFrom) i++;
    else break;
  }
  return i;
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly from: number) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.from === this.from;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-lp-checkbox";
    box.setAttribute("data-testid", "task-checkbox");
    const ctl = view.state.facet(checkboxControl);
    // Reading mode (#164 / ADR-056) is read-only → the checkbox is inert (no doc toggle).
    box.disabled = !ctl || view.state.readOnly;
    if (ctl && !view.state.readOnly) {
      // mousedown + preventDefault: keep editor focus/selection and drive the toggle
      // ourselves (so the rendered state always follows the document, never the native
      // input). The doc/host update re-renders the widget with the new checked state.
      box.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (ctl.mode === "edit") {
          // editable surface: flipping the doc re-renders the widget immediately.
          view.dispatch({ changes: { from: this.from + 1, to: this.from + 2, insert: this.checked ? " " : "x" } });
        } else {
          // read-only published surface: the doc here is NOT the draft, so it won't
          // re-render until the host refetches the published snapshot — show the new
          // state at once for responsiveness (the refetch makes it authoritative).
          box.checked = !this.checked;
          const index = taskIndexAt(view.state.doc.toString(), this.from);
          ctl.onToggle(index, this.from, this.checked);
        }
      });
    }
    return box;
  }
  // Let the widget receive its own pointer events (it is interactive, unlike the bullet).
  ignoreEvent() {
    return false;
  }
}
const checkbox = (checked: boolean, from: number) =>
  Decoration.replace({ widget: new CheckboxWidget(checked, from) });

// Image attachments are referenced in the canonical Y.Text by a STABLE id
// ![alt](wks-attachment:<id>) — never by a presigned URL (those are short-lived
// bearer tokens; persisting one in the CRDT/its revision history would both break
// on expiry and leak a credential). The widget resolves the id to a fresh
// presigned URL at render time via this resolver. Resolution goes through the
// authenticated download endpoint, which re-checks FGA `view` on the attachment's
// page — so a user who can't view the page can't resolve its images either.
export type ImageResolver = (id: string, opts?: { refresh?: boolean }) => Promise<string | null>;
const noopResolver: ImageResolver = async () => null;
export const imageResolver = Facet.define<ImageResolver, ImageResolver>({
  combine: (values) => values[0] ?? noopResolver,
});

// Host-mediated diagram render (#140 / ADR-074). A renderable fence (plantuml) is NEVER fetched by
// the macro (host-API is {theme} only — ADR-024); the HOST resolves the source to image bytes via
// this injected renderer (it holds pageId/token and calls the gated, SSRF-guarded server endpoint).
// null ⇒ degrade-to-source (the widget keeps the source fence — Open formats, never a broken embed).
export type DiagramRenderer = (lang: string, source: string) => Promise<Blob | null>;
const noopDiagramRenderer: DiagramRenderer = async () => null;
export const diagramRenderer = Facet.define<DiagramRenderer, DiagramRenderer>({
  combine: (values) => values[0] ?? noopDiagramRenderer,
});

// #92 / ADR-093: host-provided EPHEMERAL collab seam for level-2 macro co-editing (Excalidraw). The
// macro's own host-API stays {theme} (ADR-023 trust boundary is NOT widened); collab is a SEPARATE,
// host-only channel injected here and handed to a collab-capable modal by openMacroModal. null ⇒ no
// collab (single-user modal, the M1 behaviour). The factory opens a room keyed by the macro's anchor.
export type EphemeralCollabFactory = (anchor: string) => import("../macros/registry").HostEphemeralCollab;
export const ephemeralCollab = Facet.define<EphemeralCollabFactory, EphemeralCollabFactory | null>({
  combine: (values) => (values.length ? values[values.length - 1]! : null),
});

// #92 presence: while a user has a macro's modal (Excalidraw) open they leave the page's live-preview
// surface, so their page cursor/avatar vanishes and peers see them "nowhere". This host seam bridges
// the fact "I'm editing the macro at <anchor>" onto the PAGE awareness: the modal calls set(anchor) on
// open and set(null) on close; peers read peers and a badge is drawn at that macro's anchor. It is a
// SEPARATE, host-only channel (like ephemeralCollab) — the macro host-API stays {theme} (ADR-023). All
// display-only; it never touches the doc/offset, only awareness (additive field — yCollab ignores it).
export interface MacroPresencePeer {
  readonly anchor: string; // the macro block's doc-offset key (String(from)), same as the ephemeral room
  readonly name: string;
  readonly color: string;
}
export interface MacroPresence {
  set(anchor: string | null): void; // I am (anchor) / am not (null) editing a macro's modal
  peers(): MacroPresencePeer[]; // remote peers currently editing a macro's modal
  subscribe(cb: () => void): () => void; // notify when peers change (to redraw); returns an unsubscribe
}
export const macroPresence = Facet.define<MacroPresence, MacroPresence | null>({
  combine: (values) => (values.length ? values[values.length - 1]! : null),
});

// Force a presence redraw when awareness changes (independent of doc edits).
const redrawMacroPresence = StateEffect.define<null>();
// #200: dispatched by the editor when the light/dark theme changes, so buildDecorations re-runs and
// rebuilds macro widgets with the new theme (their eq keys on theme → CM recreates them → liveRender
// re-exports for the new theme). The effect CARRIES the new theme (React's resolved value): a live
// <html data-theme> read is STALE at dispatch time — the Editor effect fires child-first, before
// ThemeProvider updates the DOM — so buildDecorations uses this payload as the theme override.
export const redrawMacros = StateEffect.define<MacroTheme>();

// The peer badge shown at a macro's anchor: one coloured dot per remote editor + a count and an
// "editing" label. Display-only (contenteditable=false, ignoreEvent) so it never enters the atom.
class MacroPresenceWidget extends WidgetType {
  constructor(readonly peers: MacroPresencePeer[]) { super(); }
  eq(other: MacroPresenceWidget) {
    return this.peers.length === other.peers.length &&
      this.peers.every((p, i) => p.name === other.peers[i]!.name && p.color === other.peers[i]!.color);
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-macro-presence";
    wrap.contentEditable = "false";
    wrap.setAttribute("data-testid", "macro-presence");
    for (const p of this.peers) {
      const dot = document.createElement("span");
      dot.className = "cm-lp-macro-presence-dot";
      dot.style.background = p.color;
      dot.title = p.name;
      wrap.appendChild(dot);
    }
    const label = document.createElement("span");
    label.className = "cm-lp-macro-presence-label";
    const names = this.peers.map((p) => p.name).join(", ");
    label.textContent = this.peers.length === 1 ? `${names} editing` : `${this.peers.length} editing`;
    wrap.appendChild(label);
    return wrap;
  }
  ignoreEvent() { return true; }
}

function buildMacroPresence(state: EditorState): DecorationSet {
  const pres = state.facet(macroPresence);
  if (!pres) return Decoration.none;
  const byAnchor = new Map<string, MacroPresencePeer[]>();
  for (const p of pres.peers()) {
    const a = byAnchor.get(p.anchor);
    if (a) a.push(p); else byAnchor.set(p.anchor, [p]);
  }
  const docLen = state.doc.length;
  const ranges: Range<Decoration>[] = [];
  for (const [anchor, peers] of byAnchor) {
    const at = Number(anchor);
    if (!Number.isFinite(at) || at < 0 || at > docLen) continue; // stale anchor (doc changed) → skip
    // #92: a BLOCK widget at side -1 so the badge renders as its own line ABOVE the macro. An inline
    // widget here is DROPPED by CM because the anchor is the START of the macro's atomic block-replace
    // range (that line has no inline context to host a widget). A block widget renders adjacent to the
    // replaced block. side -1 keeps it above; it is display-only (contenteditable=false, ignoreEvent).
    // Block decorations MUST come from a StateField (not a ViewPlugin — CM forbids plugin block deco),
    // hence macroPresenceField below rather than a plugin-provided set.
    ranges.push(Decoration.widget({ widget: new MacroPresenceWidget(peers), side: -1, block: true }).range(at));
  }
  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
}

// A stable signature of the current macro-edit peers (anchor+name+color). when nobody is editing a
// macro modal — which is ALWAYS the case during normal page editing, so the plugin then never reacts.
function macroPresenceSig(state: EditorState): string {
  const pres = state.facet(macroPresence);
  if (!pres) return "";
  return pres.peers().map((p) => `${p.anchor}:${p.name}:${p.color}`).sort().join("|");
}

// #92: the presence badges live in a StateField (block widgets can only be provided by a StateField,
// never a ViewPlugin — CM throws "Block decorations may not be specified via plugins"). It rebuilds when
// the doc shifts (anchors move) or when macroPresencePlugin dispatches redrawMacroPresence (peer set
// changed). Between those, the previous set is kept (positions still valid — no doc change).
export const macroPresenceField = StateField.define<DecorationSet>({
  create: (state) => buildMacroPresence(state),
  update(deco, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(redrawMacroPresence))) return buildMacroPresence(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Watches the page awareness and asks the field to rebuild when the macro-edit peer SET changes. It
// provides NO decorations itself (block deco can't come from a plugin) — it only dispatches the effect.
//
// #92 regression fix: never dispatch SYNCHRONOUSLY inside the awareness "change" handler. Awareness fires
// on every remote CURSOR MOVE / keystroke, and yCollab listens to the same event to render remote carets
// a re-entrant view.dispatch during that emission dropped yCollab's cursor updates (remote carets stopped
// syncing). So: (a) only act when the macro-edit peer set truly CHANGES (during normal editing the
// signature is and this is fully inert — zero interference), and (b) defer the dispatch to a frame so
// it never re-enters CodeMirror mid-awareness-processing.
export const macroPresencePlugin = ViewPlugin.fromClass(
  class {
    unsub: () => void;
    raf = 0;
    lastSig: string;
    constructor(view: EditorView) {
      this.lastSig = macroPresenceSig(view.state);
      const pres = view.state.facet(macroPresence);
      this.unsub = pres
        ? pres.subscribe(() => {
            const sig = macroPresenceSig(view.state);
            if (sig === this.lastSig) return; // unchanged (e.g. a plain remote cursor move) → do nothing
            this.lastSig = sig;
            if (this.raf) return;
            this.raf = requestAnimationFrame(() => { this.raf = 0; view.dispatch({ effects: redrawMacroPresence.of(null) }); });
          })
        : () => {};
    }
    destroy() { if (this.raf) cancelAnimationFrame(this.raf); this.unsub(); }
  },
);
// Macros whose body is rendered by the host (not bundled / not the macro). Others ignore the renderer.
const HOST_RENDERABLE = new Set(["plantuml"]);

// Host-mediated internal transclude (#108 / ADR-071). The :::transclude macro never fetches (host-API
// is {theme} only); the HOST resolves the referenced page's markdown via this injected resolver (the
// gated server route re-checks `view` on the REFERENCED page). null ⇒ an existence-hiding placeholder
// (denied / cycle / absent are indistinguishable). The resolved markdown renders via renderMarkdownToDom.
export type TranscludeResolver = (refId: string) => Promise<string | null>;
const noopTranscludeResolver: TranscludeResolver = async () => null;
export const transcludeResolver = Facet.define<TranscludeResolver, TranscludeResolver>({
  combine: (values) => values[0] ?? noopTranscludeResolver,
});

// Host-injected external-embed host allowlist (#108 / ADR-071 comment 551). The :::embed macro can't
// read the allowlist (host-API is {theme} only); the HOST supplies the tenant's allowlisted hosts and
// the MacroWidget renders a sandboxed iframe for an allowlisted https URL, else degrades to a link.
// Default empty ⇒ every embed degrades to a link (operator opt-in — external embed off by default).
export const embedAllowlist = Facet.define<readonly string[], readonly string[]>({
  combine: (values) => values[0] ?? [],
});

// #205 part 2 / #210: the host seam that opens a title-search PAGE PICKER for `:::embed-page`. The
// host (Editor) shows a command-palette modal whose candidates come from GET /search — which is
// FGA-view-filtered (two-stage guard), so a page the user can't view is never offered (no existence
// leak). onPick receives the chosen page id (or null if cancelled). Homed here (with the other host
// seams) so BOTH the slash-insert path (palette.ts) and the post-insert "change target" affordance
// (the MacroWidget edit button, #210) read the same seam and reuse the same authz-gated picker.
export type PageEmbedPicker = (onPick: (pageId: string | null) => void) => void;
export const pageEmbedPicker = Facet.define<PageEmbedPicker | null, PageEmbedPicker | null>({
  combine: (vals) => vals.find((v) => v != null) ?? null,
});

// #210 bounce: the host seam that opens an in-app URL modal for `:::embed-external` (replacing the raw
// window.prompt — review UI bounce). The host (Editor) shows a dialog seeded with the current URL
// and, using the tenant embed allowlist (useEmbedProviders / GET /embed/providers), warns when the typed
// host isn't allowlisted (save is still allowed — the render just degrades to a link). onSubmit gets the
// new URL (or null on cancel). Absent seam (guest / modal-less) ⇒ no-op (the caret stays; raw edit via
// reveal remains). The write-back core (embedRetargetChange) is unchanged.
export type EmbedUrlPrompt = (current: string, onSubmit: (url: string | null) => void) => void;
export const embedUrlPrompt = Facet.define<EmbedUrlPrompt | null, EmbedUrlPrompt | null>({
  combine: (vals) => vals.find((v) => v != null) ?? null,
});

// #210: compute the single canonical Y.Text edit that re-targets an embed block at `pos` to `value`.
// The offset is derived from the atom's DIRECTIVE range (directiveMacroAt), so the write lands on the
// real block, not a display-only mutation. Returns null when `pos` is not the named embed directive
// the guard that keeps a re-resolved / stale offset (or a cross-macro click) from writing the wrong
// block. Pure (state → change): the DOM-free core the anti-tests exercise on the real path.
export function embedRetargetChange(state: EditorState, pos: number, name: string, value: string): { from: number; to: number; insert: string } | null {
  const d = directiveMacroAt(state, pos);
  if (!d || d.name !== name) return null;
  return { from: d.from, to: d.to, insert: `:::${name}\n${value}\n:::` };
}

// #210: re-target an already-inserted `:::embed-page` / `:::embed-external` block. The edit button
// re-opens the SAME picker (embed-page) or prompts for a URL (embed-external) and writes the chosen
// id/URL back via embedRetargetChange — a single canonical dispatch whose offset is re-resolved fresh
// at WRITE time (posAtDOM → the block's current start), so a concurrent edit can't stale it. No new
// fetch path: embed-page reuses the FGA-view-gated search picker (the pageEmbedPicker seam).
function changeEmbedTarget(view: EditorView, wrap: HTMLElement, name: string): void {
  const write = (value: string) => {
    let ch: { from: number; to: number; insert: string } | null = null;
    try { ch = embedRetargetChange(view.state, view.posAtDOM(wrap), name, value); } catch { ch = null; }
    if (!ch) { view.focus(); return; }
    view.dispatch({ changes: ch, selection: EditorSelection.cursor(ch.from + ch.insert.length), scrollIntoView: true });
    view.focus();
  };
  if (name === "embed-page") {
    const picker = view.state.facet(pageEmbedPicker);
    if (!picker) { view.focus(); return; } // picker-less surface: fall back to raw edit (caret-in reveals)
    picker((pageId) => { if (pageId) write(pageId); else view.focus(); });
  } else {
    // #210 bounce: an in-app URL modal (embedUrlPrompt seam), not window.prompt. Seed the current URL.
    const prompt = view.state.facet(embedUrlPrompt);
    if (!prompt) { view.focus(); return; } // modal-less surface: raw edit via reveal remains
    let cur = "";
    try { cur = directiveMacroAt(view.state, view.posAtDOM(wrap))?.body.trim() ?? ""; } catch { /* detached → empty seed */ }
    prompt(cur, (url) => { if (url != null && url.trim() !== "") write(url.trim()); else view.focus(); });
  }
}

const ATTACHMENT_REF = /^!\[([^\]]*)\]\(wks-attachment:([^)\s]+)\)$/;

// Renders an image from a wks-attachment reference. src is filled in
// asynchronously from the resolver; on load error (e.g. the presigned URL
// expired) it re-resolves ONCE (refresh) before giving up — TTL caching means a
// repeated image still costs one resolve while the URL is valid.
class ImageWidget extends WidgetType {
  private ro?: ResizeObserver;
  constructor(readonly id: string, readonly alt: string) {
    super();
  }
  eq(other: ImageWidget) {
    return other.id === this.id && other.alt === this.alt;
  }
  toDOM(view: EditorView) {
    const img = document.createElement("img");
    img.className = "cm-lp-image";
    img.alt = this.alt;
    const resolve = view.state.facet(imageResolver);
    const load = (refresh: boolean) => {
      void resolve(this.id, { refresh }).then((url) => {
        if (url) img.src = url;
      });
    };
    let retried = false;
    img.addEventListener("error", () => {
      if (retried) return;
      retried = true;
      load(true); // presigned URL likely expired → re-resolve once
    });
    load(false);
    // The image loads async → its height changes after CM measured it. Re-measure on resize
    // so lines below the image don't drift (ADR-024 motion correctness — common path).
    this.ro = observeBlockResize(view, img);
    return img;
  }
  destroy() {
    this.ro?.disconnect();
    this.ro = undefined;
  }
  ignoreEvent() {
    return false; // clicks pass through so the cursor can enter → reveal raw
  }
}

// Splits a GFM table row into trimmed cell strings, dropping the leading/trailing
// pipe. (Escaped pipes are not handled — a v1 limitation.)
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1); // trailing bar, but not an escaped \|
  // #89 comment 886 (①): split on UNESCAPED `|` only. GFM escapes a literal pipe inside a cell as `\|`
  // (e.g. inside `code` or a URL); the old naive split("|") broke such a cell in two, dropping its code/link.
  // Unescape `\|` → `|` per cell so the content renders whole.
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; } // escaped pipe → literal
    if (s[i] === "|") { cells.push(cur); cur = ""; continue; }
    cur += s[i];
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}
const isDelimiterRow = (cells: string[]) => cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));

// Extract the destination from a markdown link source `[text](dest "title")` /
// `[text](<dest>)`, then sanitize it. Only http(s)/mailto and scheme-less (relative)
// URLs are allowed — javascript:/data:/vbscript: are rejected so a clickable link can
// never execute script (these run in the user's authenticated session).
function linkHref(src: string): string | null {
  const m = /\]\(\s*(<[^>]*>|[^)\s]+)/.exec(src);
  if (!m) return null;
  let u = m[1]!.trim();
  if (u.startsWith("<") && u.endsWith(">")) u = u.slice(1, -1);
  if (!u) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(u);
  if (scheme) {
    const s = scheme[1]!.toLowerCase();
    if (s !== "http" && s !== "https" && s !== "mailto") return null;
  }
  return u;
}

// Renders a GFM table block as an HTML <table>. Cells are set via textContent
// NEVER innerHTML — so user-authored content cannot inject markup (no XSS). This
// is display-only: it replaces the markdown range visually; the canonical Y.Text
// is unchanged, and putting the cursor in the table reveals the raw markdown.
class TableWidget extends WidgetType {
  private ro?: ResizeObserver;
  constructor(readonly source: string) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source;
  }
  toDOM(view: EditorView) {
    // #216 comment 836: wrap the table so a hover-revealed RichUI-entry button can sit at its top-left
    // (a <button> can't be a direct child of <table>). The wrap is the widget root + resize target.
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-lp-table";
    // #216 comment 820: a pipe table is Tier1 pure Markdown — a RAW editing layer, not (yet) a rich macro.
    // In LIVE, a click places the caret INTO the table so its rows reveal raw for per-row Markdown editing
    // (Open formats); the RichUI is an explicit OPT-IN via Ctrl+Enter (or the promotion hint on the #174
    // hover frame). Only WYSIWYG / other modes keep the direct openTableEditing entry (macro atom). Vim
    // already reveals raw on caret entry; this makes the mouse path match (no click→RichUI for pipe×Live).
    table.addEventListener("mousedown", (e) => {
      if (view.state.readOnly) return;
      if (view.state.facet(displayMode) === "live") {
        e.preventDefault();
        view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(wrap)) }); // caret in → reveal raw rows
        view.focus();
        return;
      }
      if (openTableEditing(view, view.posAtDOM(wrap))) e.preventDefault();
    });
    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");
    let inBody = false;
    for (const line of this.source.split("\n")) {
      if (!line.trim()) continue;
      const cells = splitTableRow(line);
      if (isDelimiterRow(cells)) { inBody = true; continue; } // the |---|---| separator
      const tr = document.createElement("tr");
      for (const c of cells) {
        const cell = document.createElement(inBody ? "td" : "th");
        // #89 comment 848: render the cell's INLINE markdown (**bold**, *em*, ~~s~~, `code`, [](url)) so the
        // NON-editing pipe table is WYSIWYG-consistent with the editing island and :::table — a pipe cell is
        // GFM and renders inline formatting. Shared allowlist-by-construction renderer (em/strong/s/code/a
        // only; raw <iframe>/<script> degrade to escaped text) — text+<br> nodes, never innerHTML (ADR-037).
        // A pipe table with inline decoration STAYS Tier1 pipe (Open formats): representableAsPipe is
        // unaffected by inline marks (only spans/style/complex-header/multiline promote to :::table).
        renderCellInline(cell, c);
        tr.appendChild(cell);
      }
      (inBody ? tbody : thead).appendChild(tr);
    }
    if (thead.childNodes.length) table.appendChild(thead);
    if (tbody.childNodes.length) table.appendChild(tbody);
    wrap.appendChild(table);
    // #216 comment 874: the RichUI-entry pill does NOT belong on the RENDERED table (a finished, non-edited
    // grid needs no entry affordance). It belongs on the RAW-EDITING state — when the caret is in the table
    // and the `| a | b |` source is visible. That pill is emitted by the reveal branch (TableRawRichuiPill),
    // not here. The rendered widget stays clean.
    // Height can shift after first measure (fonts, reflow, edit-mode chrome) → re-measure
    // so lines below a tall table don't drift (ADR-024 motion correctness — common path).
    this.ro = observeBlockResize(view, wrap);
    return wrap;
  }
  destroy() {
    this.ro?.disconnect();
    this.ro = undefined;
  }
  ignoreEvent() {
    return false; // let clicks through so the cursor can enter (→ reveal raw)
  }
}

// #216 comment 874 / #174 comment 878 (ADR-087 addendum 2): the SHARED RichUI-entry pill shown ON THE
// RAW-EDITING STATE of a macro in LIVE. When the caret is inside the macro its raw source is revealed — that
// is when a writer wants "you can promote this to the rich editor". The pill is BOTH the Ctrl+Enter key HINT
// (visible "Ctrl+↵" text, not a tooltip) AND a click target; click and Ctrl+Enter both reach the macro's
// `enter` thunk (openTableEditing for a pipe table → :::table; enterMacroAt for a callout → its editUI).
// ALWAYS visible (no hover gate — the hover-only version never showed on the reviewer's device, #216). Anchored
// to the first revealed line (cm-lp-macro-raw = position:relative) and floated just above it so it never covers
// the raw source. ONE implementation for table + callout (and later macros) so the affordance can't drift.
class MacroRawRichuiPill extends WidgetType {
  constructor(readonly pos: number, readonly enter: (view: EditorView, pos: number) => void, readonly testid: string) {
    super();
  }
  eq(o: MacroRawRichuiPill) {
    return o.pos === this.pos && o.enter === this.enter && o.testid === this.testid;
  }
  toDOM(view: EditorView) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-lp-macro-edit cm-lp-macro-richui-raw";
    btn.title = "Rich edit (Ctrl+Enter)";
    btn.innerHTML = MACRO_EDIT_ICON + '<span class="cm-lp-macro-richui-key">Ctrl+↵</span>';
    btn.setAttribute("data-testid", this.testid);
    // Own mousedown → open the RichUI; preventDefault so the caret isn't also re-placed, stopPropagation so it
    // does not bubble to the line. ignoreEvent keeps CM from routing the click as an editor gesture.
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.enter(view, this.pos);
    });
    return btn;
  }
  ignoreEvent() {
    return true;
  }
}
// The first revealed macro line becomes the pill's positioning context (position: relative).
const macroRawLead = Decoration.line({ attributes: { class: "cm-lp-macro-raw" } });

// #154 / ADR-025: in-editor WYSIWYG table editing. When a table block is render-active
// (macroRenderActiveField, set by a non-vim click/entry — openTableEditing), the table renders
// as a LIVE inline editor (tableInlineEditor) mounted on a host-managed island IN PLACE OF the
// static read-only widget or the old modal. The atom root is contenteditable=false + ignoreEvent
// (the ADR-054 focus-delegation guard, proven by the M1 spike): CM treats the block as atomic and
// does NOT reclaim the nested cell's focus, so the inline editor owns all interaction and commits
// via host.replaceSource (one offset-invariant Y.Text edit; the host auto-demotes pipe⟷:::table).
// eq is keyed on [from,to,source]: a commit rewrites the range → not eq. But instead of letting CM
// DESTROY + rebuild the widget on every commit (which, unlike the modal's stable overlay, flashes the
// grid through an unstyled frame → the multi-col RESIZE "jump" on release, #154 rebound), updateDOM
// re-renders the inline editor IN PLACE into the SAME dom (mirroring the modal's render). CM reuses
// the node, so a resize commit shows the committed widths without a re-mount transient. The controller
// + ResizeObserver live ON the dom so updateDOM/destroy can reach them across the widget's identity
// change. Offset-invariant — replace never shifts offsets.
interface TableDom extends HTMLDivElement { __tableCtrl?: InlineController; __tableRo?: ResizeObserver }
class EditableTableWidget extends WidgetType {
  constructor(readonly from: number, readonly to: number, readonly source: string) {
    super();
  }
  eq(o: EditableTableWidget) {
    return o.from === this.from && o.to === this.to && o.source === this.source;
  }
  private mountInto(dom: TableDom, view: EditorView) {
    dom.__tableCtrl?.destroy();
    dom.replaceChildren(); // clear the previous grid before mounting fresh (mount appends, doesn't clear)
    dom.__tableCtrl = tableInlineEditor.mount(dom, makeInnerEditHost(view, this.from, this.to, tableTier));
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div") as TableDom;
    // Atom root guard (ADR-054): contenteditable=false so CM keeps the block atomic and does NOT
    // reclaim the nested cell's focus. mount owns the className/testid + appends the editor DOM.
    wrap.contentEditable = "false";
    this.mountInto(wrap, view);
    wrap.__tableRo = observeBlockResize(view, wrap);
    return wrap;
  }
  // #154 rebound: re-render in place on a commit (source change) instead of a destroy+recreate — no
  // grid flash, so the resize preview == commit (no jump on release). The ResizeObserver on the same
  // node is kept. Returning true tells CM to reuse the dom.
  updateDOM(dom: HTMLElement, view: EditorView) {
    this.mountInto(dom as TableDom, view);
    return true;
  }
  destroy(dom: HTMLElement) {
    const d = dom as TableDom;
    d.__tableCtrl?.destroy();
    d.__tableCtrl = undefined;
    d.__tableRo?.disconnect();
    d.__tableRo = undefined;
  }
  ignoreEvent() {
    return true; // the inline editor owns interaction inside the island; CM must not process its events
  }
}

// #174 / ADR-087: compute the offset-invariant Y.Text change for an editUI `save(newBody)` — wrap the
// new body back into the block's fence, auto-demote to the lowest representable level (Open formats),
// and replace the block range. Pure (no view) → the inline save path is unit-testable. Immediate apply
// (inline ⇒ live Y.Text per ADR-087); the widget wires it into view.dispatch.
export function editUISaveChange(from: number, to: number, wrapSource: (body: string) => string, tier: MacroTier | undefined, newBody: string): { from: number; to: number; insert: string } {
  let src = asMacroSource(wrapSource(newBody));
  if (tier) src = autoDemote(tier, src);
  return { from, to, insert: src };
}

interface EditUIDom extends HTMLDivElement { __editUICtrl?: EditUIController; __editUIRo?: ResizeObserver }
// #174 / ADR-087: the generic inline editUI host. When a macro with `editUI.present === "inline"` is
// render-active, this mounts the macro's OWN editor (editUI.mount) into an atom-root island and wires
// `save(newBody)` → an immediate, offset-invariant Y.Text replace of the block (Open-formats tier
// demote). Mirrors EditableTableWidget but generic over any editUI macro; the host-API stays {theme} +
// save (ADR-024 narrow boundary — the macro never sees EditorView/Y.Text). Inert until a macro adopts
// editUI (no first-party macro does yet), so it adds no behaviour to shipped macros. Exported as the
// framework primitive the render-path wiring + first macro migration (next slice) will instantiate.
export class EditableEditUIWidget extends WidgetType {
  constructor(readonly from: number, readonly to: number, readonly source: string, readonly editUI: EditUI, readonly wrapSource: (body: string) => string, readonly theme: MacroTheme, readonly tier?: MacroTier) { super(); }
  eq(o: EditableEditUIWidget) { return o.from === this.from && o.to === this.to && o.source === this.source && o.editUI === this.editUI && o.theme === this.theme; }
  private mountInto(dom: EditUIDom, view: EditorView) {
    dom.__editUICtrl?.destroy();
    dom.replaceChildren();
    const save = (newBody: MacroSource) => {
      const ch = editUISaveChange(this.from, this.to, this.wrapSource, this.tier, newBody);
      view.dispatch({ changes: ch, effects: setMacroRenderActive.of({ from: ch.from, to: ch.from + ch.insert.length }) });
      view.focus();
    };
    dom.__editUICtrl = this.editUI.mount(dom, asMacroSource(this.source), { theme: this.theme }, save);
    // #239: re-add the Done affordance after each (re)mount — mountInto's replaceChildren above wipes it.
    const done = document.createElement("button");
    done.type = "button";
    done.className = "cm-lp-editui-done";
    done.textContent = "Done";
    done.setAttribute("data-testid", "editui-done");
    done.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); this.exit(dom, view); });
    dom.appendChild(done);
  }
  // #239: EXIT the editUI. ignoreEvent returns true so CM swallows widget-internal events — the
  // editor-level Escape (escExit) never fires, so a fence editUI (mermaid/plantuml: a plain textarea
  // with no exit of its own) was a TRAP (open → never back to the rendered diagram). Blur the focused
  // field first (fires the editUI's `change`→save, commit-on-blur), then clear render-active so the block
  // re-renders. Offset-invariant (only the edit-active effect; the save is the editUI's own).
  private exit(dom: EditUIDom, view: EditorView) {
    const focused = dom.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    focused?.blur();
    view.dispatch({ effects: setMacroRenderActive.of(null) });
    view.focus();
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div") as EditUIDom;
    wrap.className = "cm-lp-editui-wrap"; // position:relative anchors the Done button (#239)
    wrap.contentEditable = "false"; // atom root (ADR-054): CM keeps the block atomic, no focus reclaim
    this.mountInto(wrap, view);
    // Escape exits (the keyboard way out; the Done button is added per-mount in mountInto). On wrap so it
    // survives updateDOM's replaceChildren. Capture so it beats a textarea that might also read Escape.
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.exit(wrap, view); }
    }, true);
    wrap.__editUIRo = observeBlockResize(view, wrap);
    return wrap;
  }
  updateDOM(dom: HTMLElement, view: EditorView) { this.mountInto(dom as EditUIDom, view); return true; }
  destroy(dom: HTMLElement) { const d = dom as EditUIDom; d.__editUICtrl?.destroy(); d.__editUICtrl = undefined; d.__editUIRo?.disconnect(); d.__editUIRo = undefined; }
  ignoreEvent() { return true; }
}

// True if a folded range (CodeMirror's native folding) covers [from, to). When folded
// the macro renders nothing — CM's fold placeholder (the "▶ summary" line) owns the
// range. foldedRanges is safe-empty if the folding extension isn't installed.
function isFolded(state: EditorState, from: number, to: number): boolean {
  let folded = false;
  foldedRanges(state).between(from, to, () => { folded = true; });
  return folded;
}

// Renders a macro block (e.g. ```mermaid) via the registry's narrow liveRender, which
// returns display DOM only — no editor/doc/Yjs access (ADR-023 trust boundary). The
// macro never sees CodeMirror; this widget bridges its DOM into the live preview. On
// the editable surface a corner button collapses the block to the folded summary.
// Display-only / offset-invariant like every other block widget (ADR-008).
// A renderable macro = anything with a liveRender (fence macros, and block-form
// directive macros like :::table). foldable is fence-only (large data bodies).
type RenderableMacro = { liveRender: (body: string, ctx: { theme: MacroTheme }) => HTMLElement; richEditUI?: import("../macros/registry").RichEditUI; editUI?: import("../macros/registry").EditUI };
// #174 / ADR-087: the single macro-edit affordance is a Lucide SVG pencil (ADR-052 icon system),
// replacing the ✎ emoji. A trusted constant (no user input) → safe as innerHTML.
const MACRO_EDIT_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>';
// #198 (comment 724): Lucide copy / check glyphs for the code-fence copy button. Trusted constants
// (no user input) → safe as innerHTML.
const COPY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
// #213: structural editing for columns/tabs — add / remove a child :::column / :::tab as a real Y.Text
// edit (single dispatch, offset-invariant), NOT raw hand-editing. The child's colon count is one less
// than the container's (the outer≥inner convention), so an added item nests correctly under the
// stack resolver (#185). `directiveMacroAt` (resolver-backed) gives the live container range at the
// widget's position; `resolveDirectiveRanges` locates the child blocks for removal.
function containerChildColons(view: EditorView, d: { from: number }): string {
  const open = parseDirectiveOpen(view.state.doc.lineAt(d.from).text);
  return ":".repeat(Math.max(3, (open?.colons ?? 4) - 1));
}
function addLayoutItem(view: EditorView, pos: number, childName: "column" | "tab"): void {
  const d = directiveMacroAt(view.state, pos);
  if (!d || (d.name !== "columns" && d.name !== "tabs")) return;
  const colons = containerChildColons(view, d);
  const label = childName === "tab" ? "[Tab]" : "";
  const closeLine = view.state.doc.lineAt(Math.min(d.to, view.state.doc.length)); // the closing container fence line
  view.dispatch({ changes: { from: closeLine.from, insert: `${colons}${childName}${label}\n\n${colons}\n` }, userEvent: "input.insert", scrollIntoView: true });
}
function removeLastLayoutItem(view: EditorView, pos: number, childName: "column" | "tab"): void {
  const d = directiveMacroAt(view.state, pos);
  if (!d) return;
  const items = resolveDirectiveRanges(view.state.doc.toString()).filter((r) => r.name === childName && r.from >= d.from && r.to <= d.to);
  if (items.length <= 1) return; // never remove the last remaining item (an empty container is degenerate)
  const last = items[items.length - 1]!;
  const fromLine = view.state.doc.lineAt(last.from);
  const toLine = view.state.doc.lineAt(Math.min(last.to, view.state.doc.length));
  view.dispatch({ changes: { from: fromLine.from, to: Math.min(toLine.to + 1, view.state.doc.length) }, userEvent: "delete" });
}

// #255: rewrite a rendered diagram fence's horizontal alignment by setting its `align=` attribute (CENTER
// is the default → the attribute is DROPPED, so an existing untagged block stays untagged). Resolves the
// fence at `pos` via macroFenceAt (posAtDOM lands on the closing ``` for a block atom, so we can't trust the
// raw position). One offset-invariant Y.Text replace of the OPENING fence line — round-trips with title/
// highlight (serializeFenceInfo is order-stable). Only diagram fences carry align (guarded by the caller).
export function setDiagramAlign(view: EditorView, pos: number, align: FenceAlign): void {
  const f = macroFenceAt(view.state, pos);
  if (!f) return;
  const line = view.state.doc.lineAt(f.from);
  const m = /^(\s*)([`~]{3,})(.*)$/.exec(line.text);
  if (!m) return;
  const info = parseFenceInfo(m[3]!);
  if (!DIAGRAM_MACROS.has(info.lang)) return;
  info.align = align;
  const next = `${m[1]}${m[2]}${serializeFenceInfo(info)}`;
  if (next === line.text) return;
  view.dispatch({ changes: { from: line.from, to: line.to, insert: next }, userEvent: "input" });
}
// #255: the diagram fence at `pos` (its opening-line offset) if it's a rendered diagram macro, else null
// so the context menu can offer alignment only where it applies.
export function diagramFenceAt(state: EditorState, pos: number): number | null {
  const f = macroFenceAt(state, pos);
  return f && DIAGRAM_MACROS.has(f.lang) ? f.from : null;
}
// #255: align glyphs (three stacked bars, justified per side) — trusted constant SVGs (no user input).
const ALIGN_ICON: Record<FenceAlign, string> = {
  left: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h13M3 12h18M3 18h13"/></svg>',
  center: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6h12M3 12h18M6 18h12"/></svg>',
  right: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 6h13M3 12h18M8 18h13"/></svg>',
};

// #215 / ADR-100: nested-macro parity. Four consumers (select / edit / render / delete) key off ONE
// question — "what is the innermost macro at this interaction point?" — so a click selects exactly what
// the edit button opens and Backspace/dd/Delete removes. `resolveNestedAnchor` is input-device-independent
// (takes a DOM element, so a future touch handler feeds elementFromPoint); `closest('[data-mac-pos]')`
// returns the INNERMOST tagged ancestor (DOM nesting mirrors macro nesting), so innermost-wins is by
// construction. `innermostMacroAt` re-resolves the LIVE range from the anchor (drift-tolerant — never
// trusts the tag arithmetic for the edit), mirroring changeEmbedTarget's re-resolve discipline.
export function resolveNestedAnchor(target: EventTarget | null): number | null {
  const el = (target as HTMLElement | null)?.closest?.("[data-mac-pos]") as HTMLElement | null;
  if (!el) return null;
  const v = Number(el.dataset.macPos);
  return Number.isFinite(v) ? v : null;
}
export type InnerMacro = { from: number; to: number; kind: "fence" | "directive"; name: string };
export function innermostMacroAt(state: EditorState, anchor: number): InnerMacro | null {
  const t = tableBlockAt(state, anchor); if (t && directiveMacroAt(state, anchor)?.name === "table") return { from: t.from, to: t.to, kind: "directive", name: "table" };
  const f = macroFenceAt(state, anchor); if (f) return { from: f.from, to: f.to, kind: "fence", name: f.lang };
  const d = directiveMacroAt(state, anchor); if (d) return { from: d.from, to: d.to, kind: "directive", name: d.name };
  return null;
}
// #215 (Consumer 4): one offset-invariant range covering the innermost macro's whole lines (open/close
// fence incl.) plus one trailing separator line — the SAME range for Backspace, Delete, and vim dd, so
// they can't drift (decision 788). Container + siblings untouched (a plain Y.Text delete).
export function nestedDeleteChange(state: EditorState, anchor: number): { from: number; to: number } | null {
  const m = innermostMacroAt(state, anchor);
  if (!m) return null;
  const doc = state.doc;
  const fromLine = doc.lineAt(m.from);
  const toLine = doc.lineAt(Math.min(m.to, doc.length));
  return { from: fromLine.from, to: Math.min(toLine.to + 1, doc.length) };
}
// #215 (Consumer 2): open the selected nested macro's own editUI in place (sets the nested-edit field;
// the container widget re-renders and swaps just that subtree for its editUI island). A nested
// richEditUI:modal macro (Excalidraw) opens its modal instead. Returns false if the anchor resolves to
// no macro (e.g. structural click).
export function enterNestedMacroAt(view: EditorView, sel: NestedSelection): boolean {
  if (view.state.readOnly) return false;
  const m = innermostMacroAt(view.state, sel.anchor);
  if (!m) return false;
  if (m.kind === "fence") {
    const fence = macroFenceAt(view.state, sel.anchor);
    if (fence?.macro.richEditUI?.present === "modal") { openMacroModal(view, fence.macro, () => fence.from, currentMacroTheme()); return true; }
  }
  view.dispatch({ effects: setNestedEditActive.of({ nested: { from: m.from, to: m.to }, anchor: sel.anchor, container: sel.container }) });
  view.focus();
  return true;
}

// #215 (Consumer 2): mount the innermost nested macro's editUI into `slot` (the tagged subtree), replacing
// its rendered form in place — keeping the flex layout (Option B(i)). Save = one offset-invariant Y.Text
// replace of the macro's range (the same editUISaveChange / makeInnerEditHost the top-level path uses), so
// single Y.Text is preserved and the macro never sees the EditorView. Source-scope mirrors the top-level
// Directive renderer: a callout owns its whole `:::type[label]…:::` block (identity wrap); columns/tabs/
// fence macros own their inner body (fence-reconstruction wrap). Returns true if an island mounted.
function mountNestedEditIsland(view: EditorView, slot: HTMLElement, sel: NestedSelection): boolean {
  const state = view.state;
  const m = innermostMacroAt(state, sel.anchor);
  if (!m) return false;
  const doc = state.doc;
  const to = Math.min(m.to, doc.length);
  const host = document.createElement("div");
  host.className = "cm-lp-nested-edit-island";
  host.setAttribute("data-testid", "nested-edit-island");
  const clearAndRender = () => { view.dispatch({ effects: setNestedEditActive.of(null) }); view.focus(); };
  if (m.kind === "directive") {
    const macro = findDirectiveMacro(m.name) ?? noteCalloutMacro;
    if (macro.richEditUI?.present === "inline") { // :::table → in-editor WYSIWYG grid
      const hostApi = makeInnerEditHost(view, m.from, to, tableTier);
      const ctrl = tableInlineEditor.mount(host, hostApi);
      host.querySelector('[data-testid="table-done"]')?.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); ctrl.destroy(); clearAndRender(); });
      slot.replaceWith(host);
      return true;
    }
    if (macro.editUI?.present === "inline") {
      // A callout owns its WHOLE block (so its editUI can change type/label) → full source + identity wrap.
      // columns/tabs own their inner body → the lines between the fences, re-wrapped with the verbatim open
      // fence (colon count + [label] preserved) so a 4-colon `::::columns` round-trips (the #185 convention).
      const isCallout = !!macro.containerClass;
      const first = doc.lineAt(m.from);
      const last = doc.lineAt(Math.min(m.to, doc.length) - 1);
      const openLine = first.text;
      const closeMark = openLine.match(/^\s*([`~:]+)/)?.[1] ?? ":::";
      const bodyLines: string[] = [];
      for (let n = first.number + 1; n < last.number; n++) bodyLines.push(doc.line(n).text);
      const source = isCallout ? doc.sliceString(m.from, to) : bodyLines.join("\n");
      const wrap = isCallout ? (b: string) => b : (b: string) => `${openLine}\n${b}\n${closeMark}`;
      const save = (newBody: MacroSource) => {
        view.dispatch({ changes: editUISaveChange(m.from, to, wrap, macro.tier, newBody) });
        view.focus();
      };
      macro.editUI.mount(host, asMacroSource(source), { theme: currentMacroTheme() }, save);
      slot.replaceWith(host);
      return true;
    }
  }
  // Fence macro (mermaid/plantuml) OR any macro without an in-place editUI: a generic raw-source panel
  // over its range (ADR-100 open question — a nested ``` macro has no bespoke in-place surface in v1).
  const src = doc.sliceString(m.from, to);
  const ta = document.createElement("textarea");
  ta.className = "cm-lp-nested-edit-src";
  ta.setAttribute("data-testid", "nested-edit-src");
  ta.value = src;
  ta.spellcheck = false;
  ta.addEventListener("mousedown", (e) => e.stopPropagation());
  ta.addEventListener("change", () => { view.dispatch({ changes: { from: m.from, to, insert: ta.value } }); view.focus(); });
  host.appendChild(ta);
  slot.replaceWith(host);
  return true;
}

// #215: locate the tagged subtree for a given anchor inside a rendered widget (exact match; the widget
// re-renders from the live doc so tags and the mapped anchor stay in lock-step).
function findNestedSlot(root: HTMLElement, anchor: number): HTMLElement | null {
  return root.querySelector(`[data-mac-pos="${anchor}"]`);
}

// #221: fields stashed on the widget's DOM so updateDOM can reuse it on a selection-only change (see
// MacroWidget.updateDOM). __mwKey is the rendered-content identity; __mwRo/__mwObjUrl are the async
// resources whose ownership must travel with the DOM so the current instance's destroy releases them.
type MwDom = HTMLElement & { __mwKey?: { body: string; theme: MacroTheme; name: string; foldable: boolean; align: FenceAlign; wysiwyg: boolean }; __mwRo?: ResizeObserver; __mwObjUrl?: string };

class MacroWidget extends WidgetType {
  private ro?: ResizeObserver;
  private objectUrl?: string; // #140: revoked on destroy so the rendered image blob isn't leaked
  private destroyed = false; // guards the async render swap against a widget torn down mid-fetch
  // #215 / ADR-100: `from`/`bodyFrom` are the container's absolute range start + inner-body start (so the
  // top-level columns/tabs render tags its nested macros via pendingBaseOffset). `nestedSel`/`nestedEdit`
  // are the display-only selection / edit-active state intersecting THIS widget (null otherwise), driving
  // the nested ring + edit button + editUI island. Stable string keys in eq so an unrelated selection
  // move never churns this widget (the project design notes "widget eq ").
  constructor(readonly macro: RenderableMacro, readonly body: string, readonly foldable: boolean, readonly name: string, readonly selected: boolean, readonly theme: MacroTheme, readonly from = 0, readonly to = 0, readonly bodyFrom = 0, readonly nestedSel: NestedSelection | null = null, readonly nestedEdit: NestedSelection | null = null, readonly align: FenceAlign = "center", readonly wysiwyg = false) {
    super();
  }
  private nestedKey(v: NestedSelection | null) { return v ? `${v.nested.from}:${v.nested.to}:${v.anchor}` : ""; }
  eq(other: MacroWidget) {
    // Compare by `name` (the registry key), NOT the `macro` object: the directive renderer
    // passes a FRESH { liveRender, richEditUI } literal every render, so a `macro` identity
    // check is ALWAYS false → CM would recreate the :::table widget on every update (each
    // j/k). That DOM churn re-measures the table async while vim computes motion sync from
    // the previous (stale) geometry → persistent 1-line drift below the table. `name` is
    // stable per macro, so the widget is reused and its geometry/ResizeObserver settle.
    // #200: `theme` is part of the key so a light/dark switch INVALIDATES the widget and CM
    // rebuilds it → liveRender re-runs and re-exports the SVG for the new theme (a macro like
    // Excalidraw bakes colours into its output, so it can't follow the theme via CSS alone).
    return other.name === this.name && other.body === this.body && other.foldable === this.foldable && other.selected === this.selected && other.theme === this.theme && other.align === this.align && other.wysiwyg === this.wysiwyg
      && this.nestedKey(other.nestedSel) === this.nestedKey(this.nestedSel) && this.nestedKey(other.nestedEdit) === this.nestedKey(this.nestedEdit);
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-macro-wrap";
    // #255: a rendered DIAGRAM macro (mermaid/plantuml/excalidraw) is centred by DEFAULT (align="center")
    // and can be pushed left/right via the fence `align=` attribute. Only diagrams align (text macros
    // callout/table/columns — are unaffected). The class drives `text-align` on the wrap (below).
    if (DIAGRAM_MACROS.has(this.name)) wrap.classList.add(`cm-lp-align-${this.align}`);
    // ADR-024: the caret resting ON the atom selects it (no separate key) — a ring shows
    // it's selected as a unit (dd/yy operate on it; Ctrl+Enter enters).
    // #215 comment 813/817: when a NESTED macro is selected the caret sits on THIS container (so
    // `selected` is true), but the FOCUS is the inner macro. Show the container as an achromatic
    // CONTEXT highlight (grey) so the accent ring on the inner nested subtree reads as the focus
    // two-level highlight (outer = context, inner = focus) makes the nesting depth legible at a glance.
    const nestedActive = !!(this.nestedSel || this.nestedEdit);
    if (nestedActive) wrap.classList.add("cm-lp-nested-host");
    else if (this.selected) wrap.classList.add("cm-lp-atom-sel");
    // #3: an empty macro renders NOTHING from some liveRenders (e.g. mermaid) → it looks
    // like blank space even though a block widget occupies it (so vertical caret motion
    // "jumps" past invisible content). Render a common, visible placeholder for ALL macros
    // when the body is empty, so the block is obviously present and obviously editable.
    if (this.body.trim() === "") {
      const ph = document.createElement("div");
      ph.className = "cm-lp-macro cm-lp-macro-empty";
      ph.setAttribute("data-testid", "macro-empty");
      // #174 / ADR-087: the empty-macro affordance matches how the macro is actually edited
      // "inline" macros (table/callout/mermaid) edit in place on click, "modal" ones (Excalidraw)
      // open a separate editor. editModeOf is the single source of truth for that branch.
      const opens = editModeOf(this.macro) === "modal";
      ph.textContent = `Empty ${this.name} — click to ${opens ? "open" : "edit"}`;
      wrap.appendChild(ph);
    } else {
      // #215 / ADR-100: for the layout containers, hand the inner-body base offset to the liveRender so its
      // nested macros tag themselves (data-mac-pos) for the hit-test. Consumed by columns/tabs liveRender;
      // reset immediately after so it never leaks to another macro's render.
      const isLayout = this.name === "columns" || this.name === "tabs";
      if (isLayout) setPendingBaseOffset(this.bodyFrom);
      const rendered = this.macro.liveRender(this.body, { theme: this.theme }); // #200: the widget's built theme (eq() rebuilds on a switch), not a live DOM read
      if (isLayout) setPendingBaseOffset(null);
      wrap.appendChild(rendered);
      // #215 / ADR-100 (Consumers 1 & 2): draw the nested-macro ring + edit button on the selected nested
      // subtree, or swap it for its editUI island when nested-edit is active. Only for layout containers,
      // only when this widget's range actually holds the selection (nestedSel/nestedEdit already intersect).
      if (isLayout && !view.state.readOnly) {
        if (this.nestedEdit) {
          const slot = findNestedSlot(rendered, this.nestedEdit.anchor);
          if (slot) mountNestedEditIsland(view, slot, this.nestedEdit);
        } else if (this.nestedSel) {
          const slot = findNestedSlot(rendered, this.nestedSel.anchor);
          if (slot) {
            slot.classList.add("cm-lp-nested-sel");
            slot.style.position = "relative"; // #215 813: guarantee the slot is the button's offset parent
                                              // (a CSS class alone lost to a positioned ancestor at depth 3,
                                              // pinning the pencil to the tabs top instead of the inner macro)
            const edit = document.createElement("button");
            edit.type = "button";
            edit.className = "cm-lp-macro-edit cm-lp-nested-macro-edit";
            edit.title = "Edit";
            edit.innerHTML = MACRO_EDIT_ICON;
            edit.setAttribute("data-testid", "nested-macro-edit");
            edit.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); enterNestedMacroAt(view, this.nestedSel!); });
            slot.appendChild(edit);
          }
        }
        // #174 comment 1003 / ADR-100 (WYSIWYG nested parity): in WYSIWYG the raw syntax NEVER reveals, so a
        // nested macro inside a layout container had NO way into its editUI — a top-level callout got a hover
        // ✎ (comment 894) but the nested equivalent was missing (nested edit was click-to-select only, which
        // leans on a reveal path WYSIWYG lacks). Give every EDITABLE nested slot the same hover-gated ✎ (→ its
        // editUI via enterNestedMacroAt), matching the top-level panel. WYSIWYG-only: Live keeps click-to-
        // select → pencil (its reveal path already reaches the editUI). Skip the slot already carrying the
        // selection/edit affordance (single pencil). Offset-invariant — the button never edits the doc.
        if (this.wysiwyg) {
          const activeAnchor = this.nestedEdit?.anchor ?? this.nestedSel?.anchor ?? null;
          for (const slot of Array.from(rendered.querySelectorAll<HTMLElement>("[data-mac-pos]"))) {
            const anchor = Number(slot.dataset.macPos);
            if (!Number.isFinite(anchor) || anchor === activeAnchor) continue;
            const m = innermostMacroAt(view.state, anchor);
            if (!m) continue;
            // Callout TYPE names (warning/note/…) aren't registered individually — they resolve to the single
            // noteCalloutMacro (as mountNestedEditIsland does); so fall back for a known callout type.
            const macro = m.kind === "fence"
              ? findFenceMacro(m.name)
              : (findDirectiveMacro(m.name) ?? (CALLOUT_TYPES.includes(m.name as (typeof CALLOUT_TYPES)[number]) ? noteCalloutMacro : undefined));
            if (!macro || !hasEditUI(macro)) continue;
            slot.style.position = "relative"; // offset parent for the absolutely-positioned pencil
            const edit = document.createElement("button");
            edit.type = "button";
            // Hover-gated variant (the base .cm-lp-nested-macro-edit is opacity:1 — only drawn on selection);
            // -hover overrides to opacity:0 + reveals on the slot's :hover (CSS below).
            edit.className = "cm-lp-macro-edit cm-lp-nested-macro-edit cm-lp-nested-macro-edit-hover";
            edit.title = "Edit";
            edit.innerHTML = MACRO_EDIT_ICON; // no Ctrl+↵ hint: keyboard entry needs the macro SELECTED first
            edit.setAttribute("data-testid", "nested-macro-edit");
            const container = { from: this.from, to: this.to };
            edit.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); enterNestedMacroAt(view, { nested: { from: m.from, to: m.to }, anchor, container }); });
            slot.appendChild(edit);
          }
        }
      }
      // #140 / ADR-074: host-mediated render. The macro returned its degrade DOM (the source fence);
      // for a host-renderable lang (plantuml) ask the injected renderer for image bytes and, on
      // success, swap the source for the image. null (unconfigured / failure / non-viewer 403) keeps
      // the source — Open formats, never a broken embed. Fires ONCE per widget instance (eq reuses
      // the widget while name+body are stable, so there's no churn / re-fetch on every keystroke).
      const renderDiagram = view.state.facet(diagramRenderer);
      if (HOST_RENDERABLE.has(this.name) && renderDiagram !== noopDiagramRenderer) {
        void renderDiagram(this.name, this.body).then((blob) => {
          if (this.destroyed || !blob) return; // torn down mid-fetch, or degrade → leave the source
          this.objectUrl = URL.createObjectURL(blob);
          (wrap as MwDom).__mwObjUrl = this.objectUrl; // #221: travel with the DOM for updateDOM reuse

          const img = document.createElement("img");
          img.className = "cm-lp-macro-rendered";
          img.alt = `${this.name} diagram`;
          img.setAttribute("data-testid", `macro-${this.name}-rendered`);
          img.src = this.objectUrl;
          rendered.replaceChildren(img); // the outer macro div (class/testid) stays; inner source → image
        });
      }
      // #108 / ADR-071: host-mediated transclude. The macro can't fetch (narrow host-API); the host
      // resolves the referenced page's markdown (authz re-checked server-side on the REF page) and
      // renders it in place, or an existence-hiding placeholder (null = denied/cycle/absent — all
      // indistinguishable). Fires once per widget instance (eq stable on name+body).
      const resolveTransclude = view.state.facet(transcludeResolver);
      if (this.name === "embed-page" && resolveTransclude !== noopTranscludeResolver) { // #205: `:::embed-page` (was transclude)
        void resolveTransclude(this.body).then((content) => {
          if (this.destroyed) return;
          rendered.replaceChildren();
          if (content == null) {
            const ph = document.createElement("div");
            ph.className = "cm-lp-embed-page-denied";
            ph.setAttribute("data-testid", "macro-embed-page-denied");
            ph.textContent = "Cannot display this content"; // uniform — hides whether the page exists
            rendered.appendChild(ph);
          } else {
            rendered.appendChild(renderMarkdownToDom(content)); // sanitized DOM (no innerHTML)
          }
        });
      }
      // #108 / ADR-071 (comment 551): host-mediated external embed. The macro can't read the allowlist
      // (narrow host-API); the host checks the URL against the injected tenant allowlist and renders a
      // sandboxed iframe for an allowlisted https host, else a degrade link (Open formats). Synchronous
      // (client-direct iframe — no server proxy/fetch, so no SSRF surface on this path).
      if (this.name === "embed-external" && this.body.trim() !== "") {
        rendered.replaceChildren(buildEmbedElement(this.body, view.state.facet(embedAllowlist)));
      }
    }
    if (!view.state.readOnly) {
      // ADR-087 (unified editUI model) / #84 comment 696: a body click SELECTS the atom (caret → ring);
      // the rich UI opens only via the ✎ edit button / Ctrl+Enter. A stray click must NOT launch an
      // editor — otherwise Excalidraw pops a modal on a mis-click AND the click swallows the grip so drag
      // can't start. This holds for macros with the unified editUI (mermaid/callout) and for modal macros
      // (Excalidraw). EXCEPTION: a legacy richEditUI macro (table via InnerEditHost, #154) keeps its
      // in-place click-to-edit — its cell-edit UX depends on the body click and is not an editUI atom yet.
      const clickEdits = !this.macro.editUI && editModeOf(this.macro) === "inline"; // table (#154) only
      const isLayout = this.name === "columns" || this.name === "tabs";
      wrap.addEventListener("mousedown", (e) => {
        e.preventDefault();
        // #215 / ADR-100 (Consumer 1): a click on a NESTED macro selects THAT macro (ring), not the
        // container. resolveNestedAnchor(e.target) → innermost tagged subtree; the caret stays on the
        // container atom (posAtDOM(wrap)) since the interior isn't caret-addressable, and the display-only
        // field carries the selection. A click on the container's own structure (no data-mac-pos) clears
        // any nested selection and selects the whole container (ADR-100 §1).
        if (isLayout) {
          const anchor = resolveNestedAnchor(e.target);
          if (anchor != null) {
            const m = innermostMacroAt(view.state, anchor);
            if (m) {
              view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(wrap)), effects: setNestedSelection.of({ nested: { from: m.from, to: m.to }, anchor, container: { from: this.from, to: this.to } }) });
              view.focus();
              return;
            }
          }
          if (view.state.field(nestedSelectionField, false)) { view.dispatch({ effects: setNestedSelection.of(null) }); }
        }
        if (clickEdits && enterMacroAt(view, view.posAtDOM(wrap))) return;
        view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(wrap)) });
        view.focus();
      });
      // #174 / ADR-087: an explicit EDIT button — the visible affordance for the block's rich UI. It
      // appears on mouse hover AND when the atom is SELECTED (caret-entry, cm-lp-atom-sel), so a vim/
      // keyboard user can SEE how to reach the table/columns/tabs rich UI (same target as a click or
      // Ctrl+Enter → enterMacroAt). Only for macros that HAVE a rich UI — the unified editUI OR the
      // legacy richEditUI (hasEditUI, migration-safe per #174). Offset-invariant (never edits).
      // #215 comment 813: while a NESTED macro is selected, suppress the CONTAINER's own edit button so
      // the only pencil on screen is the nested one (drawn adjacent to the inner macro below) — otherwise
      // two pencils (container top-left + inner) are ambiguous about which macro they edit.
      if (hasEditUI(this.macro) && !nestedActive) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "cm-lp-macro-edit";
        edit.title = "Edit";
        // #174 / ADR-087: a Lucide SVG pencil (not the ✎ emoji — ADR-052 icon system), top-left, shown
        // on hover/selection. innerHTML of a trusted constant SVG (no user input → XSS-safe).
        edit.innerHTML = MACRO_EDIT_ICON;
        // #174 comment 911: unify the "✎ Ctrl+↵" affordance across macros — show the SAME visible
        // Ctrl+↵ key hint (as the callout/table raw-lead pill) next to the pencil, but ONLY when
        // Ctrl+Enter opens the SAME UI the pencil does. That holds for a richEditUI macro (excalidraw's
        // modal / a rich grid: Ctrl+Enter and ✎ both open it). It does NOT hold for an editUI-only fence
        // macro (mermaid/plantuml), whose Ctrl+Enter reveals RAW source, not the editUI — so no hint there
        // (it would mislead; that asymmetry + their editUI bug is #239).
        if (this.macro.richEditUI) {
          edit.innerHTML += '<span class="cm-lp-macro-richui-key">Ctrl+↵</span>';
          // #254: use the LAYOUT-only hint class (gap for the key), NOT cm-lp-macro-richui-raw — that class
          // forces opacity:0.8 (always visible), which is only correct for the RAW-editing pill
          // (MacroRawRichuiPill). On a RENDERED macro the ✎ must stay hover/selection-gated (base opacity:0
          // + the .cm-lp-macro-wrap:hover / .cm-lp-atom-sel gate), or it shows with no hover/selection.
          edit.classList.add("cm-lp-macro-edit-hint");
        }
        edit.setAttribute("data-testid", "macro-edit");
        edit.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          enterMacroAt(view, view.posAtDOM(wrap));
        });
        wrap.appendChild(edit);
      }
      // #255: a rendered DIAGRAM macro gets an ALIGN toggle just right of the ✎ — one click cycles
      // center → left → right, rewriting the fence `align=` attribute (center drops the attr). Same
      // hover/selection gating as ✎ (CSS). Suppressed while a nested macro is selected (no diagram nests
      // in a layout child in v1, but keep the single-pencil rule). Right-click also offers align (below).
      if (DIAGRAM_MACROS.has(this.name) && !nestedActive) {
        const alignBtn = document.createElement("button");
        alignBtn.type = "button";
        alignBtn.className = "cm-lp-macro-align";
        alignBtn.title = `Align: ${this.align}`;
        alignBtn.innerHTML = ALIGN_ICON[this.align];
        alignBtn.setAttribute("data-testid", "macro-align");
        alignBtn.setAttribute("data-align", this.align);
        alignBtn.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const next: FenceAlign = this.align === "center" ? "left" : this.align === "left" ? "right" : "center";
          setDiagramAlign(view, view.posAtDOM(wrap), next);
        });
        wrap.appendChild(alignBtn);
      }
      // #213: columns/tabs get structural add/remove — a `+` appends a child :::column/:::tab and a `−`
      // removes the last one (real Y.Text edits via addLayoutItem/removeLastLayoutItem). Shown on hover/
      // selection (a hover row at the bottom-right, off the widget content). This is the structural-edit
      // affordance the ADR-087 editUI framework generalises; here it's wired directly for the two layout
      // containers whose child count is otherwise only editable by hand-typing the raw fences.
      if (this.name === "columns" || this.name === "tabs") {
        const child = this.name === "columns" ? "column" : "tab";
        const row = document.createElement("div");
        row.className = "cm-lp-macro-layoutbar";
        const mk = (glyph: string, label: string, fn: () => void, testid: string) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "cm-lp-macro-layoutbtn";
          b.textContent = glyph;
          b.title = label;
          b.setAttribute("data-testid", testid);
          b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
          return b;
        };
        row.appendChild(mk("＋", `Add ${child}`, () => addLayoutItem(view, view.posAtDOM(wrap), child), `layout-add-${child}`));
        row.appendChild(mk("－", `Remove ${child}`, () => removeLastLayoutItem(view, view.posAtDOM(wrap), child), `layout-remove-${child}`));
        wrap.appendChild(row);
      }
      // #210 / ADR-087: embed macros have no rich UI, but their TARGET (page id / URL) must be
      // changeable after insertion — otherwise a mis-picked embed strands the user in raw editing.
      // This is the first per-macro action in the ADR-087 block menu: a ⇆ button that re-opens the
      // same picker (embed-page) / prompts a URL (embed-external) and writes the choice back. Shows on
      // hover / selection (same as ✎). Offset-invariant here — the write happens in changeEmbedTarget.
      if (this.name === "embed-page" || this.name === "embed-external") {
        const retarget = document.createElement("button");
        retarget.type = "button";
        // #210 bounce: was `cm-lp-macro-edit` (left:4px) — it overlapped the edit button's slot AND sat
        // under the embed's own content (an embed-external <iframe> is a stacking context + a pointer-
        // event sink, so a same-plane button never received the click). Give it its OWN class: top-RIGHT
        // corner (embeds have no fold button there) + a z-index above the rendered embed content, and use
        // `click` (fires reliably even when a child iframe swallows earlier pointer phases).
        retarget.className = "cm-lp-macro-retarget";
        retarget.title = "Change embed target";
        retarget.textContent = "⇆";
        retarget.setAttribute("data-testid", "embed-change-target");
        // mousedown only PREVENTS the caret/fall-through (don't open here); `click` does the action, so
        // it can't double-fire, and click lands even when an intervening pointer phase is swallowed.
        retarget.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        retarget.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); changeEmbedTarget(view, wrap, this.name); });
        wrap.appendChild(retarget);
      }
      // #174 comment 911: the ⊟ collapse BUTTON is removed from every macro (it cluttered the block
      // affordances and duplicated fold). vim fold (zc / foldEffect) is a SEPARATE mechanism and stays.
    }
    // mermaid & Excalidraw mount their SVG ASYNCHRONOUSLY → the widget grows after CM
    // measured it short → lines below drift. Re-measure on resize (common path, shared with
    // every other block widget).
    this.ro = observeBlockResize(view, wrap);
    // #221 comment 845: keep enough on the DOM for updateDOM to reuse it on a SELECTION-only change
    // (identity of the rendered content + the live ResizeObserver, so destroy still disconnects it).
    (wrap as MwDom).__mwKey = { body: this.body, theme: this.theme, name: this.name, foldable: this.foldable, align: this.align, wysiwyg: this.wysiwyg };
    (wrap as MwDom).__mwRo = this.ro;
    return wrap;
  }
  // #221 comment 845: a SELECTION-only change (the caret LANDING ON / passing over the atom toggles
  // `selected`) must NOT rebuild the widget — recreating it re-runs liveRender and re-mounts the rendered
  // content (a mermaid SVG / a plantuml image), which flickers and wobbles the height. eq excludes truly
  // equal widgets; this handles the not-equal-but-cheap case: when only `selected` differs (content, theme,
  // name, foldable identical AND no nested container affordance), reuse the DOM and just toggle the ring
  // class. Any content/theme change, or a nested ring/island, returns false so CM rebuilds via toDOM.
  updateDOM(dom: HTMLElement): boolean {
    const prev = (dom as MwDom).__mwKey;
    const nestedNow = !!(this.nestedSel || this.nestedEdit);
    const nestedBefore = dom.classList.contains("cm-lp-nested-host");
    if (!prev || prev.body !== this.body || prev.theme !== this.theme || prev.name !== this.name || prev.foldable !== this.foldable || prev.align !== this.align || prev.wysiwyg !== this.wysiwyg || nestedNow || nestedBefore) {
      return false; // content / theme / nested affordance / #255 align / #174 wysiwyg nested-✎ changed → rebuild via toDOM
    }
    this.ro = (dom as MwDom).__mwRo; // adopt the live ResizeObserver so this instance's destroy() disconnects it
    this.objectUrl = (dom as MwDom).__mwObjUrl; // adopt any host-rendered blob url so destroy() revokes it
    dom.classList.toggle("cm-lp-atom-sel", this.selected); // selection ring only — the rendered content stays
    return true;
  }
  destroy() {
    this.destroyed = true;
    if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = undefined; }
    this.ro?.disconnect();
    this.ro = undefined;
  }
  ignoreEvent() {
    return false; // clicks pass through so the cursor can enter → reveal raw
  }
}

// #90 details: the collapsed state — a single "▸ summary" bar replacing the whole block. Caret-in
// (click / motion) reveals the raw source (enterMacroAt). Display-only; no doc/offset/presence.
class DetailsSummaryWidget extends WidgetType {
  constructor(readonly summary: string) { super(); }
  eq(o: DetailsSummaryWidget) { return o.summary === this.summary; }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-lp-details-summary";
    el.setAttribute("data-testid", "macro-details");
    el.textContent = `▸ ${this.summary}`; // textContent — never innerHTML
    if (!view.state.readOnly) {
      el.addEventListener("mousedown", (e) => { e.preventDefault(); enterMacroAt(view, view.posAtDOM(el)); view.focus(); });
    }
    return el;
  }
  ignoreEvent() { return false; }
}

// #170 / ADR-049 (Y): a typed callout renders as a single-container PANEL widget (enter-to-edit,
// like columns/tabs/details) INSTEAD of the old always-inline per-line box. Caret-out → this panel
// (icon large + vertically centred, variant title, nested Markdown body — the shared renderCalloutPanel
// so the CM widget and nested renderer never drift); caret-in → the raw `:::` source (reveal-on-cursor,
// per-line boxes below). Display-only / offset-invariant; a click enters (enterMacroAt → reveal raw).
// #174 / ADR-087 (Class 1 — direct-click metadata): change a callout's TYPE by rewriting the directive name
// on its OPEN line, keeping the colon run, `[label]`, and body. One offset-invariant Y.Text edit on just the
// name run (single Y.Text). blockStart is the widget's doc offset (its open line).
function changeCalloutTypeAt(view: EditorView, blockStart: number, newType: string): void {
  const line = view.state.doc.lineAt(blockStart);
  const m = line.text.match(/^(\s*:{3,}\s*)(\w+)/); // colon run + directive name
  if (!m) return;
  const nameFrom = line.from + m[1]!.length;
  const nameTo = nameFrom + m[2]!.length;
  view.dispatch({ changes: { from: nameFrom, to: nameTo, insert: newType } });
  view.focus();
}

// #174 / ADR-087 (Class 1): a small type-picker opened by clicking the callout's icon badge — the direct,
// per-element metadata edit (faster than opening the whole editUI panel). Floating menu of the callout
// types; picking one rewrites the directive name in place. Dismiss on outside pointerdown / Escape.
function openCalloutTypeMenu(view: EditorView, anchor: HTMLElement, blockStart: number): void {
  document.querySelector(".cm-lp-callout-type-menu")?.remove(); // only one at a time
  const menu = document.createElement("div");
  menu.className = "cm-lp-callout-type-menu";
  menu.setAttribute("data-testid", "callout-type-menu");
  // Fixed to the viewport at the icon's position — NOT a child of the widget DOM, which CM reconciles away
  // on the next update (memory: CM floating UI must live outside view.dom). Positioned below the icon badge.
  const r = anchor.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${Math.round(r.bottom + 2)}px`;
  menu.style.left = `${Math.round(r.left)}px`;
  for (const ty of CALLOUT_TYPES) {
    // #174 comment 883: the SAME visual chip (icon + variant colour + localized name) as the editUI panel's
    // Type field — one shared builder so the two pickers cannot drift.
    const b = calloutTypeOption(ty, false);
    b.setAttribute("data-testid", `callout-type-${ty}`);
    b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); changeCalloutTypeAt(view, blockStart, ty); close(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const dismiss = (e: Event) => { if (!menu.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  const close = () => { menu.remove(); document.removeEventListener("pointerdown", dismiss, true); document.removeEventListener("keydown", onKey, true); };
  setTimeout(() => { document.addEventListener("pointerdown", dismiss, true); document.addEventListener("keydown", onKey, true); }, 0);
}

class CalloutWidget extends WidgetType {
  private ro?: ResizeObserver;
  constructor(readonly containerClass: string, readonly icon: string, readonly label: string, readonly body: string) { super(); }
  eq(o: CalloutWidget) {
    return o.containerClass === this.containerClass && o.icon === this.icon && o.label === this.label && o.body === this.body;
  }
  toDOM(view: EditorView) {
    const el = renderCalloutPanel(this.containerClass, this.icon, this.label, this.body);
    if (!view.state.readOnly) {
      // #174 comment 878 (ADR-087 addendum 2): a click PLACES THE CARET (reveals raw `:::type[label]` + body),
      // it does NOT open the editUI panel directly (that was the reversed behaviour the reviewer rejected).
      // Same plain caret placement the pipe TableWidget uses; the RichUI is reached via the caret-in pill /
      // Ctrl+Enter (enterMacroAt), matching the table 4-quadrant model.
      el.addEventListener("mousedown", (e) => { e.preventDefault(); view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(el)) }); view.focus(); });
      // #174 / ADR-087 (Class 1): clicking the icon badge opens the TYPE picker directly (metadata direct-
      // click), instead of entering raw — stopPropagation so the panel's caret-in handler above doesn't fire.
      const iconEl = el.querySelector(".cm-lp-callout-panel-icon");
      if (iconEl instanceof HTMLElement) {
        iconEl.style.cursor = "pointer";
        iconEl.style.position = "relative"; // anchor the floating type menu
        iconEl.setAttribute("data-testid", "callout-type-badge");
        iconEl.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); openCalloutTypeMenu(view, iconEl, view.posAtDOM(el)); });
      }
      // #174 comment 894: a WYSIWYG-reachable edit entry. In Live, clicking the panel reveals raw and the
      // raw-lead pill opens the editUI; in WYSIWYG the syntax NEVER reveals, so the panel had NO way into
      // the editUI. Add a ✎ button (with the same Ctrl+↵ hint) ON the panel — click / Ctrl+Enter both reach
      // enterMacroAt → the callout editUI (type/header/content). Callout is SYMMETRIC (Ctrl+Enter and ✎ open
      // the same editUI), so the hint is accurate. Shown on panel hover (CSS). stopPropagation so it doesn't
      // also place the caret (the panel's mousedown above).
      el.classList.add("cm-lp-callout-panel-editable");
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "cm-lp-macro-edit cm-lp-macro-edit-hint cm-lp-callout-panel-edit";
      edit.title = "Edit (Ctrl+Enter)";
      edit.innerHTML = MACRO_EDIT_ICON + '<span class="cm-lp-macro-richui-key">Ctrl+↵</span>';
      edit.setAttribute("data-testid", "callout-panel-edit");
      edit.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); enterMacroAt(view, view.posAtDOM(el)); });
      el.appendChild(edit);
    }
    // Height settles after the nested body renders → re-measure so lines below don't drift.
    this.ro = observeBlockResize(view, el);
    return el;
  }
  destroy() { this.ro?.disconnect(); this.ro = undefined; }
  ignoreEvent() { return false; } // clicks pass through so the caret can enter → reveal raw
}

// A construct's syntax markers reveal (become editable raw text) when the main
// selection touches the range the marker sits on — matching Obsidian's per-line
// reveal. This only changes rendering, never offsets.
//
// Reveal exists so you can edit the raw markdown under your cursor. In a READ-ONLY
// surface (the default "view" mode) there is nothing to edit, so NOTHING is ever
// revealed — otherwise the view's default selection (position 0) would reveal any
// first-line construct (a leading image, heading, or table) as raw markdown.
// The per-mode syntax-reveal decision (ADR-056 / ADR-078), extracted PURE so it is unit-testable and
// shared by the inline/block reveal (here) and math (math.ts) — the two must never diverge.
// readOnly (reading / view) → never reveal (clean render; nothing to edit).
// source → ALWAYS reveal (raw everywhere).
// wysiwyg → NEVER reveal (the inverse of source: markers stay hidden + atomic so
// the doc always shows the rendered form; text stays editable, format
// via toolbar / richEditUI). Opt-in (default is live).
// live → reveal only where the caret/selection overlaps the marker.
export function syntaxRevealsAt(mode: DisplayMode, readOnly: boolean, underSelection: boolean): boolean {
  if (readOnly) return false;
  if (mode === "source") return true;
  if (mode === "wysiwyg") return false;
  return underSelection;
}
function rangeRevealed(state: EditorState, from: number, to: number): boolean {
  return syntaxRevealsAt(
    state.facet(displayMode),
    state.readOnly,
    state.selection.ranges.some((r) => r.from <= to && r.to >= from),
  );
}

// #196 / ADR-092 (innermost-wins reveal): is the caret inside a registered macro that is NESTED
// STRICTLY within the container [from,to] — a deeper child, not the container at `from` itself? When
// true, a layout container (columns/tabs) renders a visible frame + descends so ONLY the innermost
// child reveals raw (its siblings + the container stay rendered); when false, a caret inside reveals
// the whole block raw (you're editing the container's own :::column/:::tab structure). Uses the main
// selection head + directiveChainAt (outer→inner chain of registered macros; unregistered structural
// directives like :::column are skipped, so the chain jumps container→leaf macro).
//
// Safety: this ONLY returns true when the syntax tree genuinely nests a registered macro inside the
// container at the caret. In every other case it is false, so the container's existing reveal/widget
// behaviour is byte-identical — the change is inert unless real nesting exists.
export function caretInNestedMacro(state: EditorState, from: number, to: number): boolean {
  if (!state.selection.ranges.some((r) => r.from <= to && r.to >= from)) return false; // caret not inside
  const chain = directiveChainAt(state, state.selection.main.head);
  const innermost = chain[chain.length - 1];
  return !!innermost && innermost.from > from && innermost.to <= to;
}
// Source mode (#164/#165): syntax is ALWAYS raw. Unlike `rangeRevealed` (true for live+caret AND for
// source), this is TRUE ONLY in source mode — used to force a BLOCK MACRO to show its raw `:::` source
// (a non-revealOnCursor macro like :::table/:::note would otherwise keep rendering its widget in source
// mode, so raw never showed — the #165 review bug). Non-macro syntax already goes raw via
// hideMarker/lineRevealed. Read-only (reading) never reveals.
function isSourceMode(state: EditorState): boolean {
  return !state.readOnly && state.facet(displayMode) === "source";
}
function lineRevealed(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return rangeRevealed(state, line.from, line.to);
}
// ADR-024: an empty-caret head resting within a block atom's range = the atom is selected
// (highlight + dd/yy target). Atom motion lands the caret on the atom's near edge.
function atomSelected(state: EditorState, from: number, to: number): boolean {
  const s = state.selection.main;
  return !state.readOnly && s.empty && s.head >= from && s.head <= to;
}

// ── Extensible block-render registry (P3) ──────────────────────────────────
// Each renderer maps markdown syntax-tree nodes to DECORATIONS. The builder it
// receives (RenderCtx) can ONLY push decorations — it exposes no way to dispatch a
// document change — so the ADR-008 invariant (display-only, OFFSET-INVARIANT: the
// CM doc stays 1:1 with the canonical Y.Text, so remote carets stay correct) holds
// BY CONSTRUCTION for every present and future renderer. Adding a block type
// (table, image, …) = adding a renderer to RENDERERS; the core walk never changes.
//
// This is NOT a macro system: renderers render static, markdown-derived blocks.
// Executing user-authored code (sandbox, trust boundary, review) is deliberately
// out of scope — a future macro would be "a renderer that executes", but none of
// that machinery exists or is implied here.
export interface RenderCtx {
  readonly state: EditorState;
  // #200: the theme to build macro widgets with. On a light/dark switch it's the redrawMacros effect
  // payload (React's new theme) — NOT a live <html data-theme> read, which is STALE at that moment
  // (the Editor's effect fires child-first, before ThemeProvider updates data-theme). Falls back to
  // currentMacroTheme for every other (non-theme-switch) rebuild, where the DOM is correct.
  readonly macroTheme: MacroTheme;
  // Style a range (mark decoration) or a whole line (line decoration at line.from
  // — pass only `from`). Cannot change document length.
  add(deco: Decoration, from: number, to?: number): void;
  // Hide a syntax marker unless the cursor is on its line. `atomic` (default true) also feeds
  // atomicRanges so local cursor motion skips an INLINE marker cleanly. Pass `atomic: false` for a
  // WHOLE-LINE marker (a `:::` directive fence) — an atomic whole-line range is un-landable, so j/k
  // vertical motion skips the line entirely (#141 bounce: callout fence lines warped). Display-only.
  hideMarker(from: number, to: number, deco?: Decoration, atomic?: boolean): void;
  // #202: hideMarker variant that reveals only when the caret is ON the marker range (not the whole
  // line), so a list marker's ordinal/glyph re-renders immediately on nest/continue. Source mode raw.
  hideMarkerTight(from: number, to: number, deco?: Decoration, atomic?: boolean): void;
  // Add a decoration AND mark its range atomic (fed to EditorView.atomicRanges). Used
  // for collapsed BLOCK widgets (table, image, future macros) so cursor motion snaps to
  // the block's boundary — which the reveal-on-cursor check treats as overlapping, so
  // arrowing/`j`/`k` into the block reveals its raw source instead of skipping it.
  addAtomic(deco: Decoration, from: number, to: number): void;
  // #185 comment 781: is `pos` inside a block-replace widget already emitted this pass? Skips the orphaned
  // inner directive nodes a lezer early-close leaves behind (they'd double-render over the container widget).
  coveredByBlock(pos: number): boolean;
  // #185 sub-task 2b: line-starts of directive fence lines that lezer's DirectiveMark renderer already
  // hid. A post-pass hides the RESOLVER's fence lines that are NOT in here (the ones lezer early-closed
  // and leaked). Only leaked fences (early-closed descend containers — columns/tabs) are absent, and
  // those are never under a block-replace widget, so the post-pass never overlaps an existing replace.
  readonly fenceLineStarts: Set<number>;
}

// Minimal structural view of a syntax-tree node — what renderers need. A real
// @lezer SyntaxNodeRef (what tree.iterate yields) satisfies this, so we avoid a
// direct @lezer/common dependency just for the type.
export interface RenderNode {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly node: { readonly parent: { readonly name: string; readonly parent: { readonly name: string } | null } | null };
}

export interface BlockRenderer {
  match(name: string): boolean;
  // Return `false` to SKIP this node's children (e.g. a layout-directive atom that has rendered
  // its inner :::column/:::tab itself — #90); void/undefined descends as usual.
  enter(node: RenderNode, ctx: RenderCtx): void | boolean;
}

const RENDERERS: BlockRenderer[] = [
  {
    // Heading line styling; the HeaderMark child is hidden by its own renderer.
    match: (n) => /^ATXHeading[1-6]$/.test(n),
    enter: (node, ctx) => {
      const level = Number(/([1-6])$/.exec(node.name)![1]);
      ctx.add(headingLine(level), ctx.state.doc.lineAt(node.from).from);
    },
  },
  {
    match: (n) => n === "HeaderMark",
    enter: (node, ctx) => {
      // Include the single trailing space so the heading text isn't indented.
      let to = node.to;
      if (ctx.state.doc.sliceString(to, to + 1) === " ") to += 1;
      ctx.hideMarker(node.from, to);
    },
  },
  { match: (n) => n === "StrongEmphasis", enter: (node, ctx) => ctx.add(strongMark, node.from, node.to) },
  { match: (n) => n === "Emphasis", enter: (node, ctx) => ctx.add(emphasisMark, node.from, node.to) },
  { match: (n) => n === "EmphasisMark", enter: (node, ctx) => ctx.hideMarker(node.from, node.to) },
  // GFM strikethrough: style the run, hide the "~~" delimiters (reveal on cursor line).
  { match: (n) => n === "Strikethrough", enter: (node, ctx) => ctx.add(strikeMark, node.from, node.to) },
  { match: (n) => n === "StrikethroughMark", enter: (node, ctx) => ctx.hideMarker(node.from, node.to) },
  { match: (n) => n === "InlineCode", enter: (node, ctx) => ctx.add(inlineCodeMark, node.from, node.to) },
  {
    match: (n) => n === "FencedCode",
    enter: (node, ctx) => {
      const doc = ctx.state.doc;
      // Macro fence (```mermaid …)? Render via the registry instead of tinting. Needs
      // no parser — the lang comes from the already-parsed fence's first line.
      const lang = fenceLang(doc.lineAt(node.from).text);
      const macro = lang ? findFenceMacro(lang) : undefined;
      if (macro) {
        const from = doc.lineAt(node.from).from;
        const to = doc.lineAt(Math.max(node.from, Math.min(node.to, doc.length) - 1)).to;
        // Source mode (#165): show the raw ``` fence, not the rendered widget (a fence macro is an
        // atom that otherwise never auto-reveals, so source mode never showed its source without this).
        if (isSourceMode(ctx.state)) return;
        // Folded → CM's fold placeholder owns the range. Caret inside → reveal raw
        // source (editable). Otherwise → the rendered macro (a collapsed block widget,
        // entered via blockEntry like table/image).
        if (isFolded(ctx.state, from, to)) return;
        // ADR-024: a macro is an ATOM — it never auto-reveals on the cursor (that caused
        // the height-change / cursor-through / overshoot class of bugs). A source macro
        // (mermaid, no richEditUI) reveals its raw source ONLY when ENTERED
        // (Ctrl+Enter / click → macroRenderActiveField). A modal macro (Excalidraw) never
        // reveals — entering opens its modal. Otherwise the atom renders.
        const active = ctx.state.field(macroRenderActiveField, false);
        // #174 / ADR-087: a fence macro with the unified inline editUI, render-active → mount its own
        // editor (EditableEditUIWidget). mermaid + plantuml declare editUI: inline (#239) — the ✎ button
        // enters here; the host wires the Escape/Done exit so the editUI is not a one-way trap.
        // #174 addendum: `active.raw` (Ctrl+Enter) opts OUT of the editUI — it reveals the raw source
        // (falls through to the reveal-on-cursor branch below). The ✎ button enters with raw=false → editUI.
        if (macro.editUI?.present === "inline" && active && !active.raw && active.from <= from && active.to >= to && !ctx.state.readOnly) {
          ctx.addAtomic(Decoration.replace({ widget: new EditableEditUIWidget(from, to, fenceBody(doc, node.from, node.to), macro.editUI, (b) => "```" + lang + "\n" + b + "\n```", ctx.macroTheme, macro.tier), block: true }), from, to);
          return;
        }
        if (active && !macro.richEditUI && active.from <= from && active.to >= to) return; // entered → source
        // #255: the diagram fence's `align=` attribute (default center) drives the widget's alignment.
        const fenceAlign = DIAGRAM_MACROS.has(lang!) ? (parseFenceLine(doc.lineAt(node.from).text)?.align ?? "center") : "center";
        ctx.addAtomic(Decoration.replace({ widget: new MacroWidget(macro, fenceBody(doc, node.from, node.to), macro.foldable ?? true, lang!, atomSelected(ctx.state, from, to), ctx.macroTheme, 0, 0, 0, null, null, fenceAlign), block: true }), from, to);
        return;
      }
      const first = doc.lineAt(node.from).number;
      const last = doc.lineAt(Math.min(node.to, doc.length)).number;
      // #198 / ADR-094: parse the fence info string for attributes (title / showLineNumbers / {ranges}).
      const info = parseFenceLine(doc.lineAt(node.from).text);
      const hl = new Set<number>();
      if (info?.highlight) for (const [a, b] of info.highlight) for (let x = a; x <= b; x++) hl.add(x);
      // Tint only the CODE lines, not the ``` / ~~~ fence lines (those would render
      // as empty tinted bars once their CodeMark hides — visually redundant).
      // #198 bounce: in SOURCE mode the code fence must show RAW ONLY — no header band, no hidden info,
      // no line numbers / highlight (round-trip). hideMarker below is already source-gated, but the
      // ctx.add decorations are not, so gate them explicitly.
      const srcMode = isSourceMode(ctx.state);
      // #198 (comment 724): the code BODY (fence lines excluded) for the copy button, and the last code
      // line number for the card's bottom rounding. Collected up front since the header widget (which
      // holds the copy target) is emitted on the FIRST line, before the loop reaches the body.
      const codeLines: string[] = [];
      let lastCodeLine = -1;
      for (let n = first + 1; n <= last; n++) {
        const lt = doc.line(n).text;
        const tt = lt.trimStart();
        if (tt.startsWith("```") || tt.startsWith("~~~")) break; // closing fence
        codeLines.push(lt);
        lastCodeLine = n;
      }
      const codeBody = codeLines.join("\n");
      let codeIdx = 0; // #198: 1-based CODE line index (fence lines excluded) for line numbers + highlight
      for (let n = first; n <= last; n++) {
        const line = doc.line(n);
        const t = line.text.trimStart();
        if (t.startsWith("```") || t.startsWith("~~~")) {
          // #198 bounce: on the OPENING fence of an attributed fence, REPLACE the raw info string with
          // the header band (title + lang) INLINE, reveal-on-cursor via hideMarker (caret on the line OR
          // Source mode shows the raw info). Replacing the info in place — rather than a separate side:-1
          // header widget + a now-empty (blank) opening line — means Live shows the header directly above
          // the code body with NO blank line between them (the header IS the opening line, matching how
          // the callout ::: collapses). NON-atomic so the line stays landable to reveal. Attributed only.
          // #198 comment 770 (1/2): render the header for EVERY fence with a language, not only attributed
          // ones — the copy button and the lang tab are universal (a plain ```c must have a copy button too,
          // and the tab must look identical whether it's "lang only" or "filename + lang"). Reveal-on-cursor
          // via hideMarker (caret on the line / Source → raw info). NON-atomic so the line stays LANDABLE.
          if (n === first && info && info.lang) {
            const fence = line.text.match(/^(\s*)([`~]+)/);
            const infoStart = line.from + (fence ? fence[0].length : 0);
            // #198 (comment 724): tab (title + lang) + a copy button shown only in a VIEW mode (!srcMode).
            if (infoStart < line.to) ctx.hideMarker(infoStart, line.to, Decoration.replace({ widget: new FenceHeaderWidget(info.lang, info.title, codeBody, !srcMode) }), false);
          } else if (n === first && !srcMode && !lineRevealed(ctx.state, line.from)) {
            // #174 comment 911: a fence with NO language (a plain ```) still needs a COPY button — the
            // opening line has no info string to replace (the CodeMark renderer already hides the ``` ),
            // so emit a header widget (empty tab + copy button) at the collapsed fence line. Reveal-gated
            // (skip when the caret is on the line) so it matches the lang'd header's reveal-on-cursor;
            // Source mode is raw. Empty lang → FenceHeaderWidget shows only the copy button.
            ctx.add(Decoration.widget({ widget: new FenceHeaderWidget("", undefined, codeBody, true), side: 1 }), line.from);
          }
          continue;
        }
        codeIdx++;
        // #198 comment 752 (2): Source mode is FULLY raw — no code-block decoration at all, parity with
        // every other macro (`:::warning` shows raw text in Source). No card background / number / highlight.
        if (srcMode) continue;
        // #198 comment 752 (1): EVERY code fence is the SAME base card (cm-lp-code-line + rounded corners) in
        // a view mode — the base look does NOT change with the presence of attributes. A title/number/
        // highlight fence just LAYERS the tab / gutter / tint ON TOP of that identical card. When a tab is
        // present it flattens the card's top-left corner so the tab connects; a plain fence keeps it rounded.
        let cls = "cm-lp-code-line";
        const attrs: Record<string, string> = {};
        if (info?.showLineNumbers) { cls += " cm-lp-code-numbered"; attrs["data-linenum"] = String(codeIdx); }
        if (hl.has(codeIdx)) cls += " cm-lp-code-hl";
        // #198 comment 770 (3): the card ALWAYS keeps all top corners rounded — the tab OVERLAPS the card's
        // top-left to connect (it's a chip on top of the card), so the top edge to the RIGHT of the (narrow)
        // tab keeps its rounding rather than the whole first line flattening.
        if (n === first + 1) cls += " cm-lp-code-first";
        if (n === lastCodeLine) cls += " cm-lp-code-last";
        attrs.class = cls;
        ctx.add(Decoration.line({ attributes: attrs }), line.from);
      }
    },
  },
  { match: (n) => n === "CodeMark", enter: (node, ctx) => ctx.hideMarker(node.from, node.to) },
  {
    // ::: container directive (macro). The body stays Markdown — its nested nodes are
    // decorated by the other renderers — so here we only draw the box (the macro's
    // containerClass on every line of the block). The ::: fence markers are hidden by
    // the DirectiveMark renderer (reveal-on-cursor). Unknown name → leave raw text.
    match: (n) => n === "Directive",
    enter: (node, ctx) => {
      const doc = ctx.state.doc;
      // #185 comment 781: lezer early-closes a `::::tabs` parent at an inner `::::columns` close, leaving
      // the later tabs (e.g. the second tab) as ORPHANED sibling Directive nodes. Once the container
      // widget is emitted over its FULL resolver range, skip any node the walk reaches inside it — else
      // the orphan double-renders (frame box / note fallback) below the container and leaks outside it.
      if (ctx.coveredByBlock(node.from)) return false;
      const open = parseDirectiveOpen(doc.lineAt(node.from).text);
      // #196: structural layout children (:::column / :::tab) are NOT standalone macros. They only
      // reach this renderer when their parent columns/tabs container is in innermost-wins "frame +
      // descend" mode (caret editing a nested child); in the normal widget/whole-raw modes the
      // container skips them. Render them as a transparent structural frame box and descend, so the
      // callouts inside them reveal individually (not the `note` fallback below). Source mode shows raw.
      if (open && (open.name === "column" || open.name === "tab") && !isSourceMode(ctx.state)) {
        const first = doc.lineAt(node.from);
        const lastLine = doc.lineAt(Math.max(node.from, Math.min(node.to, doc.length) - 1));
        const box = Decoration.line({ attributes: { class: open.name === "column" ? "cm-lp-column-frame" : "cm-lp-tab-frame" } });
        for (let n = first.number; n <= lastLine.number; n++) ctx.add(box, doc.line(n).from);
        return; // descend into the child's inner macros — they reveal per their own caret state
      }
      // #150: an unknown directive type falls back to a `note` callout (Obsidian-compatible),
      // so e.g. `:::foobar` renders as a note box rather than raw text.
      const macro = open ? (findDirectiveMacro(open.name) ?? noteCalloutMacro) : undefined;
      if (!macro) return;
      // #185 comment 781: derive the block range from the RESOLVER (Pandoc stack semantics), not lezer's
      // `node.to` — lezer early-closes a nested container so its `node.to` truncates the body (the widget
      // then splits only the first tab/column and the rest leaks out). directiveMacroAt is resolver-backed
      // and gives the true end; fall back to the lezer node for an unregistered/unresolved directive.
      const resolved = directiveMacroAt(ctx.state, node.from);
      const blockFrom = resolved ? resolved.from : node.from;
      const blockTo = resolved ? resolved.to : node.to;
      const first = doc.lineAt(blockFrom);
      const lastLine = doc.lineAt(Math.max(blockFrom, Math.min(blockTo, doc.length) - 1));
      // Source mode (#165): show the RAW `:::` block — no widget, no callout box. Descend so the
      // DirectiveMark + body render as raw editable markdown (hideMarker/lineRevealed already show raw
      // in source). Without this a non-revealOnCursor macro kept rendering its widget in source mode.
      if (isSourceMode(ctx.state)) return;
      if (macro.liveRender) {
        // BLOCK directive: render the body as a widget atom. :::table is entered explicitly
        // (#86) so it never reveals here. A LAYOUT directive (#90 columns/tabs) sets
        // revealOnCursor: while the caret is inside, reveal the WHOLE raw block (return false →
        // skip the inner :::column/:::tab so it's plain editable source); otherwise render the
        // widget AND skip the inner directives (they live inside the atom — no double-render).
        const from = first.from;
        const to = lastLine.to;
        // #154: an inline-richEditUI directive (:::table) that is render-active → the in-editor
        // WYSIWYG editor over the WHOLE block (host.getSource parses the :::table fences). Unlike a
        // pipe table, :::table HTML is not hand-typeable, so BOTH vim and non-vim use the editor
        // here (the M1 spike/ADR-054 proved focus delegation holds in vim too).
        const active = ctx.state.field(macroRenderActiveField, false);
        // #174 / ADR-087: a directive macro with the unified inline editUI, render-active → mount its own
        // editor via EditableEditUIWidget (editUI.mount + save→Y.Text). Precedes the legacy richEditUI
        // branch. Inert today (no first-party directive declares editUI yet) — the migration hook.
        if (macro.editUI?.present === "inline" && active && active.from <= from && active.to >= to && !ctx.state.readOnly) {
          const editBody: string[] = [];
          for (let n = first.number + 1; n < lastLine.number; n++) editBody.push(doc.line(n).text);
          // #196: preserve the OPENING fence VERBATIM (colon count + any `[label]`) so a 4-colon `::::columns`
          // round-trips as `::::columns`, not `:::columns` — the nesting colon convention (#185) stays intact.
          const openLine = first.text; const closeMark = openLine.match(/^\s*([`~:]+)/)?.[1] ?? ':::';
          ctx.addAtomic(Decoration.replace({ widget: new EditableEditUIWidget(from, to, editBody.join("\n"), macro.editUI, (b) => `${openLine}\n${b}\n${closeMark}`, ctx.macroTheme, macro.tier), block: true }), from, to);
          return false; // the inline editor owns the block
        }
        if (macro.richEditUI?.present === "inline" && active && active.from <= from && active.to >= to && !ctx.state.readOnly) {
          ctx.addAtomic(Decoration.replace({ widget: new EditableTableWidget(from, to, doc.sliceString(from, to)), block: true }), from, to);
          return false; // skip inner nodes — the inline editor owns the block
        }
        if (macro.revealOnCursor && rangeRevealed(ctx.state, from, to)) {
          // #196 / ADR-092 innermost-wins reveal: a caret inside the container reveals the WHOLE block
          // raw ONLY when it's editing the container's own structure (chain innermost === container).
          // When the caret is deeper inside a NESTED registered macro (e.g. a callout in a column),
          // render a visible frame box over the block and DESCEND, so the container + siblings stay
          // rendered and only the innermost child reveals raw — the same macro-unit edit as outside a
          // container. Inert unless real nesting exists (caretInNestedMacro is false otherwise).
          if (!caretInNestedMacro(ctx.state, from, to)) return false;
          const frameCls = open!.name === "tabs" ? "cm-lp-tabs-frame" : "cm-lp-columns-frame";
          const box = Decoration.line({ attributes: { class: frameCls } });
          for (let n = first.number; n <= lastLine.number; n++) ctx.add(box, doc.line(n).from);
          return; // descend: the nested :::column/:::tab + their inner macros render individually
        }
        const parts: string[] = [];
        for (let n = first.number + 1; n < lastLine.number; n++) parts.push(doc.line(n).text);
        // #215 / ADR-100: the container's inner-body base (for nested tagging) + the display-only
        // nested-selection / nested-edit state that intersects THIS container (null otherwise).
        const bodyFrom = first.number + 1 <= doc.lines ? doc.line(first.number + 1).from : from;
        const nsf = ctx.state.field(nestedSelectionField, false);
        const nestedSel = nsf && nsf.nested.from >= from && nsf.nested.to <= to ? nsf : null;
        const nef = ctx.state.field(nestedEditActiveField, false);
        const nestedEdit = nef && nef.nested.from >= from && nef.nested.to <= to ? nef : null;
        // #174 comment 1003: layout containers in WYSIWYG draw hover ✎ on their nested editable slots (below);
        // the flag is part of eq so a display-mode switch rebuilds the widget (eq ignores the live facet).
        const wysiwygNested = (open!.name === "columns" || open!.name === "tabs") && ctx.state.facet(displayMode) === "wysiwyg";
        ctx.addAtomic(Decoration.replace({ widget: new MacroWidget({ liveRender: macro.liveRender, richEditUI: macro.richEditUI, editUI: macro.editUI }, parts.join("\n"), false, open!.name, atomSelected(ctx.state, from, to), ctx.macroTheme, from, to, bodyFrom, nestedSel, nestedEdit, "center", wysiwygNested), block: true }), from, to);
        return macro.revealOnCursor ? false : undefined;
      }
      if (macro.collapsible && !rangeRevealed(ctx.state, first.from, lastLine.to)) {
        // #90 details, collapsed: replace the whole block with a "▸ summary" bar (one widget →
        // no per-line decoration conflict). Skip children so the fences aren't double-processed.
        // Caret-in (rangeRevealed) falls through to the container render below = raw editable.
        ctx.addAtomic(Decoration.replace({ widget: new DetailsSummaryWidget(open!.label ?? "Details"), block: true }), first.from, lastLine.to);
        return false;
      }
      if (macro.containerClass) {
        // #174 / ADR-087: a container macro (callout) with the unified inline editUI, render-active →
        // mount its editor (EditableEditUIWidget). sourceScope "block": the editor owns the WHOLE
        // `:::type[label]…:::` (so it can change the type/label), so pass the full block source and an
        // identity wrap (the editUI's save already returns the reconstructed block). Precedes the panel.
        const cActive = ctx.state.field(macroRenderActiveField, false);
        if (macro.editUI?.present === "inline" && cActive && cActive.from <= first.from && cActive.to >= lastLine.to && !ctx.state.readOnly) {
          const blockSrc = doc.sliceString(first.from, lastLine.to);
          ctx.addAtomic(Decoration.replace({ widget: new EditableEditUIWidget(first.from, lastLine.to, blockSrc, macro.editUI, (b) => b, ctx.macroTheme, macro.tier), block: true }), first.from, lastLine.to);
          return false; // the inline editor owns the block
        }
        // #170 / ADR-049 (Y): a typed callout (containerClass + icon) renders as a single-container
        // PANEL widget when the caret is OUTSIDE — icon large + vertically centred, variant title,
        // nested Markdown body (renderCalloutPanel, the shared renderer). Caret-in reveals the raw
        // `:::` source (per-line boxes below) for editing = enter-to-edit, consistent with
        // columns/tabs/details. addAtomic records it as a block for blockEntry motion.
        if (macro.icon && !rangeRevealed(ctx.state, first.from, lastLine.to)) {
          const bodyParts: string[] = [];
          for (let n = first.number + 1; n < lastLine.number; n++) bodyParts.push(doc.line(n).text);
          ctx.addAtomic(
            Decoration.replace({ widget: new CalloutWidget(macro.containerClass, macro.icon, open!.label ?? "", bodyParts.join("\n")), block: true }),
            first.from,
            lastLine.to,
          );
          return false; // skip children — the panel owns the block
        }
        // CONTAINER directive (callout, caret-in = raw / details revealed): a CSS box over every
        // line; content stays markdown (raw-editable under the cursor).
        const box = Decoration.line({ attributes: { class: macro.containerClass } });
        // The OPEN line renders a header when there is a leading [label] (#94) AND/OR the macro
        // has an icon (#150 typed callouts) — via CSS ::before(attr(data-icon) attr(data-label)),
        // display-only (the `:::name[label]` text stays the hidden source, reveal-on-cursor to
        // edit). No widget, so it never fights the DirectiveMark hide.
        const openLine = (open!.label || macro.icon)
          ? Decoration.line({ attributes: {
              class: `${macro.containerClass} cm-lp-directive-label`,
              'data-label': open!.label ?? '',
              ...(macro.icon ? { 'data-icon': macro.icon } : {}),
            } })
          : box;
        ctx.add(openLine, first.from);
        for (let n = first.number + 1; n <= lastLine.number; n++) ctx.add(box, doc.line(n).from);
        // #174 comment 878 (ADR-087 addendum 2): caret-in raw editing → the SHARED RichUI-entry pill at the
        // top-left (the same affordance as the pipe table, #216). Live + editable only. Click / Ctrl+Enter →
        // enterMacroAt → the callout editUI (type/header/content). macroRawLead adds position:relative to the
        // open line so the pill anchors and floats just above it (never covering the raw `:::type` source).
        if (rangeRevealed(ctx.state, first.from, lastLine.to) && ctx.state.facet(displayMode) === "live" && !ctx.state.readOnly) {
          ctx.add(macroRawLead, first.from);
          ctx.add(Decoration.widget({ widget: new MacroRawRichuiPill(first.from, enterMacroAt, "callout-richui-enter"), side: -1 }), first.from);
        }
      }
    },
  },
  // The :::name / ::: fence lines: hide (reveal raw on the cursor's line, like every
  // other marker). hideMarker also makes the range atomic for clean cursor motion.
  // #141 bounce: a `:::` fence occupies a WHOLE line. Two things
  // - When the enclosing directive is being EDITED (caret anywhere in its range), show the fence RAW
  // a hidden (fully-replaced) fence line collapses toward ~0 height, so its y coincides with the next
  // body line and geometry-based j/k skips a line (the reported 1→3 warp in a revealed callout). Raw
  // fence lines keep normal line height + stay landable/editable while editing the block.
  // - Otherwise hide it (reveal-on-cursor) but NOT atomically (a whole-line atomic range is un-landable).
  { match: (n) => n === "DirectiveMark", enter: (node, ctx) => {
    const dir = directiveMacroAt(ctx.state, node.from);
    // #196 / ADR-092 (comment 740): reveal a directive's raw fences ONLY when the caret is editing THIS
    // directive itself — NOT when it's deeper inside a nested child. Without the `!caretInNestedMacro`
    // guard, a container (columns/tabs) whose nested callout is being edited kept its own `::::columns` /
    // `::::` markers raw (the leak the reviewer saw), because the caret is within the container's range.
    // Innermost-wins: an ancestor container hides its markers while a descendant reveals; the frame +
    // descend renderer (above) keeps the container drawn, so only the innermost child shows raw.
    if (dir && rangeRevealed(ctx.state, dir.from, dir.to) && !caretInNestedMacro(ctx.state, dir.from, dir.to)) return;
    ctx.fenceLineStarts.add(ctx.state.doc.lineAt(node.from).from); // #185 2b: lezer hid this fence line
    ctx.hideMarker(node.from, node.to, undefined, false);
  } },
  {
    // Blockquote → a left-bar + muted block. Each line gets the quote line style; the
    // ">" markers hide (revealing on the cursor's line, like every other marker), so
    // it reads as a quote but stays raw-editable under the cursor.
    match: (n) => n === "Blockquote",
    enter: (node, ctx) => {
      const first = ctx.state.doc.lineAt(node.from).number;
      const last = ctx.state.doc.lineAt(Math.min(node.to, ctx.state.doc.length)).number;
      for (let i = first; i <= last; i++) ctx.add(quoteLine, ctx.state.doc.line(i).from);
    },
  },
  {
    match: (n) => n === "QuoteMark",
    enter: (node, ctx) => {
      // Include the trailing space so the quoted text isn't indented by it.
      let to = node.to;
      if (ctx.state.doc.sliceString(to, to + 1) === " ") to += 1;
      ctx.hideMarker(node.from, to);
    },
  },
  {
    // GFM task checkbox: replace `[ ]`/`[x]` with a real checkbox (reveal-on-cursor
    // shows the raw markers for editing). hideMarker makes it reveal-gated + atomic.
    match: (n) => n === "TaskMarker",
    enter: (node, ctx) => {
      const checked = ctx.state.doc.sliceString(node.from + 1, node.from + 2).toLowerCase() === "x";
      ctx.hideMarker(node.from, node.to, checkbox(checked, node.from));
    },
  },
  {
    match: (n) => n === "ListMark",
    enter: (node, ctx) => {
      const list = node.node.parent?.parent?.name; // ListItem -> Bullet/OrderedList
      // Replace "-"/"*" with a per-LEVEL bullet glyph (#202: •→◦→▪ by nesting). #202 (comment 761)
      // an ORDERED marker is replaced with a per-LEVEL ordinal (1.→a.→i.) counted INDEPENDENTLY within
      // its nested list (not merged into the parent's run), so nested numbering reads as a real hierarchy.
      // Both key off the SAME nesting DEPTH (listDepth) so bullets and ordered lists stay consistent.
      const level = listDepth(node);
      // #202 comment 779: hideMarkerTight — the marker renders its widget even while the caret is elsewhere
      // ON THE SAME ITEM (only revealing raw when the caret is IN the marker), so nesting/continuing shows
      // the right ordinal/glyph immediately instead of the stale raw source marker under the caret.
      if (list === "BulletList") {
        ctx.hideMarkerTight(node.from, node.to, Decoration.replace({ widget: new BulletWidget(level) }));
      } else if (list === "OrderedList") {
        ctx.hideMarkerTight(node.from, node.to, Decoration.replace({ widget: new OrderedWidget(level, orderedOrdinal(node)) }));
      }
    },
  },
  {
    // Style the link; carry its sanitized destination as data-href so a click can
    // follow it (linkClicks handler). Falls back to the plain (non-clickable) mark
    // when the destination is unsafe/absent.
    match: (n) => n === "Link",
    enter: (node, ctx) => {
      const href = linkHref(ctx.state.doc.sliceString(node.from, node.to));
      ctx.add(href ? Decoration.mark({ class: "cm-lp-link", attributes: { "data-href": href } }) : linkMark, node.from, node.to);
    },
  },
  { match: (n) => n === "LinkMark", enter: (node, ctx) => ctx.hideMarker(node.from, node.to) },
  {
    // #223: a URL node is hidden ONLY when it is a link's DESTINATION (parent is Link → the `(url)` part,
    // which the [text] label replaces). A STANDALONE URL — a bare autolink, or the URL used AS a link's
    // visible text (e.g. `[https://x](https://x)`) — must NOT be hidden, or it renders BLANK (the reported
    // on paste). A bare autolink additionally gets the clickable link style so a pasted / typed URL
    // shows as a link. safeHref gates the click target (unsafe → plain, non-clickable text).
    match: (n) => n === "URL",
    enter: (node, ctx) => {
      // The link DESTINATION `(url)` — a URL inside a Link whose `(` immediately precedes it — is hidden (the
      // [text] label stands in for it). A URL used AS the link's visible text (`[https://x](…)`, preceded by
      // `[`) is inside the Link too but must SHOW — the Link's own cm-lp-link mark already makes it clickable;
      // hiding it left the label BLANK (#223 ). A bare autolink (parent not a Link) shows + gets the
      // clickable style.
      const inLink = node.node.parent?.name === "Link";
      const isDestination = inLink && ctx.state.doc.sliceString(Math.max(0, node.from - 1), node.from) === "(";
      if (isDestination) { ctx.hideMarker(node.from, node.to); return; }
      if (!inLink) { // bare autolink → clickable
        const href = linkHref(ctx.state.doc.sliceString(node.from, node.to));
        if (href) ctx.add(Decoration.mark({ class: "cm-lp-link", attributes: { "data-href": href } }), node.from, node.to);
      }
    },
  },
  {
    // Thematic break (`***` / `---` / `___`) → a divider rule. The whole line content is
    // the glyph, so hiding it atomically would make the line un-landable (the caret skips
    // it). Treat it as a 1-line BLOCK (addAtomic records it for blockEntry): the caret is
    // redirected onto the line, which reveals the `***` for editing. When revealed, show
    // ONLY the raw `***` (no rule line) so the source is clear; the rule is the rendered
    // (not-revealed) state.
    match: (n) => n === "HorizontalRule",
    enter: (node, ctx) => {
      if (lineRevealed(ctx.state, node.from)) return; // editing → raw ***, no rule
      ctx.add(hrLine, ctx.state.doc.lineAt(node.from).from);
      ctx.addAtomic(hide, node.from, node.to);
    },
  },
  {
    // GFM table → an HTML table (block replace). Reveals raw markdown — and stays
    // editable — when the cursor is anywhere in the table. Offset-invariant: the
    // replace hides the range but never shifts offsets, so remote carets outside
    // the table stay correct (and one inside reveals it for that collaborator).
    match: (n) => n === "Table",
    enter: (node, ctx) => {
      const doc = ctx.state.doc;
      const from = doc.lineAt(node.from).from;
      // #141: the lezer GFM `Table` node ABSORBS immediately-following paragraph lines (no blank line
      // between), so the widget covered + collapsed those paragraphs and vim j/k skipped them (measured
      // {11,15} eating two trailing paragraphs). Clip to the contiguous run of pipe-bearing lines = the
      // actual table rows, so the widget covers only the table (matches tableBlockAt's clip).
      const startLine = doc.lineAt(node.from).number;
      const nodeEndLine = doc.lineAt(Math.max(node.from, Math.min(node.to, doc.length) - 1)).number;
      let endLine = startLine;
      for (let n = startLine; n <= nodeEndLine; n++) { if (doc.line(n).text.includes("|")) endLine = n; else break; }
      const to = doc.line(endLine).to;
      // Reveal raw source while the cursor is anywhere in the block's range. The block
      // can't be ENTERED by vertical motion (it's a collapsed widget) — the blockEntry
      // transaction filter redirects motion that would skip it INTO it, then these lines
      // are real and j/k/arrows traverse them one at a time.
      // GFM pipe table (ADR-101 4-quadrant, #216 comment 802): an EXPLICIT open (Ctrl+Enter / click →
      // openTableEditing sets render-active) mounts the in-editor WYSIWYG editor (#154) in EVERY quadrant,
      // vim included — the `active` check precedes the raw reveal, so it wins even when the caret sits in
      // the block. Just NAVIGATING the caret in (rangeRevealed, no active) still shows raw row-by-row
      // Live × vim's pure-Markdown editing (the deliberate quadrant behaviour). Only :::table/Excalidraw
      // non-typeable macros — never reveal source (#5).
      const active = ctx.state.field(macroRenderActiveField, false);
      if (active && active.from <= from && active.to >= to && !ctx.state.readOnly) {
        ctx.addAtomic(Decoration.replace({ widget: new EditableTableWidget(from, to, doc.sliceString(from, to)), block: true }), from, to);
        return;
      }
      if (rangeRevealed(ctx.state, from, to)) {
        // #216 comment 874: RAW-editing state (caret in the pipe table, `| a | b |` source visible) → this is
        // when to surface the RichUI-entry pill, NOT the rendered widget (the reversed condition the reviewer
        // rejected). LIVE + editable only: source mode already reveals everything raw, so a pill on every table
        // there would be noise. Mark the first line as the positioning context and float the pill above it.
        if (ctx.state.facet(displayMode) === "live") {
          ctx.add(macroRawLead, from);
          ctx.add(Decoration.widget({ widget: new MacroRawRichuiPill(from, openTableEditing, "table-richui-enter"), side: -1 }), from);
        }
        return;
      }
      ctx.addAtomic(Decoration.replace({ widget: new TableWidget(doc.sliceString(from, to)), block: true }), from, to);
    },
  },
  {
    // ![alt](wks-attachment:<id>) → an <img> (resolved to a fresh presigned URL).
    // Only OUR attachment refs are rendered; other image syntax is left as raw
    // markdown (no arbitrary external <img>). Reveals raw when the cursor is on the
    // line. Offset-invariant: replace hides the range but never shifts offsets.
    match: (n) => n === "Image",
    enter: (node, ctx) => {
      const m = ATTACHMENT_REF.exec(ctx.state.doc.sliceString(node.from, node.to));
      if (!m) return;
      if (lineRevealed(ctx.state, node.from)) return;
      ctx.addAtomic(Decoration.replace({ widget: new ImageWidget(m[2]!, m[1]!) }), node.from, node.to);
    },
  },
];

function buildDecorations(state: EditorState, themeOverride?: MacroTheme): {
  decorations: DecorationSet;
  atomic: DecorationSet;
  blocks: { from: number; to: number }[];
} {
  const all: Range<Decoration>[] = [];
  const hidden: Range<Decoration>[] = [];
  // Currently-collapsed full replaces (table / image / hr) — ranges the caret cannot
  // land on. blockEntry redirects vertical motion that would skip one INTO it (which
  // reveals it). Inline hideMarker ranges are NOT blocks (their line stays landable).
  const blocks: { from: number; to: number }[] = [];
  const ctx: RenderCtx = {
    state,
    macroTheme: themeOverride ?? currentMacroTheme(), // #200: effect payload on a theme switch, else the DOM

    add: (deco, from, to = from) => all.push(deco.range(from, to)),
    hideMarker: (from, to, deco = hide, atomic = true) => {
      if (from >= to) return;
      if (lineRevealed(state, from)) return;
      all.push(deco.range(from, to));
      // #141 bounce: an INLINE marker is atomic (horizontal motion skips the hidden glyph); a WHOLE-LINE
      // marker (a `:::` directive fence) must NOT be atomic — an atomic whole-line range is un-landable,
      // so vertical j/k skips the line and the caret can't step onto the fence to edit/reveal it.
      if (atomic) hidden.push(hide.range(from, to));
    },
    // #202 comment 779: like hideMarker but reveals ONLY when the caret sits ON THE MARKER ITSELF
    // (rangeRevealed on [from,to]) rather than anywhere on the line. A list marker's rendered ordinal/
    // glyph must update the instant you nest (Tab) or continue (Enter) — with line-wide reveal the caret
    // is still on the item, so the raw, un-renumbered source marker ("5.") shows and reads as a stale
    // ordinal. Tightening to the marker range keeps it editable WHILE you type "1. " (caret in the marker)
    // yet renders the widget the moment the caret is in the content. Source mode still shows raw.
    hideMarkerTight: (from, to, deco = hide, atomic = true) => {
      if (from >= to) return;
      if (rangeRevealed(state, from, to)) return;
      all.push(deco.range(from, to));
      if (atomic) hidden.push(hide.range(from, to));
    },
    addAtomic: (deco, from, to) => {
      if (from >= to) return;
      all.push(deco.range(from, to));
      hidden.push(hide.range(from, to));
      blocks.push({ from, to });
    },
    // #185 comment 781: has a block-replace widget already been emitted covering `pos`? A container
    // widget (tabs/columns) is emitted over its FULL resolver range; lezer's early-close leaves the
    // orphaned inner directive (e.g. the second tab) as a SIBLING node the walk still visits — skip it
    // so it isn't double-rendered (frame box / note fallback) on top of the container's own widget.
    coveredByBlock: (pos) => blocks.some((b) => pos >= b.from && pos < b.to),
    fenceLineStarts: new Set<number>(),
  };

  syntaxTree(state).iterate({
    enter: (node) => {
      // Mutually-exclusive matches by node name; descend by default (return void)
      // so child markers (HeaderMark, CodeMark, LinkMark/URL) are still visited. A renderer
      // returning false skips children (a layout-directive atom that rendered its own inner
      // :::column/:::tab — #90), so they aren't double-rendered.
      for (const r of RENDERERS) if (r.match(node.name)) return r.enter(node, ctx) === false ? false : undefined;
    },
  });

  // #185 sub-task 2b: lezer early-closes a nested `:::tabs` at an inner `::::columns` close, so some
  // directive fence lines are NOT lezer DirectiveMark nodes and leaked raw. resolveDirectiveRanges (the
  // stack-based single source of truth) knows EVERY fence; hide the open/close lines it identifies that
  // lezer did NOT already hide (fenceLineStarts). Reveal-on-cursor (skip while editing the block). Only
  // early-closed DESCEND containers (columns/tabs) leak, and those are never under a block-replace widget
  // (callout etc. parse correctly → their fences ARE in fenceLineStarts), so this never overlaps a replace.
  for (const dir of resolveDirectiveRanges(state.doc.toString())) {
    if (typeof window !== "undefined") { const w = window as unknown as { __pp?: unknown[] }; (w.__pp ??= []).push({ name: dir.name, from: dir.from, to: dir.to, closed: dir.closed, revealed: rangeRevealed(state, dir.from, dir.to), nested: caretInNestedMacro(state, dir.from, dir.to) }); }
    // #196 / ADR-092 (comment 740): innermost-wins — reveal a directive's raw fences ONLY when the caret
    // edits THIS directive itself, not when it's deeper inside a nested child. Without `!caretInNestedMacro`
    // a layout container (columns/tabs) whose nested callout is being edited kept its own `::::columns` /
    // `::::` fences raw (the leak): the caret is within the container's range, so plain `rangeRevealed` was
    // true. The frame + descend renderer keeps the container drawn, so hiding its fences here is correct.
    if (rangeRevealed(state, dir.from, dir.to) && !caretInNestedMacro(state, dir.from, dir.to)) continue; // editing this block → raw fences
    const openLine = state.doc.lineAt(dir.from);
    if (!ctx.fenceLineStarts.has(openLine.from) && openLine.from < openLine.to) ctx.hideMarker(openLine.from, openLine.to, undefined, false);
    if (dir.closed) {
      const closeLine = state.doc.lineAt(Math.min(dir.to, state.doc.length));
      if (!ctx.fenceLineStarts.has(closeLine.from) && closeLine.from < closeLine.to) ctx.hideMarker(closeLine.from, closeLine.to, undefined, false);
    }
  }

  return {
    decorations: Decoration.set(all, true),
    // #240: coalesce touching/adjacent hidden ranges before feeding atomicRanges. CM's
    // skipAtomicRanges only pushes the caret when a position is STRICTLY inside a range
    // (pos>from && pos<to), so an ISOLATED 1-char hidden marker (a LinkMark bracket, the `(`/`)`
    // around a link URL, a single backtick) can NEVER be skipped — the caret stops on every hidden
    // glyph, so crossing a link's `](url)` costs several phantom Arrow presses in WYSIWYG (where
    // markers never reveal). Merging the adjacent `]`,`(`,url,`)` into one wide run gives it
    // strictly-inside positions, so motion steps across the whole run at once. Visual hiding
    // (`decorations`) is untouched; only the atomic set is coalesced.
    atomic: Decoration.set(coalesceRanges(hidden), true),
    blocks,
  };
}

// Merge touching/overlapping ranges into contiguous runs (see #240 above). Input need not be sorted;
// all merged ranges carry a plain hide decoration (atomicRanges only reads the range boundaries).
function coalesceRanges(ranges: readonly Range<Decoration>[]): Range<Decoration>[] {
  if (ranges.length <= 1) return ranges.slice();
  const sorted = ranges.slice().sort((a, b) => a.from - b.from || a.to - b.to);
  const out: Range<Decoration>[] = [];
  let from = sorted[0]!.from, to = sorted[0]!.to;
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i]!;
    if (r.from <= to) to = Math.max(to, r.to); // touching or overlapping → extend the run
    else { out.push(hide.range(from, to)); from = r.from; to = r.to; }
  }
  out.push(hide.range(from, to));
  return out;
}

// A StateField (NOT a ViewPlugin): block decorations — the table render uses one
// may only be provided by a state field, not a plugin. Rebuilds on any doc change
// (covers local edits AND remote Yjs updates applied by yCollab) and any selection
// change (reveal-on-cursor). Provides the decoration set, the atomicRanges (so local
// cursor motion skips hidden markers), and the collapsed-block ranges (for blockEntry).
export const livePreview = StateField.define<{ decorations: DecorationSet; atomic: DecorationSet; blocks: { from: number; to: number }[] }>({
  create: (state) => buildDecorations(state),
  update: (value, tr) => {
    if (tr.docChanged || tr.selection) return buildDecorations(tr.state);
    // #237: the lezer parse advances ASYNCHRONOUSLY after load — a huge single-line block (e.g. a
    // heavy ```excalidraw fence) exhausts the initial parse budget mid-document, and the language
    // worker's progress dispatches carry no doc/selection change. This field then kept STALE
    // decorations built from the PARTIAL tree, so every block past the parse frontier stayed plain
    // text until some later selection change forced a rebuild — the "macros below a heavy macro
    // don't render until I click" bug (#203 is the excalidraw-specific observation). The parser
    // yields a NEW Tree object on every progress step, so an identity compare detects growth.
    if (syntaxTree(tr.startState) !== syntaxTree(tr.state)) return buildDecorations(tr.state);
    // Toggling vim is a Compartment reconfigure — no doc/selection/effect change — but it
    // flips reveal-on-cursor gating (revealAllowed): vim→non-vim must re-render every
    // rich-editable macro that was revealed under the caret. Rebuild on the facet change.
    if (tr.startState.facet(vimEnabled) !== tr.state.facet(vimEnabled)) return buildDecorations(tr.state);
    // Switching display mode (ADR-056 / #164) is a Compartment reconfigure (no doc/selection
    // change) but flips reveal globally (e.g. live→source reveals every construct). Rebuild.
    if (tr.startState.facet(displayMode) !== tr.state.facet(displayMode)) return buildDecorations(tr.state);
    // A fold toggle changes WHICH macro blocks render (folded → CM's placeholder owns
    // the range, so the macro widget must drop) but is neither a doc nor selection
    // change — rebuild so isFolded is re-evaluated and the stale widget is removed.
    // #215 / ADR-100: nested-selection / nested-edit are not doc/selection changes but change which nested
    // subtree draws the ring / editUI island — rebuild so the container widget re-renders.
    for (const e of tr.effects) if (e.is(foldEffect) || e.is(unfoldEffect) || e.is(setMacroRenderActive) || e.is(setNestedSelection) || e.is(setNestedEditActive)) return buildDecorations(tr.state);
    // #200: a theme change → rebuild so macro widgets pick up the new theme (their eq keys on theme,
    // so CM recreates them and liveRender re-exports for light/dark). Excalidraw etc. bake colours in.
    for (const e of tr.effects) if (e.is(redrawMacros)) return buildDecorations(tr.state, e.value); // #200: rebuild with the effect's theme (not the stale DOM)
    return value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
  ],
});

// ADR-024 atom motion. Every block decoration (macro / table / image / hr) is an ATOM
// a single motion stop. The caret cannot land INSIDE the replace widget's atomic range, so
// a one-line vertical key (j/k/arrow) that would step from the line BEFORE the block to the
// line AFTER it (CM's atomicRanges skip the whole widget in one key) is redirected to land
// ON the block's near edge — its single stop. Combined with ADR-024 1b (macros no longer
// auto-reveal), landing there keeps a macro rendered (the atom is selected, not expanded),
// so the next same-direction key steps off PAST it: j/k treat the macro as one stop and
// step over it. Non-macro blocks (pipe table / image) still reveal on landing
// (rangeRevealed/lineRevealed) and drop out of `blocks`, so the caret edits their source
// line-by-line as before. A multi-line jump (gg/G/}) whose target is OUTSIDE the block is
// left alone — it lands at its real target (gg/G are never hijacked). The overshoot clamp
// handles a tall block that makes a single key OVERSHOOT the adjacent line. The whole class
// (#3 / overshoot / G-stop / k-warp) is handled here, uniformly. Display-only; doc untouched.
let lastVerticalStep = false;
export const motionKeyTracker: Extension = Prec.highest(
  EditorView.domEventHandlers({
    keydown(e) {
      lastVerticalStep = e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "j" || e.key === "k";
      return false; // never consume — vim/CM still handle the key
    },
    mousedown() {
      lastVerticalStep = false;
      return false;
    },
  }),
);

// Pure atom-motion decision (#183 symptom C): given a one-line vertical step from `oldLine` to
// `newLine` (dir ±1, 1-based) and the atom block ranges `atoms` (line spans), return the line to
// REDIRECT the caret to, or null to accept CM's landing. Cases
// 1. caret ON an atom → step OFF to the line just outside it (down→last+1, up→first-1).
// 2. caret just OUTSIDE, stepping INTO or PAST the atom → land on its near edge (down→first,
// up→last). The `into` part is the symptom-C fix: when the atom sits at EOF/BOF, CM can't land
// on a line PAST it (none exists), so it lands INSIDE (on last/first) — the old `>= last+1` /
// `<= first-1` test missed that, leaving the caret mid-atom and skipping the near edge asymmetrically.
// 3. overshoot clamp: a tall atom strictly between old and new (caret not on it) → clamp to the
// adjacent line (one line per key), so the next key lands on it (case 2) and steps off (case 1).
// Pure → unit-tested directly; symmetric up/down by construction.
export function atomMotionTarget(
  oldLine: number, newLine: number, dir: 1 | -1,
  atoms: ReadonlyArray<{ first: number; last: number }>, totalLines: number,
): number | null {
  for (const { first, last } of atoms) {
    if (oldLine >= first && oldLine <= last) { // 1. on the atom → step off (one stop)
      const t = dir === 1 ? last + 1 : first - 1;
      return t >= 1 && t <= totalLines && t !== oldLine ? t : null;
    }
    if (dir === 1 && oldLine === first - 1 && newLine >= first) return first; // 2. down into/past → first
    if (dir === -1 && oldLine === last + 1 && newLine <= last) return last;   // 2. up into/past → last
  }
  const adj = oldLine + dir; // 3. overshoot clamp
  if (adj >= 1 && adj <= totalLines && newLine !== adj) {
    const lo = Math.min(oldLine, newLine), hi = Math.max(oldLine, newLine);
    const crossed = atoms.some(({ first, last }) => first >= lo && last <= hi && !(oldLine >= first && oldLine <= last));
    // A single j/k must move EXACTLY one line. #183 symptom C: a hidden-marker line (a ```lang code
    // fence, reveal-on-cursor) can make CM's DOWN motion overshoot the adjacent landable line while UP
    // lands on it (the reported asymmetric skip). Clamp any >1-line single-step — whether it crossed a
    // motion atom OR overshot a plain landable line — to the adjacent line, so no landable line is skipped.
    if (crossed || Math.abs(newLine - oldLine) > 1) return adj;
  }
  return null;
}

// #141/#183: display-math ($$…$$) atoms live in a SEPARATE field (mathField), NOT in livePreview.blocks,
// so blockEntry's vertical-motion correction never saw them → j overshot a math block by its rendered
// height and k warped up from anywhere below (the reported asymmetry). A provider facet lets math.ts
// (which already imports decorations) contribute its atom ranges WITHOUT a circular import here.
export const motionAtomProvider = Facet.define<(state: EditorState) => ReadonlyArray<{ from: number; to: number }>>({});

// #141 bounce (comment 651): a block the caret sits STRICTLY inside is REVEALED (its raw source is
// shown, editable, non-atomic) — it must move line-by-line like ordinary text, never be crossed as a
// single motion atom. A COLLAPSED block (macro widget / math) is atomic, so the caret only ever rests
// at its EDGE (from or to), never strictly inside — those stay motion atoms and keep their overshoot
// clamp. Pure: the motion-atom set for a given caret. (This is why a `:::info`/`:::xxx` block whose
// body is being edited must not warp j/k across its fences — it's revealed, so it drops out here.)
// `lineNo(pos)` maps an offset to its 1-based line number. The "revealed → drop" test is by LINE, not by
// offset: a block is dropped ONLY when the caret is on an INTERIOR line (strictly between its first and last
// line) — a revealed block whose body is being edited line-by-line. When the caret is on the block's FIRST
// or LAST line it sits at a motion EDGE (vertical j/k parks it there), and the block MUST stay a motion atom
// so the next key can step OFF it in one press. #221: the old OFFSET test (`head > from && head < to`) wrongly
// dropped a multi-line atom when up-motion parked the caret at its last line's START (`doc.line(last).from`,
// which is strictly-inside by offset) — so k stepped through the atom line-by-line while j (which parks at
// the FIRST line's start = `from` exactly, not strictly-inside) did not: the reported k/j asymmetry.
export function motionAtomsForCaret(
  blocks: ReadonlyArray<{ from: number; to: number }>,
  head: number,
  lineNo: (pos: number) => number,
): { from: number; to: number }[] {
  const hLine = lineNo(head);
  return blocks.filter((b) => !(hLine > lineNo(b.from) && hLine < lineNo(b.to))).map((b) => ({ from: b.from, to: b.to }));
}

export const blockEntry: Extension = EditorState.transactionFilter.of((tr) => {
  if (tr.docChanged || !tr.selection) return tr;
  const baseBlocks = tr.startState.field(livePreview, false)?.blocks ?? [];
  // Merge the base block atoms (excluding any the caret is editing inside — motionAtomsForCaret) with
  // any provider atoms (display math, always collapsed), so motion is corrected over both without
  // hijacking line-by-line editing inside a revealed block.
  const blocks = motionAtomsForCaret(baseBlocks, tr.startState.selection.main.head, (p) => tr.startState.doc.lineAt(p).number);
  for (const provide of tr.startState.facet(motionAtomProvider)) for (const r of provide(tr.startState)) blocks.push(r);
  if (!blocks.length) return tr;
  const oldSel = tr.startState.selection.main;
  const newSel = tr.newSelection.main;
  // Only a caret MOTION, not a shift/visual selection expansion (anchor stays put).
  if (!newSel.empty && newSel.anchor === oldSel.anchor) return tr;
  const doc = tr.startState.doc;
  const oldHead = oldSel.head;
  const newHead = newSel.head;
  if (newHead === oldHead) return tr;
  const oldLine = doc.lineAt(oldHead).number;
  const newLine = doc.lineAt(newHead).number;
  const dir = newHead < oldHead ? -1 : 1;
  // Atom motion is for a one-line KEY (j/k/arrow) only — GATED on a real vertical key so a
  // jump (gg/G/}) is never hijacked onto an atom (a jump's endpoints can coincide with an
  // atom's edges when the caret sits right beside it). Two cases, both explicit so a TALL
  // widget's visual height can't make CM overshoot the adjacent line
  // 1. caret ON the atom → step OFF to the line just outside it (down → last+1, up →
  // first-1). This is the fix for the device bug: trusting CM's landing here overshot
  // past a tall macro by its rendered height.
  // 2. caret OUTSIDE, a step that reached/over the atom (incl. an overshoot) → land ON it
  // (one stop; down → first line, up → last line).
  if (lastVerticalStep) {
    const atoms = blocks.map((b) => ({ first: doc.lineAt(b.from).number, last: doc.lineAt(b.to).number }));
    const target = atomMotionTarget(oldLine, newLine, dir as 1 | -1, atoms, doc.lines);
    if (target !== null) return { selection: EditorSelection.cursor(doc.line(target).from), scrollIntoView: true };
  }
  return tr;
});

// #240: in WYSIWYG a hidden inline run (coalesced above) still leaves ONE phantom stop at its near
// edge — CM's skipAtomicRanges only pushes a caret STRICTLY inside a range, so a single-char step
// that lands exactly on a run's boundary (the visually-invisible edge) rests there before the next
// press jumps across. This filter completes the fix: a one-char horizontal step whose new head lands
// on a hidden run's near boundary (or, defensively, inside it) snaps across the whole run, so motion
// is exactly per-VISIBLE-character (zero phantom presses). WYSIWYG-only (Live reveals on cursor,
// Source is raw; vim ⟂ WYSIWYG per #174). Shift-expansion snaps the head too (selection stays
// visible-char granular). Display-only: it never changes the doc, only the caret's resting offset.
// #240 comment 960: whether vim is in an ON-CHAR motion mode (normal / visual). wysiwygInlineSkip below
// uses BETWEEN-char (insert-caret) snap semantics and MUST NOT run for vim normal/visual — there the vim
// caret rests ON a char and vimWysiwygCaretGuard (vim-atom.ts) already handles hidden-run avoidance;
// applying the filter too made leftward `h` snap onto a hidden char, which the guard then re-corrected,
// skipping a visible char (and cascading across adjacent runs). A transactionFilter can't read vim state
// (it's view-dependent via getCM), so the guard mirrors the mode into this field and the filter reads it.
export const setVimMotionActive = StateEffect.define<boolean>();
const vimMotionActive = StateField.define<boolean>({
  create: () => false,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setVimMotionActive)) return e.value;
    return v;
  },
});

export const wysiwygInlineSkip: Extension = [vimMotionActive, EditorState.transactionFilter.of((tr) => {
  if (tr.docChanged || !tr.selection) return tr;
  if (tr.startState.facet(displayMode) !== "wysiwyg") return tr;
  if (tr.startState.field(vimMotionActive, false)) return tr; // #240: vim normal/visual — leave it to the guard
  const oldHead = tr.startState.selection.main.head;
  const newSel = tr.newSelection.main;
  const newHead = newSel.head;
  if (Math.abs(newHead - oldHead) !== 1) return tr; // single-char arrow step only (not jumps/word-motion)
  const atomic = tr.startState.field(livePreview, false)?.atomic;
  if (!atomic) return tr;
  const dir = newHead > oldHead ? 1 : -1;
  let target: number | null = null;
  atomic.between(newHead, newHead, (from, to) => {
    if (dir > 0 && newHead === from) target = to;        // entering a run from its left edge → far edge
    else if (dir < 0 && newHead === to) target = from;   // entering from its right edge
    else if (newHead > from && newHead < to) target = dir > 0 ? to : from; // defensive: strictly inside
    if (target !== null) return false;
  });
  if (target === null || target === newHead) return tr;
  return {
    selection: newSel.empty ? EditorSelection.cursor(target) : EditorSelection.range(newSel.anchor, target),
    scrollIntoView: true,
  };
})];

// ADR-024 dd/yy on an atom (Q3, Mode A) live in live-preview/vim-atom.ts — they remap the
// vim dd/yy *actions* to target the whole macro (register + delete), keeping the register
// correct so `p` pastes the whole macro. (Earlier a transactionFilter expanded the delete
// but couldn't set the register or handle yy; the vim-action approach does both.)

// ADR-024: "enter" a macro atom at a position — the explicit way to start editing a macro
// (Ctrl+Enter in vim, click with the mouse). A modal macro (Excalidraw) opens its modal;
// an inline/source macro becomes render-active (table → the cell-edit widget; mermaid /
// callout → revealed source via macroRenderActiveField). Returns true if a macro was
// entered. Display-only: the document is untouched; presence/collab unaffected.
export function enterMacroAt(view: EditorView, pos: number, raw = false): boolean {
  if (view.state.readOnly) return false;
  if (tableBlockAt(view.state, pos)) return openTableEditing(view, pos); // pipe OR :::table (#86)
  const fence = macroFenceAt(view.state, pos);
  if (fence) {
    if (fence.macro.richEditUI?.present === "modal") {
      openMacroModal(view, fence.macro, () => fence.from, currentMacroTheme());
    } else {
      // #174 addendum: a ``` -notation macro's Ctrl+Enter (raw=true) reveals the RAW source (vim-editable);
      // the ✎ button (raw=false) opens the editUI. `raw` only matters for an editUI macro (mermaid); a
      // legacy source macro reveals raw either way.
      view.dispatch({ selection: EditorSelection.cursor(fence.from), effects: setMacroRenderActive.of({ from: fence.from, to: fence.to, raw }) });
      view.focus();
    }
    return true;
  }
  const dir = directiveMacroAt(view.state, pos);
  if (dir) {
    view.dispatch({ selection: EditorSelection.cursor(dir.from), effects: setMacroRenderActive.of({ from: dir.from, to: dir.to }) });
    view.focus();
    return true;
  }
  return false;
}

// Ctrl+Enter (ADR-024 Q1): enter the macro atom at the caret. event.key "Enter" is
// layout/JIS-safe. Bound via the editor keymap; remappable later (#4).
export function enterMacroCommand(view: EditorView): boolean {
  // #174 comment 1003 / ADR-100 (innermost-wins): if a NESTED macro (inside a columns/tabs container) is
  // selected, Ctrl+Enter opens ITS editUI — the same target as the nested ✎ — not the container's. In
  // WYSIWYG the container is one atom (the caret can't sit inside), so a nested macro is reached by click
  // (setNestedSelection); this makes the keyboard entry match the mouse one for the selected nested macro.
  const nsel = view.state.field(nestedSelectionField, false);
  if (nsel && enterNestedMacroAt(view, nsel)) return true;
  // #174 addendum: otherwise Ctrl+Enter reveals RAW source (raw=true) — for a ``` editUI macro (mermaid)
  // that means the vim-editable source, NOT the editUI (which the ✎ button opens). Harmless for others.
  return enterMacroAt(view, view.state.selection.main.head, true);
}

// Follows a clickable link's data-href. In a READ-ONLY (view) surface a plain click
// navigates; in the editable surface a plain click must still place the cursor (→
// reveal raw markdown), so there only a modifier-click (Cmd/Ctrl) follows the link.
// Opens in a new tab with noopener — never mutates the document (ADR-008 holds).
export const linkClicks = EditorView.domEventHandlers({
  click(e, view) {
    const el = (e.target as HTMLElement | null)?.closest?.(".cm-lp-link") as HTMLElement | null;
    const href = el?.getAttribute("data-href");
    if (!href) return false;
    if (!view.state.readOnly && !e.metaKey && !e.ctrlKey) return false;
    window.open(href, "_blank", "noopener,noreferrer");
    e.preventDefault();
    return true;
  },
});

export const livePreviewTheme = EditorView.baseTheme({
  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-emphasis": { fontStyle: "italic" },
  ".cm-lp-strike": { textDecoration: "line-through", opacity: "0.75" },
  ".cm-lp-inline-code": {
    fontFamily: "var(--font-code)", // #190: code face (Wikistead Mono), distinct from prose --font-body
    background: "rgba(127,127,127,0.18)",
    borderRadius: "3px",
    padding: "0 3px",
  },
  ".cm-lp-link": { color: "var(--link, #4ea1ff)", textDecoration: "underline" }, // #223: semantic token, not a hardcoded blue
  // In the read-only render links are click-to-open, so show the affordance there.
  ".cm-content[contenteditable=false] .cm-lp-link[data-href]": { cursor: "pointer" },
  // #224 / ADR-104: auto internal links — a subtler affordance than explicit links (dotted underline) so a
  // title match reads as "there's a page here" without competing with authored [text](url) links.
  ".cm-lp-title-link": { color: "#83c092", textDecoration: "underline dotted", cursor: "pointer" },
  // #190: headings follow the PROSE font (--font-body) too, so the user's font choice / locale default
  // applies to titles, not just body. .cm-content already sets --font-body (cm-theme.ts) and headings
  // inherit it, but set it EXPLICITLY here so no inherited/default family can strand headings on a
  // different face than the body (the bounce: titles didn't track the font selection).
  ".cm-lp-h": { fontWeight: "700", lineHeight: "1.3", fontFamily: "var(--font-body)" },
  ".cm-lp-h1": { fontSize: "1.8em" },
  ".cm-lp-h2": { fontSize: "1.5em" },
  ".cm-lp-h3": { fontSize: "1.3em" },
  ".cm-lp-h4": { fontSize: "1.15em" },
  ".cm-lp-h5": { fontSize: "1.05em" },
  ".cm-lp-h6": { fontSize: "1em", opacity: "0.85" },
  ".cm-lp-code-line": {
    fontFamily: "var(--font-code)", // #190: fenced code uses the code face, not prose --font-body
    background: "rgba(127,127,127,0.12)",
  },
  // #198 / ADR-094: code-fence attribute chrome. Header band (title + lang), line-number gutter,
  // highlighted lines. All display-only; token colours (#158-C2) sit ABOVE the highlight background.
  // #198 bounce: inline-flex (not block flex) so the header sits ON the opening fence line it replaces
  // no residual blank line above the code body. Title + lang read as a compact header chip.
  // #198 (comment 724, B): the opening-line row spans the code width — a filename TAB at the left, a
  // copy button at the right. The tab reads like an editor tab: rounded top corners only, flush on top of
  // the code card below (no bottom edge between them). inline-flex + width so it sits on the (otherwise
  // hidden) opening fence line without a residual blank line.
  ".cm-lp-code-header": {
    fontFamily: "var(--font-ui)", display: "inline-flex", width: "100%", boxSizing: "border-box",
    alignItems: "flex-end", justifyContent: "space-between", verticalAlign: "middle", fontSize: "0.8em",
  },
  ".cm-lp-code-tab": {
    display: "inline-flex", alignItems: "center", gap: "0.55em", padding: "0.1em 0.7em",
    background: "var(--panel-2, #2d2d2e)", color: "var(--fg)",
    border: "1px solid var(--border, #3a3a3a)", borderBottom: "none",
    borderRadius: "6px 6px 0 0", // tab: top corners only; bottom overlaps onto the code card
    // #198 comment 770 (3): sit the tab ON TOP of the card (overlap its top border) so the tab's flat
    // bottom covers the card's rounded top-left corner and reads as connected — the card stays a clean
    // rounded rectangle, only the tab-width slice at the left is flattened by the overlap.
    position: "relative", zIndex: "1", marginBottom: "-1px",
  },
  ".cm-lp-code-title": { fontWeight: "600" },
  ".cm-lp-code-lang": { color: "var(--fg-dim, #888)", textTransform: "uppercase", letterSpacing: "0.03em", fontSize: "0.9em" },
  // The copy button — top-right, subtle until hovered; turns accent on the transient ✓ after a copy.
  ".cm-lp-code-copy": {
    display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
    marginLeft: "auto", // #174 comment 948: stay top-right even when there is no tab (lang-less fence)
    padding: "0.2em", marginBottom: "0.15em", borderRadius: "5px", border: "1px solid transparent",
    background: "transparent", color: "var(--fg-dim, #888)", opacity: "0.65", transition: "opacity 120ms ease, background 120ms ease, color 120ms ease",
  },
  ".cm-lp-code-copy:hover": { opacity: "1", background: "var(--hover, rgba(128,128,128,0.16))", color: "var(--fg)" },
  ".cm-lp-code-copy.cm-lp-code-copied": { opacity: "1", color: "var(--accent, #4ea1ff)" },
  // #198 (comment 752): the code card corners — SAME base card for plain and attributed fences. Individual
  // corner radii (not the shorthand) so a single-line fence (first AND last) rounds all four corners. When a
  // tab is present (cm-lp-code-tabbed, declared AFTER so it wins) the top-left flattens to connect the tab.
  ".cm-lp-code-first": { borderTopLeftRadius: "6px", borderTopRightRadius: "6px" },
  ".cm-lp-code-last": { borderBottomLeftRadius: "6px", borderBottomRightRadius: "6px" },
  ".cm-lp-code-numbered": { paddingLeft: "3.2em", position: "relative" },
  ".cm-lp-code-numbered::before": {
    content: "attr(data-linenum)", position: "absolute", left: "0", width: "2.6em", textAlign: "right",
    color: "var(--fg-dim, #888)", userSelect: "none", opacity: "0.7",
  },
  ".cm-lp-code-hl": { background: "color-mix(in srgb, var(--accent) 14%, transparent)", boxShadow: "inset 2px 0 0 var(--accent)" },
  ".cm-lp-quote": {
    borderLeft: "3px solid var(--border, #888)",
    paddingLeft: "0.8em",
    color: "var(--fg-dim, #888)",
  },
  // Thematic break: the glyph is hidden, so the empty line shows a rule. NOTE: never
  // zero the line height — a 0-height .cm-line corrupts CodeMirror's vertical-motion
  // geometry (caret jumps over lines). Draw the rule with a centered border instead.
  ".cm-lp-hr": {
    borderTop: "2px solid var(--border, #888)",
  },
  ".cm-lp-bullet": { paddingRight: "0.25em" },
  // #202: the ordered-list ordinal (per-level style: decimal / lower-alpha / lower-roman). Tabular so
  // widths align down a list; the raw source number is hidden (this widget replaces it).
  ".cm-lp-ordinal": { paddingRight: "0.35em", fontVariantNumeric: "tabular-nums" },
  // Task checkbox: replaces the raw `[ ]`/`[x]`. Sits inline with the list text; the
  // accent cursor signals it is clickable (disabled = read-only, no edit permission).
  ".cm-lp-checkbox": { verticalAlign: "middle", margin: "0 0.35em 0 0", cursor: "pointer", accentColor: "var(--accent)" },
  ".cm-lp-checkbox:disabled": { cursor: "default", opacity: "0.7" },
  // padding NOT margin (see cm-lp-macro-wrap): a pipe TableWidget's root IS this <table>,
  // so its margin would be uncounted in CM's heightMap and accumulate across stacked
  // tables. Table padding is inside the table box → included in getBoundingClientRect.
  ".cm-lp-table": { borderCollapse: "collapse", padding: "0.4em 0", fontSize: "0.95em" },
  ".cm-lp-table th, .cm-lp-table td": {
    border: "1px solid var(--border, #444)",
    padding: "3px 8px",
    textAlign: "left",
    // #197 (comment 638): a min row height so an EMPTY cell/row doesn't collapse to a sliver. In table
    // layout `height` acts as a minimum, so every row is at least ~1 line tall whether it has text or not.
    height: "1.8em",
    verticalAlign: "top",
  },
  // #197: a PALE, token-driven header (was a hardcoded grey wash). Neutral surface + --fg text so the
  // header is always readable in any theme — no accent tint that could clash with the header text.
  ".cm-lp-table th": { background: "var(--panel-2, #f0f1f3)", color: "var(--fg)", fontWeight: "700" },
  ".cm-lp-image": { maxWidth: "100%", height: "auto", borderRadius: "4px", verticalAlign: "bottom" },
  // Macro block (e.g. ```mermaid). The wrap is relative so the fold button can sit in
  // a corner; the rendered DOM is whatever the macro's liveRender returns.
  // padding NOT margin: CM measures a block widget's height via getBoundingClientRect /
  // offsetHeight, which EXCLUDE margin. Margin on the widget root is therefore uncounted in
  // the heightMap and accumulates across stacked widgets → vim/arrow motion below 2+ macros
  // drifts by a line. Padding is included in the measured height, so the heightMap matches.
  ".cm-lp-macro-wrap": { position: "relative", padding: "0.4em 0" },
  // ADR-024 atom selection: the caret resting on the atom rings it (selected as a unit).
  ".cm-lp-atom-sel": { outline: "2px solid var(--accent, #4ea1ff)", outlineOffset: "1px", borderRadius: "4px" },
  // #174 / ADR-087: mouse HOVER shows a subtle block-boundary highlight on EVERY block macro
  // (columns/tabs/table/mermaid/…), so a mouse user sees the block is an interactive unit — parity
  // with the selection ring. `:not(.cm-lp-atom-sel)` so the accent selection ring wins when selected.
  // Display-only (never edits/offsets).
  ".cm-lp-macro-wrap:hover:not(.cm-lp-atom-sel)": { outline: "1px solid var(--border, #888)", outlineOffset: "1px", borderRadius: "4px" },
  ".cm-lp-macro": { display: "block", overflowX: "auto" },
  // #255: diagram alignment (mermaid/plantuml/excalidraw). Column flex on the wrap centres/pushes the
  // rendered block (align-items works regardless of the child's display; the absolute ✎ button is
  // out of flow, unaffected). Center is the default; only diagram wraps carry a cm-lp-align-* class.
  ".cm-lp-align-center": { display: "flex", flexDirection: "column", alignItems: "center" },
  ".cm-lp-align-left": { display: "flex", flexDirection: "column", alignItems: "flex-start" },
  ".cm-lp-align-right": { display: "flex", flexDirection: "column", alignItems: "flex-end" },
  // #108 external embed: a responsive 16:9 sandboxed iframe; the degrade link is a plain inline link.
  ".cm-lp-embed-frame": { display: "block", width: "100%", aspectRatio: "16 / 9", border: "1px solid var(--border, #3a3a3a)", borderRadius: "6px", background: "var(--panel, #1e1e1e)" },
  ".cm-lp-embed-degrade": { display: "inline-block", wordBreak: "break-all" },
  // #92 presence badge: a small "N editing" pill with a coloured dot per remote editor, drawn just
  // before a macro whose modal a peer has open. Display-only; sits inline at the anchor.
  ".cm-lp-macro-presence": { display: "inline-flex", alignItems: "center", gap: "0.25em", margin: "0 0.35em 0 0", padding: "0.05em 0.4em", borderRadius: "999px", background: "var(--panel-2, #2d2d2e)", border: "1px solid var(--border, #3a3a3a)", fontSize: "0.75em", verticalAlign: "middle", userSelect: "none" },
  ".cm-lp-macro-presence-dot": { display: "inline-block", width: "0.6em", height: "0.6em", borderRadius: "50%", flex: "0 0 auto" },
  ".cm-lp-macro-presence-label": { color: "var(--fg-dim, #9a9a9a)", whiteSpace: "nowrap" },
  // pointer-events:none on the SVG so a click on the diagram falls through to the macro
  // container (CM then places the caret → reveal-on-cursor shows the raw source). An
  // SVG-internal click can't be mapped to a doc position, so without this clicking a
  // diagram wouldn't reveal it. Scoped to the svg so the container stays hoverable
  // (the fold button shows on hover).
  ".cm-lp-mermaid svg": { maxWidth: "100%", height: "auto", pointerEvents: "none" },
  // #174 / ADR-087: the mermaid inline editUI — source textarea beside a live preview (stacks on a
  // narrow block). The preview reuses the .cm-lp-mermaid svg sizing above.
  ".cm-lp-mermaid-edit": { display: "flex", gap: "0.8em", alignItems: "stretch", flexWrap: "wrap" },
  ".cm-lp-mermaid-edit-src": { flex: "1 1 16em", minWidth: "12em", minHeight: "8em", resize: "vertical", fontFamily: "var(--font-code, monospace)", fontSize: "0.85em", border: "1px solid var(--border, #888)", borderRadius: "6px", padding: "0.5em", background: "var(--bg, #fff)", color: "var(--fg, inherit)" },
  ".cm-lp-mermaid-edit-preview": { flex: "1 1 16em", minWidth: "12em", display: "flex", alignItems: "center", justifyContent: "center", border: "1px dashed var(--border, #888)", borderRadius: "6px", padding: "0.5em", overflow: "auto" },
  // #174 / ADR-087 addendum: the plantuml editUI — same split as mermaid (source textarea + a degraded
  // code preview, since plantuml has no bundled renderer). Reuses the mermaid geometry.
  ".cm-lp-plantuml-edit": { display: "flex", gap: "0.8em", alignItems: "stretch", flexWrap: "wrap" },
  ".cm-lp-plantuml-edit-src": { flex: "1 1 16em", minWidth: "12em", minHeight: "8em", resize: "vertical", fontFamily: "var(--font-code, monospace)", fontSize: "0.85em", border: "1px solid var(--border, #888)", borderRadius: "6px", padding: "0.5em", background: "var(--bg, #fff)", color: "var(--fg, inherit)" },
  ".cm-lp-plantuml-edit-preview": { flex: "1 1 16em", minWidth: "12em", border: "1px dashed var(--border, #888)", borderRadius: "6px", padding: "0.5em", overflow: "auto" },
  // #174 / ADR-087: the callout editUI — a type/label bar above a body textarea.
  // #174 comment 878 point 1 + 883: a titled panel with a labelled field per control (Type / Header /
  // Content), stacked vertically, styled with the design-system tokens so it does not read as a bare form.
  ".cm-lp-callout-edit": { display: "flex", flexDirection: "column", gap: "0.6em", padding: "0.6em", border: "1px solid var(--border, #888)", borderRadius: "8px", background: "var(--panel, var(--bg, #fff))" },
  ".cm-lp-callout-edit-title": { fontSize: "0.78em", fontWeight: "600", letterSpacing: "0.02em", color: "var(--fg-dim, #888)" },
  ".cm-lp-callout-edit-field": { display: "flex", flexDirection: "column", gap: "0.25em" },
  ".cm-lp-callout-edit-cap": { fontSize: "0.72em", fontWeight: "600", color: "var(--fg-dim, #888)" },
  // #174 comment 883: the Type field is a wrapping row of visual type chips (shared calloutTypeOption).
  // Chip look itself lives in callout-icons.css (GLOBAL) so the body-mounted badge menu gets it too.
  ".cm-lp-callout-edit-types": { display: "flex", gap: "0.4em", flexWrap: "wrap" },
  ".cm-lp-callout-edit-label": { width: "100%", boxSizing: "border-box", minWidth: "6em", fontSize: "0.85em", padding: "0.3em 0.5em", border: "1px solid var(--border, #888)", borderRadius: "6px", background: "var(--bg, #fff)", color: "var(--fg, inherit)" },
  ".cm-lp-callout-edit-body": { width: "100%", boxSizing: "border-box", minHeight: "5em", resize: "vertical", fontFamily: "var(--font-code, monospace)", fontSize: "0.85em", border: "1px solid var(--border, #888)", borderRadius: "6px", padding: "0.5em", background: "var(--bg, #fff)", color: "var(--fg, inherit)" },
  ".cm-lp-macro-error": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "var(--danger, #c00)",
    background: "rgba(127,127,127,0.12)",
    borderRadius: "4px",
    padding: "0.4em 0.6em",
  },
  // #210 bounce (comment 699): the action buttons sit in a hover row ABOVE the macro — OUTSIDE its content
  // box — not on top of it. An <iframe> (embed-external, e.g. a playing YouTube) is a stacking context AND
  // a pointer sink that captures clicks regardless of z-index, so a button OVER the iframe was unclickable.
  // A row above the widget (in the block's top margin) is never over the iframe, so every macro's buttons
  // (edit / retarget / fold) are reliably clickable — the Notion block-hover pattern, uniform across macros.
  ".cm-lp-macro-edit, .cm-lp-macro-retarget, .cm-lp-macro-align": {
    position: "absolute",
    top: "-1.55em", // above the content box (outside the iframe/widget), in the block's top margin
    display: "inline-flex", // centres the Lucide SVG (#174) / the fold glyph
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid var(--border, #888)",
    borderRadius: "4px",
    background: "var(--panel, #fff)",
    color: "var(--fg-dim, #888)",
    cursor: "pointer",
    fontSize: "0.8em",
    lineHeight: "1",
    padding: "2px 5px",
    opacity: "0",
    zIndex: "3", // above the rendered content (belt-and-braces; the real fix is being OUTSIDE the box)
    pointerEvents: "auto",
    transition: "opacity 120ms",
  },
  // Left-aligned row (top-left of the block). edit and retarget never co-occur (editUI macros vs embeds),
  // so both take the first slot; fold sits in the second slot next to an edit button (Excalidraw).
  ".cm-lp-macro-edit": { left: "0" },
  ".cm-lp-macro-retarget": { left: "0" },
  // #255: the diagram align toggle sits just RIGHT of the ✎ (which is at left:0), same top row.
  ".cm-lp-macro-align": { left: "1.7em" },
  // #216 comment 836: the pipe-table wrap positions the hover-revealed RichUI-entry button at the table's
  // top-left. fit-content keeps the wrap the table's width so the button aligns to the table's left edge
  // (not the full editor width). The button reuses .cm-lp-macro-edit chrome; reveal it on wrap hover.
  ".cm-lp-table-wrap": { position: "relative", width: "fit-content", maxWidth: "100%" },
  // #216 comment 874 / #174 comment 878 (ADR-087 addendum 2): the SHARED RichUI-entry pill on the RAW-editing
  // state of a macro (pipe table + callout). Anchored to the first revealed line (.cm-lp-macro-raw =
  // position:relative) and floated JUST ABOVE it so it never covers the raw source it advertises. ALWAYS
  // visible (opacity 0.8, full on hover) — reliably recognizable without a hover (the #216 show/no-show
  // regression was hover-dependency). Solid panel bg + border are inherited from .cm-lp-macro-edit; this rule
  // must follow .cm-lp-macro-edit in source order so its top/left/opacity/display win at equal specificity.
  ".cm-lp-macro-raw": { position: "relative" },
  ".cm-lp-macro-richui-raw": { top: "-1.5em", left: "0", zIndex: "4", opacity: "0.8", display: "inline-flex", alignItems: "center", gap: "3px", padding: "1px 5px" },
  ".cm-lp-macro-richui-key": { fontSize: "0.72em", fontWeight: "600", letterSpacing: "0.02em" },
  ".cm-lp-macro-richui-raw:hover": { opacity: "1" },
  // #254: the LAYOUT-only variant for the ✎+Ctrl+↵ hint on a RENDERED macro. Adds the key's gap but NOT
  // the always-visible opacity of cm-lp-macro-richui-raw, so the button keeps the base opacity:0 and is
  // revealed only by the hover/selection gate (below for macro-wrap; the callout-panel rule for the panel).
  ".cm-lp-macro-edit-hint": { gap: "3px" },
  ".cm-lp-callout-panel-editable:hover .cm-lp-callout-panel-edit": { opacity: "1" },
  // #174 / ADR-087 (Class 1): the callout icon-badge type picker + the shared type CHIP now live in
  // callout-icons.css (GLOBAL) — the menu is mounted on document.body, outside .cm-editor, where these
  // baseTheme rules never applied; and keeping a baseTheme copy would OVERRIDE the global chip look for
  // the editUI panel's in-editor chips (higher editor-scoped specificity). One source: the global sheet.
  // #213: columns/tabs structural add/remove bar — bottom-right, shown on hover/selection (same gating
  // as the edit button). Sits below the content so it doesn't overlap the child bodies.
  ".cm-lp-macro-layoutbar": { position: "absolute", bottom: "-0.6em", right: "0", display: "inline-flex", gap: "0.25em", opacity: "0", transition: "opacity 120ms", zIndex: "3", pointerEvents: "auto" },
  ".cm-lp-macro-layoutbtn": { display: "inline-flex", alignItems: "center", justifyContent: "center", width: "1.5em", height: "1.5em", border: "1px solid var(--border, #888)", borderRadius: "4px", background: "var(--panel, #fff)", color: "var(--fg-dim, #888)", cursor: "pointer", fontSize: "0.85em", lineHeight: "1", padding: "0" },
  ".cm-lp-macro-wrap:hover .cm-lp-macro-layoutbar, .cm-lp-macro-wrap.cm-lp-atom-sel .cm-lp-macro-layoutbar": { opacity: "1" },
  // Visible on mouse hover AND when the atom is SELECTED via caret-entry (#174/ADR-087 — the
  // keyboard/vim user sees the edit affordance without a mouse).
  ".cm-lp-macro-wrap:hover .cm-lp-macro-edit, .cm-lp-macro-wrap:hover .cm-lp-macro-retarget, .cm-lp-macro-wrap:hover .cm-lp-macro-align, .cm-lp-macro-wrap.cm-lp-atom-sel .cm-lp-macro-edit, .cm-lp-macro-wrap.cm-lp-atom-sel .cm-lp-macro-retarget, .cm-lp-macro-wrap.cm-lp-atom-sel .cm-lp-macro-align": { opacity: "1" },
  // #215 / ADR-100: the selected NESTED macro (inside a columns/tabs widget) draws its own ring + edit
  // button — the same affordance as a top-level macro, at depth. The ring is on the nested subtree (not
  // the container), and the button is anchored to that subtree's top-left (the container's top margin is
  // out of reach). Shown always while selected (no hover needed — the click already selected it).
  // #215 comment 813/817: two-level highlight — the container HOST that holds the selected nested macro
  // gets an ACHROMATIC (grey) context outline; the inner selected macro gets the ACCENT ring. So at any
  // depth the accent marks "the macro you're operating" and the grey marks "the box it lives in".
  ".cm-lp-nested-host": { outline: "2px solid var(--fg-dim, #888)", outlineOffset: "1px", borderRadius: "4px" },
  ".cm-lp-nested-sel": { position: "relative", outline: "2px solid var(--accent, #4ea1ff)", outlineOffset: "2px", borderRadius: "4px" },
  // The nested edit pencil sits ON the selected inner macro's top-left corner so it reads as THAT macro's
  // edit affordance — not the container's (suppressed while nested). #215 comment 834: keep only the
  // position override; the pencil uses the SAME (normal) color as every other macro's edit button — the
  // accent ring already marks the focused macro, so tinting the pencil too was redundant.
  ".cm-lp-nested-macro-edit": { position: "absolute", top: "-0.9em", left: "-0.4em", opacity: "1", zIndex: "5" },
  // #174 comment 1003: the WYSIWYG hover variant. Unlike the selection pencil (drawn only when selected, so
  // opacity:1), this one sits on EVERY editable nested slot, so it must be hover-gated — opacity:0 until the
  // slot itself is hovered. `>` keeps it to the pencil that is a direct child of the hovered [data-mac-pos].
  ".cm-lp-nested-macro-edit-hover": { opacity: "0", transition: "opacity 120ms" },
  "[data-mac-pos]:hover > .cm-lp-nested-macro-edit-hover": { opacity: "1" },
  ".cm-lp-nested-edit-island": { outline: "2px solid var(--accent, #4ea1ff)", outlineOffset: "2px", borderRadius: "4px" },
  ".cm-lp-nested-edit-src": { width: "100%", minHeight: "4em", boxSizing: "border-box", fontFamily: "var(--font-mono, monospace)", fontSize: "0.85em" },
  ".cm-lp-excalidraw svg": { maxWidth: "100%", height: "auto", pointerEvents: "none" },
  // Empty-macro placeholder (#3): a clearly-bounded dashed block so the user SEES that a
  // macro widget occupies the line (matches the caret's block-motion behavior).
  ".cm-lp-macro-empty": {
    color: "var(--fg-dim, #888)",
    fontStyle: "italic",
    padding: "0.6em",
    border: "1px dashed var(--border, #888)",
    borderRadius: "4px",
    cursor: "pointer",
  },
  // Folded summary line ("▶ Mermaid diagram"). One landable line; click to expand
  // (vim za/zo also toggle it — CM native folding).
  ".cm-lp-macro-folded": {
    cursor: "pointer",
    color: "var(--fg-dim, #888)",
    fontStyle: "italic",
    fontSize: "0.95em",
  },
  // #90 columns: the A′ widget lays its inner column DOM out as an even flex row.
  // #257: the STRUCTURED layout editUI panel — an item bar (tab/column chips + add), an edit area (label +
  // content textarea + remove/reorder for the active item), and a live preview. Panel edit, not reveal.
  ".cm-lp-layout-edit-structured": { display: "flex", flexDirection: "column", gap: "0.5em", border: "1px solid var(--border, #888)", borderRadius: "6px", padding: "0.6em", background: "var(--panel, transparent)" },
  ".cm-lp-layout-edit-bar": { display: "flex", flexWrap: "wrap", gap: "0.25em", alignItems: "center", borderBottom: "1px solid var(--border, #888)", paddingBottom: "0.4em" },
  ".cm-lp-layout-edit-chip": { border: "1px solid transparent", background: "transparent", color: "var(--fg-dim, #888)", cursor: "pointer", padding: "0.25em 0.6em", borderRadius: "4px", fontSize: "0.9em" },
  ".cm-lp-layout-edit-chip:hover": { color: "var(--fg, inherit)", background: "var(--panel-2, rgba(128,128,128,0.12))" },
  ".cm-lp-layout-edit-chip-active": { color: "var(--fg, inherit)", background: "var(--panel-2, rgba(128,128,128,0.18))", borderColor: "var(--border, #888)", fontWeight: "600" },
  ".cm-lp-layout-edit-add": { border: "1px dashed var(--border, #888)", background: "transparent", color: "var(--fg-dim, #888)", cursor: "pointer", padding: "0.15em 0.55em", borderRadius: "4px", lineHeight: "1" },
  ".cm-lp-layout-edit-add:hover": { color: "var(--fg, inherit)", borderColor: "var(--accent, #4ea1ff)" },
  ".cm-lp-layout-edit-area": { display: "flex", flexWrap: "wrap", gap: "0.4em", alignItems: "flex-start" },
  ".cm-lp-layout-edit-label": { flex: "1 1 100%", boxSizing: "border-box", padding: "0.3em 0.5em", border: "1px solid var(--border, #888)", borderRadius: "4px", background: "var(--bg, transparent)", color: "var(--fg, inherit)", fontSize: "0.9em" },
  ".cm-lp-layout-edit-content": { flex: "1 1 100%", boxSizing: "border-box", minHeight: "5em", resize: "vertical", padding: "0.4em 0.5em", border: "1px solid var(--border, #888)", borderRadius: "4px", background: "var(--bg, transparent)", color: "var(--fg, inherit)", fontFamily: "var(--font-code, monospace)", fontSize: "0.9em" },
  ".cm-lp-layout-edit-remove, .cm-lp-layout-edit-move": { border: "1px solid var(--border, #888)", background: "transparent", color: "var(--fg-dim, #888)", cursor: "pointer", padding: "0.2em 0.55em", borderRadius: "4px", fontSize: "0.85em" },
  ".cm-lp-layout-edit-remove:hover": { color: "var(--danger, #e5534b)", borderColor: "var(--danger, #e5534b)" },
  ".cm-lp-layout-edit-move:hover": { color: "var(--fg, inherit)", borderColor: "var(--accent, #4ea1ff)" },
  ".cm-lp-layout-edit-preview": { borderTop: "1px solid var(--border, #888)", paddingTop: "0.5em" },
  ".cm-lp-columns": { display: "flex", gap: "1.2em", alignItems: "flex-start" },
  ".cm-lp-column": { flex: "1 1 0", minWidth: "0" },
  ".cm-lp-column > :first-child": { marginTop: "0" },
  // #90 tabs: a tab bar + only the active panel shown (display-only switch).
  ".cm-lp-tabbar": { display: "flex", gap: "0.25em", borderBottom: "1px solid var(--border, #888)", marginBottom: "0.6em" },
  ".cm-lp-tab": { border: "none", background: "transparent", color: "var(--fg-dim, #888)", cursor: "pointer", padding: "0.3em 0.7em", fontSize: "0.9em", borderBottom: "2px solid transparent", marginBottom: "-1px" },
  ".cm-lp-tab:hover": { color: "var(--fg, inherit)" },
  ".cm-lp-tab-active": { color: "var(--fg, inherit)", borderBottomColor: "var(--accent, #4ea1ff)", fontWeight: "600" },
  ".cm-lp-tabpanel": { display: "none" },
  ".cm-lp-tabpanel-active": { display: "block" },
  ".cm-lp-tabpanel > :first-child": { marginTop: "0" },
  // #196 innermost-wins reveal: while a NESTED child of columns/tabs is being edited, the container
  // descends to raw lines rather than its flex/tab widget — so the caret can sit inside the child. A
  // subtle left rail marks the container/child frame so the structure stays visible ("which layer am I
  // editing"). Display-only line decorations (no widget → no new motion atom); the flex/tab layout
  // returns as soon as the caret leaves the block.
  ".cm-lp-columns-frame, .cm-lp-tabs-frame": { borderLeft: "2px solid var(--border, #888)", paddingLeft: "0.6em" },
  ".cm-lp-column-frame, .cm-lp-tab-frame": { borderLeft: "2px solid color-mix(in srgb, var(--accent, #4ea1ff) 40%, transparent)", paddingLeft: "0.6em" },
  // #90 details: collapsed bar + (revealed) a subtle bordered box.
  ".cm-lp-details-summary": { border: "1px solid var(--border, #888)", borderRadius: "4px", padding: "0.35em 0.7em", cursor: "pointer", color: "var(--fg-dim, #888)", userSelect: "none" },
  ".cm-lp-details": { borderLeft: "3px solid var(--border, #888)", paddingLeft: "0.8em" },
  // ::: callout directive: a tinted box with a SEMANTIC (never accent) left bar. Applied per line
  // (the fence lines are hidden → empty padding rows inside the box). The content
  // stays live-preview Markdown.
  ".cm-lp-callout": {
    // #199: the DEFAULT bar/tint is the neutral note hue, NOT the tenant --accent (a callout's colour
    // is semantic; accent-driven info/note lost their meaning). Every type overrides below.
    borderLeft: "3px solid var(--callout-note, #6e7781)",
    background: "color-mix(in srgb, var(--callout-note, #6e7781) 8%, transparent)",
    // #170 panel layout: a left gutter (position:relative anchors the absolutely-positioned icon into
    // it) so the icon reads as a large panel column and the body text aligns to its right, not crammed
    // beside a tiny glyph. NOTE: CM renders each callout line as a separate .cm-line, so pure CSS
    // cannot vertically-center the icon against a MULTI-LINE body's combined height (that needs a
    // single-container widget — the columns/tabs-style revealOnCursor conversion, a follow-up if the
    // reviewer wants true centering over the gutter-panel). This lifts "small top-left / cheap".
    position: "relative",
    paddingLeft: "2.8em",
  },
  // Per-type accents (#150 → #158-C5 tokens; #199). Every type rides its FIXED semantic --callout-*
  // token (tokens.css, light/dark only) — never the tenant --accent, so a callout's colour keeps its
  // meaning (info=blue, note=grey, tip=green, warning=yellow, danger=red).
  ".cm-lp-callout-note": { borderLeftColor: "var(--callout-note, #6e7781)", background: "color-mix(in srgb, var(--callout-note, #6e7781) 8%, transparent)" },
  ".cm-lp-callout-info": { borderLeftColor: "var(--callout-info, #0969da)", background: "color-mix(in srgb, var(--callout-info, #0969da) 10%, transparent)" },
  ".cm-lp-callout-tip": { borderLeftColor: "var(--callout-tip, #2ea043)", background: "color-mix(in srgb, var(--callout-tip, #2ea043) 10%, transparent)" },
  ".cm-lp-callout-warning": { borderLeftColor: "var(--callout-warning, #d29922)", background: "color-mix(in srgb, var(--callout-warning, #d29922) 13%, transparent)" },
  ".cm-lp-callout-danger": { borderLeftColor: "var(--callout-danger, #cf222e)", background: "color-mix(in srgb, var(--callout-danger, #cf222e) 10%, transparent)" },
  // Header (#94 label + #158-C4 icon): the masked Lucide icon (::before) + the label text
  // (::after) live in callout-icons.css (long mask-image data URIs + per-type colour tokens),
  // global CSS so the data URIs stay out of this baseTheme. Display-only; reveal-on-cursor edits
  // the hidden `:::name[label]` source. paddingTop keeps the header off the box's top edge.
  ".cm-lp-directive-label::before, .cm-lp-directive-label::after": { paddingTop: "0.1em" },
  // Block drag-to-reorder (#84 comment 741): a HOVER-FOLLOWING drag handle (not a fixed gutter marker).
  // The plugin absolutely-positions it just outside the hovered block's left edge and toggles display; it
  // is only ever on-screen when hovering a block, so it reads as "this block's handle". Display-only.
  ".cm-lp-block-grip": {
    position: "absolute",
    zIndex: "6",
    cursor: "grab",
    opacity: "0.7",
    color: "var(--fg-dim, #888)",
    userSelect: "none",
    lineHeight: "1.2",
    padding: "0 2px",
    borderRadius: "4px",
    transition: "opacity 120ms ease, background 120ms ease, color 120ms ease",
  },
  ".cm-lp-block-grip:hover": { opacity: "1", color: "var(--fg, #444)", background: "var(--hover, rgba(128,128,128,0.18))" },
  ".cm-lp-block-droptarget": { boxShadow: "inset 0 2px 0 0 var(--accent, #4ea1ff)" },
  // #84 comment 750: dropping at the very END of the doc (after the last block, no trailing blank line).
  // The indicator sits on the LAST line's BOTTOM edge so "drop after the last block" is visible.
  ".cm-lp-block-droptarget-end": { boxShadow: "inset 0 -2px 0 0 var(--accent, #4ea1ff)" },
  // Table cell-merge edit mode (render-active): a toolbar + selectable cells.
  // margin 0 (see cm-lp-macro-wrap): the edit widget's root margin would be uncounted in
  // CM's heightMap. The accent border + inner padding give it presence without an outer
  // (uncounted) margin gap.
  ".cm-lp-table-edit": { position: "relative", border: "1px solid var(--accent, #4ea1ff)", borderRadius: "4px", padding: "4px" },
  // Floating contextual toolbar — positioned above the selected cell, over the table.
  ".cm-lp-table-edit-bar": {
    position: "absolute",
    zIndex: "5",
    display: "flex",
    // #217 (comment 772): WRAP the ~16 ops at a narrow width (a side panel narrows the editor) so every op
    // stays visible WITHOUT horizontal scroll (scroll hides table ops = bad). Groups (cm-lp-table-ops) are
    // the wrap units — they never break mid-group. maxWidth clamps to the editor width so the bar can't run
    // off; rowGap spaces the wrapped rows. At a normal width it stays one row (no regression).
    flexWrap: "wrap",
    maxWidth: "min(calc(100% - 6px), calc(100vw - 1.5rem))",
    alignItems: "center", // #4: swatches line up with the icon buttons
    rowGap: "3px",
    gap: "4px",
    padding: "3px 4px",
    background: "var(--panel, #fff)",
    border: "1px solid var(--border, #888)",
    borderRadius: "6px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
  },
  ".cm-lp-table-edit-btn": {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: "0", // #217: never compress the ops — scroll to reach them instead of shrinking/wrapping
    border: "1px solid transparent",
    borderRadius: "4px",
    background: "transparent",
    color: "var(--fg, inherit)",
    cursor: "pointer",
    fontSize: "0.8em",
    padding: "2px 6px",
  },
  ".cm-lp-table-edit-btn:hover": { background: "var(--panel-2, rgba(127,127,127,0.15))" },
  ".cm-lp-table-edit th, .cm-lp-table-edit td": { cursor: "pointer", position: "relative" },
  ".cm-lp-col-resize": {
    position: "absolute",
    top: "0",
    right: "-3px",
    width: "7px",
    height: "100%",
    cursor: "col-resize",
    zIndex: "3",
  },
  ".cm-lp-row-resize": {
    position: "absolute",
    left: "0",
    bottom: "-3px",
    width: "100%",
    height: "7px",
    cursor: "row-resize",
    zIndex: "3",
  },
  // Spreadsheet select-handle band (top row / left column) — clearly NOT a cell: solid
  // grey, no padding, fixed thin size, a grab cursor (#2). NOTE the `.cm-lp-table-grid`
  // prefix: the edit-widget table also carries `.cm-lp-table`, whose `th`/`td` rules
  // (specificity 0,1,1) would otherwise OVERRIDE these handle/selection classes (0,1,0)
  // — the band would inherit the faint `th` background and look like a header cell. The
  // prefixed selectors (0,2,1 / 0,2,0) win, so the styling actually paints on device.
  ".cm-lp-table-grid th.cm-lp-table-handle": {
    background: "var(--panel-2, rgba(127,127,127,0.28))", // header-band tint, distinct from cells
    border: "1px solid var(--border, #888)",
    padding: "1px 2px",
    textAlign: "center",
    verticalAlign: "middle",
    fontSize: "10px",
    fontWeight: "600",
    lineHeight: "1.2",
    color: "var(--fg-dim, #777)",
    cursor: "pointer",
    userSelect: "none",
  },
  ".cm-lp-table-grid th.cm-lp-table-handle:hover": { background: "var(--panel-3, #d8dce0)", color: "var(--fg)" }, // #197: neutral hover, not the loud accent
  ".cm-lp-table-grid .cm-lp-table-colhandle": { minWidth: "16px", height: "16px" },
  ".cm-lp-table-grid .cm-lp-table-rowhandle": { width: "22px" },
  ".cm-lp-table-grid .cm-lp-table-corner": { width: "22px", height: "16px", borderTopLeftRadius: "5px" },
  // Trailing "+" append handles (#3): table-attached add-column ("+" at the right of the
  // header band) and add-row ("+" below the last row, spanning the table). A dashed accent
  // border + bold "+" reads as "add here", like Notion/Docmost — replaces the disconnected
  // labeled bottom bar. They share the handle band tint and the accent hover.
  ".cm-lp-table-grid .cm-lp-table-addcol, .cm-lp-table-grid .cm-lp-table-addrow": {
    color: "var(--fg-dim, #777)", // #197: subtle neutral "+", not the loud accent
    fontSize: "13px",
    fontWeight: "700",
    border: "1px dashed var(--border, #888)",
  },
  ".cm-lp-table-grid .cm-lp-table-addcol": { minWidth: "16px", height: "16px" },
  ".cm-lp-table-grid .cm-lp-table-addrow": { height: "16px" },
  // Structural-op group in the toolbar (insert/delete col/row) — visually separated.
  ".cm-lp-table-ops": { display: "inline-flex", flexShrink: "0", gap: "2px", alignItems: "center", borderLeft: "1px solid var(--border, #888)", paddingLeft: "4px", marginLeft: "2px" },
  // Selection: a translucent THEME-accent fill on each cell (#1 — must read as selected,
  // in the active theme color, not a fixed blue); a thick accent border only on the OUTER
  // edges (per-side classes) — the spreadsheet look. Prefixed to beat the base cell rules.
  ".cm-lp-table-grid .cm-lp-cell-sel": { background: "color-mix(in srgb, var(--accent, #4ea1ff) 14%, transparent)" }, // #197: subtler selection fill
  ".cm-lp-table-grid .cm-lp-sel-t": { borderTop: "2px solid var(--accent, #4ea1ff)" },
  ".cm-lp-table-grid .cm-lp-sel-b": { borderBottom: "2px solid var(--accent, #4ea1ff)" },
  ".cm-lp-table-grid .cm-lp-sel-l": { borderLeft: "2px solid var(--accent, #4ea1ff)" },
  ".cm-lp-table-grid .cm-lp-sel-r": { borderRight: "2px solid var(--accent, #4ea1ff)" },
  ".cm-lp-table-swatch": {
    flex: "0 0 auto",
    width: "18px",
    height: "18px",
    border: "1px solid var(--border, #888)",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "10px",
    lineHeight: "1",
    padding: "0",
    color: "var(--fg-dim, #888)",
  },
});
