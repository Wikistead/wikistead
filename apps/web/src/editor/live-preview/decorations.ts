import { syntaxTree, foldedRanges, foldEffect, unfoldEffect } from "@codemirror/language";
import i18n from "../../i18n"; // #455: the shared empty-macro placeholder text is localized (the #174macros precedent)
import { Facet, StateField, StateEffect, EditorState, EditorSelection, Prec, type Range, type Extension, type Text as CmText } from "@codemirror/state";
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
import { toHtml, toPipe, representableAsPipe, tableFence, tableAlignOf, type TableAlign } from "../macros/table-model";
import { currentMacroTheme } from "../macros/theme";
import { parseDirectiveOpen, resolveDirectiveRanges, serializeDirectiveAttrs } from "../macros/directive-parser";
import { parseFrontmatterRange, FrontmatterWidget } from "./frontmatter";
import { parseFenceLine, parseFenceInfo, serializeFenceInfo, CALLOUT_TYPES, type FenceAlign } from "@wikistead/macro-render"; // #198: code-fence attribute parser; #174: callout types; #255: align rewrite
// #255: rendered diagram macros are centred by default and take a fence `align=` attribute (others don't).
const DIAGRAM_MACROS = new Set(["mermaid", "plantuml", "excalidraw"]);
// #395 / ADR-156: the ATOM interaction class — macros with nothing to TYPE at the block itself
// (picker-chosen reference, modal-edited scene, zero-arg dynamic block, slot container). Their body
// must never suggest text editing: `cursor: default` (the cm-lp-atom-body sweep), no I-beam. The
// clickable-whole-surface exception (the #273 download card) keeps its own `pointer`. Typed-body
// macros (callout/table/todo/details/tagged/mermaid/plantuml/code) keep the caret affordances.
const ATOM_CLASS_MACROS = new Set(["embed-page", "embed-external", "excalidraw", "columns", "tabs", "children"]);
import { renderMarkdownToDom, renderCalloutPanel, setPendingBaseOffset, appendMarkdownInto, buildFenceHeader, buildLinkList, withListHost } from "../macros/md-render";
import { setActiveTabIndex } from "../macros/layout-directives"; // #278 item 1: record the clicked tab before the island's commit rebuilds the tabs widget
import { buildEmbedElement } from "../macros/embed";
import { noteCalloutMacro } from "../macros/callout";
import { countTasks, renderProgressRing, updateProgressRing } from "../macros/progress"; // #290: :::todo header progress ring
import { calloutTypeOption } from "../macros/callout-type-ui";
import { renderCellInline } from "../macros/table-cell-dom";
import { openMacroModal } from "./macro-modal";
import { macroRenderActiveField, setMacroRenderActive, makeInnerEditHost, nestedSelectionField, setNestedSelection, nestedEditActiveField, setNestedEditActive, slotEditField, setSlotEditActive, type NestedSelection, type SlotEdit } from "./macro-edit";
import { mountSourceEditor } from "../macros/source-editor";
import { fenceSettingsField, toggleFenceSettings } from "./fence-settings-panel";
import type * as Y from "yjs";
import type { EphemeralSession } from "../collab";
import { ephemeralBody } from "../ephemeral-island";
import { IslandCoEditController } from "../island-coedit-controller";
import { isPeerEditingIsland, type AwarenessLike } from "../macro-presence";
import { tableInlineEditor } from "./table-edit";
import { tableTier } from "../macros/table";
import type { InlineController, HostSurfaceOptions, HostSurfaceHandle } from "../macros/registry";

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
const highlightMark = Decoration.mark({ class: "cm-lp-highlight" }); // #334 / ADR-129: `==text==` → <mark>
// #335 / ADR-130: footnote — the inline reference `[^label]` renders as a superscript (the `[^`/`]` delimiters
// hide on reveal-on-cursor, like highlight's `==`), and the definition line `[^label]: body` gets a muted
// line style. Numbering + the end-of-document collection are a RENDERED concern (preview / reader / export);
// the editor's live surface keeps definitions in place (edit them where they are) — a superscript label reads
// as "this is a footnote" without a second (numbered) copy fighting the source you're editing.
const footnoteRefMark = Decoration.mark({ class: "cm-lp-footnote-ref" });
const footnoteDefLine = Decoration.line({ attributes: { class: "cm-lp-footnote-def" } });

// #335on a READ-ONLY surface (Reading / template preview) footnotes AGGREGATE — the reference becomes
// a numbered superscript that JUMPS to a document-end section, the in-place definition lines are hidden, and
// the section carries `↩` back-links. This matches the public reader (renderMarkdownToDom); only the EDITABLE
// surface keeps the in-place muted definitions (edit them where they are). Document-scoped + top-level only
// (a footnote inside a :::macro body stays literal — §A), reusing the shared grammar's nodes.
interface DocFootnotes {
  numbers: Map<string, number>; // label → number (first-reference order; only refs that have a matching def)
  defRange: Map<string, { from: number; to: number }>; // label → its FIRST definition's node range
  refFirstPos: Map<string, number>; // label → first reference position (the `↩` target)
  order: string[]; // referenced labels in number order
  unreferenced: string[]; // defined-but-never-referenced (still shown, de-emphasised — content never dropped)
}
const footnoteRefLabelD = (text: string): string => text.slice(2, -1); // `[^label]` → label
function collectDocFootnotes(state: EditorState): DocFootnotes | null {
  const dirs = resolveDirectiveRanges(state.doc.toString());
  const insideMacro = (pos: number) => dirs.some((d) => pos > d.from && pos < d.to);
  const doc = state.doc;
  const refOrder: string[] = [];
  const refFirstPos = new Map<string, number>();
  const defRange = new Map<string, { from: number; to: number }>();
  syntaxTree(state).iterate({
    enter: (n) => {
      if (n.name === "FootnoteRef") {
        if (insideMacro(n.from)) return;
        const label = footnoteRefLabelD(doc.sliceString(n.from, n.to));
        if (label) { refOrder.push(label); if (!refFirstPos.has(label)) refFirstPos.set(label, n.from); }
      } else if (n.name === "FootnoteDef") {
        if (insideMacro(n.from)) return;
        const m = /^\[\^([^\]\s]+)\]:/.exec(doc.sliceString(n.from, n.to));
        const label = m?.[1];
        if (label && !defRange.has(label)) defRange.set(label, { from: n.from, to: n.to });
      }
    },
  });
  const numbers = new Map<string, number>();
  const order: string[] = [];
  for (const label of refOrder) if (defRange.has(label) && !numbers.has(label)) { numbers.set(label, numbers.size + 1); order.push(label); }
  const unreferenced = [...defRange.keys()].filter((l) => !numbers.has(l));
  if (order.length === 0 && unreferenced.length === 0) return null;
  return { numbers, defRange, refFirstPos, order, unreferenced };
}

// Bring the end-of-document footnote section into view (CM scroll — virtualization-safe, unlike a raw DOM
// scrollIntoView on a possibly-unrendered widget), then centre the specific item once it's painted.
function jumpToFootnoteSection(view: EditorView, n: number): void {
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.length, { y: "end" }) });
  requestAnimationFrame(() => { view.dom.querySelector(`#fn-${n}`)?.scrollIntoView({ block: "center" }); });
}

// The read-only footnote REFERENCE: a superscript number that jumps to its end-section item; an undefined
// reference (no matching def) is a muted `?`. Display-only (offset-invariant replace).
class FootnoteRefWidget extends WidgetType {
  constructor(readonly n: number | null) { super(); }
  eq(o: FootnoteRefWidget) { return o.n === this.n; }
  toDOM(view: EditorView) {
    const sup = document.createElement("sup");
    sup.className = "cm-lp-footnote-ref";
    // #335②: mark the widget non-editable. Reading keeps `EditorView.editable` true (#165 focusable), so
    // without this the sup is treated as editable text — the caret lands inside on click (eating the ref's
    // mousedown → no jump) and the cursor shows an I-beam. The other display-only widgets already do this.
    sup.contentEditable = "false";
    if (this.n == null) { sup.classList.add("cm-lp-footnote-undef"); sup.textContent = "?"; return sup; }
    sup.id = `fnref-${this.n}`;
    const a = document.createElement("a");
    a.textContent = String(this.n);
    a.setAttribute("data-testid", `footnote-ref-${this.n}`);
    a.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); jumpToFootnoteSection(view, this.n!); });
    sup.appendChild(a);
    return sup;
  }
  ignoreEvent() { return false; }
}

// The read-only end-of-document footnote SECTION: a numbered list of definitions, each with a `↩` back-link to
// its first reference. `key` (numbers + def ranges) drives eq so the widget rebuilds on a footnote change but
// NOT on a selection-only change (#84 stable-key lesson). Definition bodies render via the shared renderer.
class FootnoteSectionWidget extends WidgetType {
  constructor(readonly key: string, readonly items: { n: number; from: number; to: number; refPos: number | null; unref: boolean }[]) { super(); }
  eq(o: FootnoteSectionWidget) { return o.key === this.key; }
  toDOM(view: EditorView) {
    const section = document.createElement("section");
    section.className = "cm-lp-footnotes";
    section.setAttribute("data-testid", "footnotes");
    // #335②: non-editable, same as the ref widget — otherwise the `↩` back-links land the caret instead
    // of firing their jump, and the whole section reads as editable text (I-beam) on a read surface.
    section.contentEditable = "false";
    section.appendChild(document.createElement("hr"));
    const ol = document.createElement("ol");
    ol.className = "cm-lp-footnotes-list";
    for (const it of this.items) {
      const li = document.createElement("li");
      li.className = it.unref ? "cm-lp-footnote-item cm-lp-footnote-unref" : "cm-lp-footnote-item";
      // #335①: pin the marker number explicitly. The `<ol>` auto-count would number the trailing
      // unreferenced items too (they carry no `fn-N` id); setting `value` on the referenced items — and hiding
      // the unref marker in CSS — keeps the visible numbers aligned with `fn-N` / `fnref-N`.
      if (!it.unref) { li.id = `fn-${it.n}`; li.value = it.n; }
      const bodySrc = view.state.doc.sliceString(it.from, it.to).replace(/^\[\^[^\]\s]+\]:[ \t]?/, ""); // drop `[^label]: `
      appendMarkdownInto(li, bodySrc); // sanitized DOM (no innerHTML); .wks-prose = the shared raw-tag sheet (#381)
      if (!it.unref && it.refPos != null) {
        li.appendChild(document.createTextNode(" "));
        const back = document.createElement("a");
        back.className = "cm-lp-footnote-back";
        back.textContent = "↩";
        const rp = it.refPos;
        back.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); view.dispatch({ effects: EditorView.scrollIntoView(rp, { y: "center" }) }); });
        li.appendChild(back);
      }
      ol.appendChild(li);
    }
    section.appendChild(ol);
    return section;
  }
  ignoreEvent() { return false; }
}
const inlineCodeMark = Decoration.mark({ class: "cm-lp-inline-code" });
const hide = Decoration.replace({});

const headingLine = (level: number) =>
  Decoration.line({ attributes: { class: `cm-lp-h cm-lp-h${level}` } });
const quoteLine = Decoration.line({ attributes: { class: "cm-lp-quote" } });
const hrLine = Decoration.line({ attributes: { class: "cm-lp-hr" } });
// #255 comment 1073: a STANDALONE image is now a full ATOM (StandaloneImageWidget) whose wrap carries the
// cm-lp-align-* class, so the old cm-lp-img-center line decoration is retired (the widget centres itself).

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
  // #381the header DOM (filename tab + lang + copy button) is the SHARED builder in md-render
  // the static prose fence renders the identical structure, so the two read surfaces cannot drift.
  // #456 rev (review ①/④): pass onSettings so the code-settings ✎ renders in the header chrome (left of
  // copy) — but ONLY when the fence-settings field is registered (edit surface), so the read/guest surfaces
  // are untouched. The click resolves the fence from the header's LIVE doc position (posAtDOM) and toggles the
  // panel, so it survives upstream edits without a captured offset going stale.
  toDOM(view: EditorView) {
    const editable = view.state.field(fenceSettingsField, false) !== undefined;
    let row: HTMLElement;
    row = buildFenceHeader({
      lang: this.lang, title: this.title, code: this.code, canCopy: this.canCopy,
      settingsLabel: i18n.t("contextMenu.codeSettings"),
      onSettings: editable ? () => { const pos = view.posAtDOM(row); toggleFenceSettings(view, pos); } : undefined,
    });
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
  const ro = new ResizeObserver(() => {
    view.requestMeasure();
    consumeReAnchor(view); // #243: a block's async height settle re-anchors a caret pushed off-screen.
  });
  ro.observe(dom);
  return ro;
}

// #243: when the caret LEAVES a revealed mermaid/plantuml block (e.g. `j` past its last line), the
// block re-mounts as an atom and its diagram renders ASYNC — the SVG lands taller than the raw source it
// replaced. The shared ResizeObserver → requestMeasure keeps CM's heightMap correct, but nobody re-anchors the
// SELECTION: the taller widget sits directly above the caret line, so that line is pushed DOWN, off the bottom
// of the viewport. On the reveal→atom transition we open a short SETTLE WINDOW (see `reAnchorAfterReveal`);
// while it is open, every block-resize keeps the CURRENT caret comfortably in view. It is a window, not a
// one-shot, because the FIRST resize is the widget's mount (still short — the SVG hasn't loaded), and the
// height that pushes the caret out only lands on a LATER resize. A visibility pre-check makes it a NO-OP once
// the caret is already in view, so an arbitrary async height change outside the window never yanks the viewport.
let reAnchorUntil = 0;
const RE_ANCHOR_MARGIN = 48;
function consumeReAnchor(view: EditorView): void {
  // Date.now is host app code (the workflow-script clock ban does not apply); the window is a wall-clock
  // deadline so a slow diagram settle is still caught but an unrelated later resize is not.
  if (reAnchorUntil === 0 || Date.now() > reAnchorUntil) { reAnchorUntil = 0; return; }
  const head = Math.min(view.state.selection.main.head, view.state.doc.length);
  const coords = view.coordsAtPos(head); // forces a sync measure → fresh layout coords for the caret line
  if (!coords) return;
  const box = view.scrollDOM.getBoundingClientRect();
  const offscreen = coords.top < box.top + RE_ANCHOR_MARGIN || coords.bottom > box.bottom - RE_ANCHOR_MARGIN;
  if (offscreen) {
    // Caret pushed off the viewport by the taller widget → scroll it back (also redraws the caret).
    view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "nearest", yMargin: RE_ANCHOR_MARGIN }) });
    return;
  }
  // #340: even when the caret line is still in view, the async settle leaves the DRAWN caret stale — CM's
  // selection layer measured `.cm-cursor-primary` BEFORE the widget grew, so it still sits at the widget's old
  // top (now INSIDE the tall figure) while coordsAtPos (fresh) reports the correct line below. Re-assert the
  // selection so drawSelection redraws the caret DOM at the settled coordinates. A same-range selection still
  // runs its transaction (selectionSet → redraw) and changes no block, so it cannot re-open the settle window
  // (reAnchorAfterReveal only opens on a NEW block). Only when the drawn caret actually diverges (>1px).
  const caretDom = view.dom.querySelector(".cm-cursor-primary") as HTMLElement | null;
  if (caretDom && Math.abs(caretDom.getBoundingClientRect().top - coords.top) > 1) {
    view.dispatch({ selection: EditorSelection.cursor(head) });
  }
}

// Detect the reveal→atom transition (a caret move that un-reveals a macro): a block present in `blocks` NOW
// but not a moment ago just switched from raw-source back to a rendered atom widget. Open the settle window so
// the widget's async height growth (above) can pull the caret back on-screen. Guarded to caret-only moves (no
// doc change) so block ranges compare stably by offset.
const RE_ANCHOR_WINDOW_MS = 1200;
export const reAnchorAfterReveal = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      if (!update.selectionSet || update.docChanged) return;
      const before = update.startState.field(livePreview, false)?.blocks ?? [];
      const after = update.state.field(livePreview, false)?.blocks ?? [];
      if (after.length === 0) return;
      const wasBlock = (b: { from: number; to: number }) => before.some((p) => p.from === b.from && p.to === b.to);
      if (after.some((b) => !wasBlock(b))) reAnchorUntil = Date.now() + RE_ANCHOR_WINDOW_MS;
    }
  },
);

// #359symptom 2: a NON-EMPTY (visual/mouse) selection crossing a block atom was invisible ON the
// atom — the widget's opaque background occluded .cm-selectionBackground, so the writer couldn't see how
// far the selection reached. This plugin toggles `cm-lp-atom-insel` on every block-widget wrap whose doc
// range intersects a non-empty selection range; CSS paints a translucent accent overlay (display-only
// never a decoration/offset change, so remote carets and the #359 no-reveal rule are untouched). Runs on
// every relevant update (CM may rebuild widget DOM at any time, so the class is re-derived, not cached).
// #453ONE definition of "this element is the box that IS the atom". Every root that can take
// the selection ring (`cm-lp-atom-sel`) also carries this marker, permanently — selected or not — so
// anything that needs to draw around an atom (the local ring, a peer's presence box, the selection
// tint) measures the SAME rectangle. It used to be enumerated per consumer, and the enumerations
// drifted: the presence overlay knew only `.cm-lp-macro-wrap`, so a peer's box around a callout,
// a details block or a table fell back to the full content width — measured at 740px against the
// callout's real 692px, and 740 against a narrow table's 153px. A new macro now inherits the
// behaviour by wearing the marker, rather than by everyone remembering to list it.
export const ATOM_BOX_CLASS = "cm-lp-atom-box";

export const atomSelectionTint: Extension = ViewPlugin.define((view) => {
  const apply = () => {
    const ranges = view.state.selection.ranges.filter((r) => !r.empty);
    const blocks = view.state.field(livePreview, false)?.blocks ?? [];
    for (const el of Array.from(view.contentDOM.querySelectorAll<HTMLElement>(`.${ATOM_BOX_CLASS}`))) {
      let on = false;
      if (ranges.length && blocks.length) {
        try {
          const p = view.posAtDOM(el);
          const b = blocks.find((bl) => p >= bl.from && p <= bl.to);
          on = !!b && ranges.some((r) => r.to > b.from && r.from < b.to);
        } catch { /* detached node mid-update */ }
      }
      el.classList.toggle("cm-lp-atom-insel", on);
    }
  };
  const plugin = {
    update(u: ViewUpdate) {
      if (u.selectionSet || u.docChanged || u.viewportChanged) requestAnimationFrame(apply);
    },
    destroy() { /* classes die with the DOM */ },
  };
  return plugin;
});

// #359(option A, symptom 3): copy/cut with an EMPTY caret resting ON a block atom takes the WHOLE
// block's source. CM's default for an empty selection copies the CURRENT LINE — on an atom that line is
// the block's first SOURCE line ("```mermaid" / ":::note[Hello]"), so a WYSIWYG click-the-atom → Ctrl+C
// → paste produced a broken fragment. Reveal is not involved (no atomicRanges churn — the #359 warp fix
// stands); a NON-empty selection keeps CM's default doc slice, which already carries full raw source.
export const atomClipboard: Extension = EditorView.domEventHandlers({
  copy: (e, view) => atomClipboardHandler(e, view, false),
  cut: (e, view) => atomClipboardHandler(e, view, true),
});
function atomClipboardHandler(e: ClipboardEvent, view: EditorView, isCut: boolean): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false; // a real selection: CM's default (the doc slice = raw source) is correct
  const blocks = view.state.field(livePreview, false)?.blocks ?? [];
  const b = blocks.find((bl) => sel.head >= bl.from && sel.head <= bl.to);
  if (!b) return false; // not on an atom: keep CM's copy-the-line default
  e.clipboardData?.setData("text/plain", view.state.sliceDoc(b.from, b.to));
  e.preventDefault();
  if (isCut && !view.state.readOnly) {
    // remove the whole block including its trailing newline (the same range vim dd takes on an atom)
    view.dispatch({ changes: { from: b.from, to: Math.min(b.to + 1, view.state.doc.length) }, userEvent: "delete.cut" });
  }
  return true;
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

// #290 / ADR-114: the :::todo open-line PROGRESS RING (done/total of the block's checkboxes). Display-only,
// offset-invariant (a side:1 widget on the open line — never shifts offsets, remote carets stay correct). The
// ring is absolutely positioned to the line's right edge (callout-icons.css) so it doesn't fight the CSS
// ::before(icon)/::after(label) header. eq keys on done/total so it only rebuilds when the counts change.
class TodoRingWidget extends WidgetType {
  constructor(readonly done: number, readonly total: number) { super(); }
  eq(o: TodoRingWidget) { return o.done === this.done && o.total === this.total; }
  // #290(1)(2): completion is expressed by COLOUR alone (the arc turns green at 100% — a class
  // renderProgressRing sets); thecentre-checkmark + its arm window are gone (user re-ruling).
  toDOM() { return renderProgressRing(this.done, this.total) ?? document.createElement("span"); }
  // #361: on a count change (eq false), update the SAME ring DOM in place so the arc `<circle>` is retained
  // and its stroke-dashoffset transition animates — matching the React ring in the title band. Falling back to a
  // rebuild (return false) if the DOM isn't an updatable ring (e.g. the empty-span placeholder).
  updateDOM(dom: HTMLElement) { return dom instanceof HTMLSpanElement && updateProgressRing(dom, this.done, this.total); }
  ignoreEvent() { return true; } // display-only — clicks pass through to the line
}

// #290(3): the :::todo list-checks icon, left gutter, vertically CENTRED against the WHOLE block
// the callout-panel look. The block is per-line boxes with NON-uniform heights (the header line is ~2 rows),
// so pure CSS can't centre across it; instead the icon is measured into place after mount: walk the block's
// contiguous .cm-lp-todo sibling lines, then set `top` so the icon centre = the block centre (relative to the
// open line the widget sits on, so it scrolls with the block). eq keys on the block's line count + task
// counts — any edit inside the block rebuilds the widget and re-measures. Display-only.
class TodoIconWidget extends WidgetType {
  constructor(readonly lineCount: number, readonly done: number, readonly total: number) { super(); }
  eq(o: TodoIconWidget) { return o.lineCount === this.lineCount && o.done === this.done && o.total === this.total; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-lp-todo-icon";
    el.setAttribute("data-testid", "todo-block-icon");
    el.setAttribute("aria-hidden", "true");
    requestAnimationFrame(() => {
      const line = el.closest(".cm-line") as HTMLElement | null;
      if (!line || !line.classList.contains("cm-lp-todo")) return;
      let top = line, bottom = line;
      while (top.previousElementSibling instanceof HTMLElement && top.previousElementSibling.classList.contains("cm-lp-todo")) top = top.previousElementSibling;
      while (bottom.nextElementSibling instanceof HTMLElement && bottom.nextElementSibling.classList.contains("cm-lp-todo")) bottom = bottom.nextElementSibling;
      const blockCenter = (top.getBoundingClientRect().top + bottom.getBoundingClientRect().bottom) / 2;
      const lineTop = line.getBoundingClientRect().top;
      el.style.top = `${blockCenter - lineTop - el.getBoundingClientRect().height / 2}px`;
    });
    return el;
  }
  ignoreEvent() { return true; }
}

// #290 / ADR-114: the :::todo header "remove ring" (demote) button — the explicit affordance that
// unwraps the directive back to a plain task list. Shown on the editable surface, on header hover (CSS). Its
// mousedown demotes and is guarded (preventDefault/stopPropagation) so it never places the caret / reveals
// raw first (memory: nested-widget input mousedown guard). Keyed on the block's start position (`from`).
class TodoDemoteWidget extends WidgetType {
  constructor(readonly from: number) { super(); }
  eq(o: TodoDemoteWidget) { return o.from === this.from; }
  toDOM(view: EditorView) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-lp-todo-demote";
    btn.title = "Remove the progress ring (back to a plain task list)";
    btn.setAttribute("data-testid", "todo-demote");
    btn.textContent = "✕";
    btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); demoteTodoToTaskList(view, this.from); });
    return btn;
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
type TreeNode = { readonly name: string; readonly from: number; readonly to: number; readonly prevSibling: TreeNode | null; readonly parent: TreeNode | null };
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

// #303: the REVERSE of taskIndexAt — given a task ordinal, return the offset of that task's STATE char
// (the ` `/`x` inside `[ ]`) IN `docText`, or -1 if there is no index-th task. The view-surface checkbox
// reports an ordinal computed on the PUBLISHED snapshot; the host must re-resolve it against the LIVE DRAFT
// (which may have diverged) before flipping — applying the published offset to a dirty draft corrupted the
// prose (the #303 bug). Uses the same TASK_RE, so the ordinal lines up 1:1 when skeletons match (ADR-019).
export function taskStatePosAt(docText: string, index: number): number {
  let i = 0;
  for (const m of docText.matchAll(TASK_RE)) {
    if (i === index) return m.index + m[1].length + 1; // "[" is at m.index+m[1].length; the state char is +1
    i++;
  }
  return -1;
}

// #290(5): the check-ON "pop" micro-animation (and its toggle-only arming machinery,) is GONE
// the user ruled it out (it read as flicker after a click). A toggle is an immediate state change only.

class CheckboxWidget extends WidgetType {
  // #300: `disabled` is part of the widget identity so a display-mode change (which rebuilds decorations)
  // actually re-renders the box — otherwise eq would reuse the old DOM and the inert/enabled state stales.
  constructor(readonly checked: boolean, readonly from: number, readonly disabled: boolean) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.from === this.from && other.disabled === this.disabled;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-lp-checkbox";
    box.setAttribute("data-testid", "task-checkbox");
    box.dataset.from = String(this.from); // #361: the listener reads position from the ELEMENT (see updateDOM)
    const ctl = view.state.facet(checkboxControl);
    box.disabled = this.disabled; // computed at build (#300/#314): !ctl — NOT view.readOnly, NOT Reading
    if (ctl && !this.disabled) {
      // mousedown + preventDefault: keep editor focus/selection and drive the toggle
      // ourselves (so the rendered state always follows the document, never the native
      // input). The doc/host update re-renders the widget with the new checked state.
      // #361: read the CURRENT state (box.checked + box.dataset.from) rather than the constructor closure, so a
      // widget whose DOM was kept + updated in place (updateDOM) still toggles the right box at the right offset.
      box.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const from = Number(box.dataset.from);
        const cur = box.checked;
        if (ctl.mode === "edit") {
          // editable surface: flipping the doc re-renders the widget immediately.
          view.dispatch({ changes: { from: from + 1, to: from + 2, insert: cur ? " " : "x" } });
        } else {
          // Read-only published surface. #361(P0): flip the VIEW'S OWN DOC, not just the input.
          // The box alone used to be the whole optimistic update, so the progress rings — which are
          // derived from the document (the :::todo widget aggregates it; taskProgressExtension feeds
          // the title band) — could not move until the server round-trip and refetch landed. That is
          // the "the animation starts late" the owner reported: it was structural, not slow code.
          // One local doc edit drives every doc-derived surface on the SAME frame the click lands;
          // the refetch later replaces the doc with the committed text (identical when the fold
          // succeeded, so nothing re-animates). `readOnly` is advisory for input handling — a
          // programmatic dispatch is exactly how the edit surface does it, one line above.
          const index = taskIndexAt(view.state.doc.toString(), from);
          view.dispatch({ changes: { from: from + 1, to: from + 2, insert: cur ? " " : "x" } });
          ctl.onToggle(index, from, cur);
        }
      });
      // #361suppress the NATIVE click toggle. preventDefault on mousedown does NOT stop a
      // checkbox's click-activation — the browser flipped the box BACK on mouseup, so a fast click
      // showed checked→unchecked→(server round-trip ~500ms)→checked ("turns on, turns off, turns on").
      // A long press hid it (the round-trip completed while held). With the click default suppressed,
      // the optimistic mousedown flip stands until the document/refetch confirms it.
      box.addEventListener("click", (e) => e.preventDefault());
    }
    return box;
  }
  // #361: on a pure CHECKED flip (the common toggle) keep the SAME <input> and update it in place — a rebuild
  // re-mounts the element and shows a one-frame bounce (old state → new). Only rebuild when `disabled` changed
  // (a display-mode/control change), which must re-bind the listener with the fresh control facet.
  updateDOM(dom: HTMLElement) {
    if (!(dom instanceof HTMLInputElement) || dom.disabled !== this.disabled) return false;
    dom.checked = this.checked;
    dom.dataset.from = String(this.from);
    return true;
  }
  // Let the widget receive its own pointer events (it is interactive, unlike the bullet).
  ignoreEvent() {
    return false;
  }
}
const checkbox = (checked: boolean, from: number, disabled: boolean) =>
  Decoration.replace({ widget: new CheckboxWidget(checked, from, disabled) });

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

// #273 / ADR-120: FILE attachment resolver — [name](wks-attachment:<id>), the image form minus
// the `!`. meta resolves the stable id → download URL + the SERVER-SNIFFED inline kind and
// size (the declared content type is untrusted; the server classified the bytes at confirm).
// inlineUrl returns a blob: URL of the PROXIED inline bytes (the nosniff/CSP route) for the
// sandboxed PDF viewer — fetched with the caller's credentials, since an <iframe src> cannot
// carry an Authorization header. Both re-check FGA `view` server-side per call.
export interface AttachmentMeta { downloadUrl: string; filename: string; sizeBytes: number | null; inlineKind: "pdf" | "image" | "none" }
export interface AttachmentResolver {
  meta(id: string): Promise<AttachmentMeta | null>;
  inlineUrl(id: string): Promise<string | null>;
}
const noopAttachmentResolver: AttachmentResolver = { meta: async () => null, inlineUrl: async () => null };
export const attachmentResolver = Facet.define<AttachmentResolver, AttachmentResolver>({
  combine: (values) => values[0] ?? noopAttachmentResolver,
});

// Host-mediated diagram render (#140 / ADR-074). A renderable fence (plantuml) is NEVER fetched by
// the macro (host-API is {theme} only — ADR-024); the HOST resolves the source to image bytes via
// this injected renderer (it holds pageId/token and calls the gated, SSRF-guarded server endpoint).
// null ⇒ degrade-to-source (the widget keeps the source fence — Open formats, never a broken embed).
export type DiagramRenderer = (lang: string, source: string, theme?: MacroTheme) => Promise<Blob | null>;
const noopDiagramRenderer: DiagramRenderer = async () => null;
export const diagramRenderer = Facet.define<DiagramRenderer, DiagramRenderer>({
  combine: (values) => values[0] ?? noopDiagramRenderer,
});

// #276 / ADR-117: host-mediated dead-internal-link resolution. Given the `/p/<id>` targets collected from
// the doc, returns the subset the viewer can `view` (everything else is struck through). The MACRO/editor
// never learns existence — the host POSTs to the gated /pages/link-status (a pure FGA `view` batch, NO DB
// existence query), so non-existent / deleted / private / cross-tenant ids are uniformly "not viewable"
// (existence-hiding, #262). null ⇒ could not resolve → the overlay treats every link as ALIVE (never a
// false "dead"). Absent facet (guest/picker-less surfaces without the seam) ⇒ nothing is struck.
export type LinkStatusResolver = (ids: string[]) => Promise<Set<string> | null>;
export const linkStatusResolver = Facet.define<LinkStatusResolver, LinkStatusResolver | null>({
  combine: (values) => (values.length ? values[values.length - 1]! : null),
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

// #502 / ADR-184: the host seam for cross-island CO-EDIT. Present on the OUTER EDIT surface whenever there
// is a live awareness (Editor.tsx): `awareness` is the page awareness the co-occupancy roster reads, and
// `connect(anchor)` opens the ephemeral `:x:` room for that island. This INCLUDES edit-authority share-link
// guests — anonymous real-time co-editing is the product's north star, and the `:x:` room carries the same
// server authz gate as the Excalidraw modal (no new trust boundary). VIEW-only guests never reach here (they
// get mountPublishedView, which has no editUI surface). Absent a live awareness (no-collab, unit tests) → the
// island editor stays a private local doc. Co-edit ALSO requires 2+ occupants, so single-user editing (even
// with the facet present) never spins anything up (ADR §3 zero-cost) — the shipped path is untouched.
export interface CoEditHost {
  readonly awareness: AwarenessLike;
  connect(anchor: string): EphemeralSession;
}
export const coEditHost = Facet.define<CoEditHost, CoEditHost | null>({
  combine: (values) => (values.length ? values[values.length - 1]! : null),
});

// #200: dispatched by the editor when the light/dark theme changes, so buildDecorations re-runs and
// rebuilds macro widgets with the new theme (their eq keys on theme → CM recreates them → liveRender
// re-exports for the new theme). The effect CARRIES the new theme (React's resolved value): a live
// <html data-theme> read is STALE at dispatch time — the Editor effect fires child-first, before
// ThemeProvider updates the DOM — so buildDecorations uses this payload as the theme override.
export const redrawMacros = StateEffect.define<MacroTheme>();

// #92 comment 982 (②③): the presence badge (a block widget above the macro) was replaced by an
// outline + top-right avatar overlay generalised to every macro block — see macro-presence-overlay.ts
// (a read-only measure overlay, the presence-safe pattern shared with remote-cursors). The `macroPresence`
// facet + MacroPresence/MacroPresencePeer types above stay (the awareness bridge the overlay reads).

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

// #370 / ADR-145: host-mediated `:::tagged` / `:::children` dynamic lists. The macro NEVER fetches
// (host-API is {theme} only, ADR-024); the HOST supplies a `fetch(name, body)` bound to THIS page that hits
// the member-only, view-filtered `GET /pages/:id/list?name=…&body=…` (the server view-gates the host page and
// FGA-view-confirms every result — an unviewable page is absent from list AND count). `fetch` returns the
// authorized pages, or null (existence-hiding: denied/network are indistinguishable). `navigate` routes a
// click (the destination re-confirms view → uniform 404). Strings live on the host (i18n stays out of the CM
// layer). The facet is absent on anonymous/template surfaces (member-only — a guest surface renders the baked
// snapshot server-side instead), so the boundary is enforced by absence.
export interface ListSource {
  // `depth` (#370): 0-based nesting for `:::children` (the server's descendant tree, re-rooted past
  // unviewable intermediates); absent (tagged) = flat.
  readonly fetch: (name: "tagged" | "children", body: string) => Promise<{ id: string; title: string; depth?: number }[] | null>;
  readonly navigate: (pageId: string) => void;
  readonly emptyLabel: string; // dim edit-surface placeholder (a 0-height read-surface widget shows nothing)
  readonly untitledLabel: string; // fallback text for a result page with no title
}
export const listSource = Facet.define<ListSource | null, ListSource | null>({
  combine: (v) => (v.length ? v[v.length - 1]! : null),
});

// The optional `[label]` on a `:::tagged[]` / `:::children[]` open line (renders only alongside a
// non-empty list). `name` selects which directive's label to read.
function directiveLabel(openLine: string, name: string): string | null {
  const m = new RegExp(`^\\s*:::+\\s*${name}\\s*\\[([^\\]]*)\\]`).exec(openLine);
  return m && m[1]!.trim() ? m[1]!.trim() : null;
}

// Build a rendered list-of-pages DOM (shared by `:::tagged` and `:::children`): an optional label + a list of
// view-authorized pages. Each row navigates through the host seam (never hardcoded routing — the destination
// re-confirms view). Text via textContent (no innerHTML) — the titles came from the view-gated endpoint and are
// treated as untrusted here regardless. `variant` selects the test-id namespace; the CSS classes are shared.
// buildLinkList moved to md-render.ts (#370) — ONE builder for the top-level widget AND the
// nested list-host seam, so the two render paths cannot drift.

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
// #323: the callback ALSO carries the picked page's TITLE (optional — the raw-id fallback has none).
// The embed consumers ignore it; the page-LINK insert uses it as the link text. Additive → every
// existing PageEmbedPicker implementation stays type-compatible.
export type PageEmbedPicker = (onPick: (pageId: string | null, title?: string | null) => void) => void;
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

// #413 / ADR-145 §5: viewer-scoped tag suggestions for the frontmatter chip editor. The host binds a
// member-only fetch to GET /tags/suggest (the server offers a tag only when the caller can view ≥1 page
// carrying it — a tag name is content). Absent on guest/template surfaces → no suggestions, input still works.
export type TagSuggestSource = (q: string) => Promise<{ tag: string; display: string }[] | null>;
export const tagSuggestSource = Facet.define<TagSuggestSource | null, TagSuggestSource | null>({
  combine: (v) => (v.length ? v[v.length - 1]! : null),
});

// #413: the host seam that opens a TAG PICKER for `:::tagged` insertion (a modal with the same
// view-filtered suggestions). null tag = cancelled. Mirrors embedUrlPrompt.
export type TagPrompt = (onSubmit: (tag: string | null) => void) => void;
export const tagPrompt = Facet.define<TagPrompt | null, TagPrompt | null>({
  combine: (v) => (v.length ? v[v.length - 1]! : null),
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
function changeEmbedTarget(view: EditorView, getPos: () => number, name: string): void {
  const write = (value: string) => {
    let ch: { from: number; to: number; insert: string } | null = null;
    try { ch = embedRetargetChange(view.state, getPos(), name, value); } catch { ch = null; }
    if (!ch) { view.focus(); return; }
    // #332an atomSelectable embed (embed-page) must land the caret on the atom START so the block
    // renders SELECTED (the image-atom look: blanked fat cursor + full-card ring) rather than revealing raw
    // at the block end. Re-pin on a SECOND frame so the vimWysiwygCaretGuard's blank class survives CM's
    // focus className rebuild (see openEmbedPagePicker). embed-external is not atomSelectable → caret stays
    // at the block end (its caret-in reveal is the intended edit path).
    const m = findDirectiveMacro(name);
    const atomSel = !!(m?.revealOnCursor && m.atomSelectable);
    const caret = atomSel ? ch.from : ch.from + ch.insert.length;
    view.dispatch({ changes: ch, selection: EditorSelection.cursor(caret), scrollIntoView: true });
    view.focus();
    if (atomSel) requestAnimationFrame(() => { view.focus(); requestAnimationFrame(() => { if (view.dom.isConnected) view.dispatch({ selection: EditorSelection.cursor(Math.min(caret, view.state.doc.length)) }); }); });
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
    try { cur = directiveMacroAt(view.state, getPos())?.body.trim() ?? ""; } catch { /* detached → empty seed */ }
    prompt(cur, (url) => { if (url != null && url.trim() !== "") write(url.trim()); else view.focus(); });
  }
}

const ATTACHMENT_REF = /^!\[([^\]]*)\]\(wks-attachment:([^)\s]+)\)$/;

// #255 comment 1073/1074: a standalone image carries its alignment as a query on its OWN opaque scheme
// `![alt](wks-attachment:<id>?align=left)`. The surface notation stays standard Markdown (the URL is
// opaque); center is the default and writes NO query, so existing docs are unchanged. Parse splits the id
// from the query so the resolver still gets the clean id.
type ImageRef = { alt: string; id: string; align: FenceAlign };
function parseImageRef(text: string): ImageRef | null {
  const m = ATTACHMENT_REF.exec(text.trim());
  if (!m) return null;
  const alt = m[1]!, raw = m[2]!;
  const q = raw.indexOf("?");
  if (q === -1) return { alt, id: raw, align: "center" };
  const a = new URLSearchParams(raw.slice(q + 1)).get("align");
  return { alt, id: raw.slice(0, q), align: a === "left" || a === "right" ? a : "center" };
}
// #273: [name](wks-attachment:<id>) — the FILE attachment link (the image ref minus the `!`).
// Same opaque-scheme rule: the id may carry a query (reserved), which parse strips.
const ATTACHMENT_LINK_REF = /^\[([^\]]*)\]\(wks-attachment:([^)\s]+)\)$/;
type AttachmentLinkRef = { name: string; id: string };
function parseAttachmentLinkRef(text: string): AttachmentLinkRef | null {
  const m = ATTACHMENT_LINK_REF.exec(text.trim());
  if (!m) return null;
  const raw = m[2]!;
  const q = raw.indexOf("?");
  return { name: m[1]!, id: q === -1 ? raw : raw.slice(0, q) };
}
// The STANDALONE attachment link (its line is nothing but the link) at `pos`, or null
// Ctrl+Enter raw-reveal + the render gate (mirrors imageBlockAt).
function attachmentBlockAt(state: EditorState, pos: number): { from: number; to: number; ref: AttachmentLinkRef } | null {
  const line = state.doc.lineAt(pos);
  const ref = parseAttachmentLinkRef(line.text);
  if (!ref) return null;
  const lead = line.text.length - line.text.trimStart().length;
  const from = line.from + lead;
  return { from, to: from + line.text.trim().length, ref };
}

// The STANDALONE image (its line is nothing but the image) at `pos`, or null — used by Ctrl+Enter reveal,
// the right-click align menu, and the render gate. Range = the image markdown within the line.
function imageBlockAt(state: EditorState, pos: number): { from: number; to: number; ref: ImageRef } | null {
  const line = state.doc.lineAt(pos);
  const ref = parseImageRef(line.text);
  if (!ref) return null;
  const lead = line.text.length - line.text.trimStart().length;
  const from = line.from + lead;
  return { from, to: from + line.text.trim().length, ref };
}
// #255: rewrite a standalone image's `?align=` query (center → left → right → center; center DROPS the
// query so an untagged image stays untagged). One offset-invariant Y.Text replace of the image markdown.
export function setImageAlign(view: EditorView, pos: number, align: FenceAlign): void {
  const img = imageBlockAt(view.state, pos);
  if (!img) return;
  const q = align === "center" ? "" : `?align=${align}`;
  const next = `![${img.ref.alt}](wks-attachment:${img.ref.id}${q})`;
  if (next === view.state.doc.sliceString(img.from, img.to)) return;
  view.dispatch({ changes: { from: img.from, to: img.to, insert: next }, userEvent: "input" });
}
// #255: the standalone image at `pos` if it is one (so the context menu offers alignment only there).
export function imageAlignAt(state: EditorState, pos: number): number | null {
  return imageBlockAt(state, pos) ? state.doc.lineAt(pos).from : null;
}

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
    img.className = "cm-lp-image cm-lp-image-inline"; // #305: inline (text on the line) → line-height thumbnail
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

// #273: human-readable size for the attachment chip/card (display-only).
function fmtBytes(n: number | null): string {
  if (n == null || !isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// #273: trigger a download of an attachment — resolve a fresh presigned URL (served with
// Content-Disposition: attachment) and click a transient anchor. Never persists the URL.
function triggerAttachmentDownload(view: EditorView, id: string): void {
  const r = view.state.facet(attachmentResolver);
  void r.meta(id).then((m) => {
    if (!m) return;
    const a = document.createElement("a");
    a.href = m.downloadUrl;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}

// #273open a PDF attachment LARGE in an in-app lightbox. It reuses the EXACT same containment as the
// inline card — an opaque-origin `sandbox="allow-scripts"` (NO allow-same-origin) iframe rendering pdf.js from
// bytes the parent view-gate-fetched (`resolver.inlineUrl`, the existing route → no new authz surface). A raw
// new tab is deliberately NOT used: it wouldn't carry a share-link guest's token, and it would drop out of the
// opaque-frame containment. The lightbox is appended to <body> (OUTSIDE .cm-editor), so its styles are INLINE
// (the CM baseTheme is editor-scoped and would not reach it). Escape / ✕ / a backdrop click close it.
function openAttachmentLightbox(view: EditorView, id: string, name: string): void {
  if (document.querySelector("[data-testid=attachment-lightbox]")) return; // one at a time
  const resolver = view.state.facet(attachmentResolver);
  const backdrop = document.createElement("div");
  backdrop.setAttribute("data-testid", "attachment-lightbox");
  backdrop.style.cssText = "position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.6);backdrop-filter:blur(2px)";
  const panel = document.createElement("div");
  panel.style.cssText = "display:flex;flex-direction:column;width:min(900px,92vw);height:min(90vh,100%);background:var(--panel,#fff);color:var(--fg,#111);border:1px solid var(--border,rgba(128,128,128,.35));border-radius:10px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.35)";
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border,rgba(128,128,128,.25))";
  const title = document.createElement("span");
  title.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500";
  title.textContent = `📎 ${name || "attachment"}`;
  const btnCss = "border:none;background:transparent;cursor:pointer;padding:2px 8px;font-size:1.05em;color:inherit;opacity:.75;border-radius:6px";
  const dl = document.createElement("button");
  dl.type = "button"; dl.style.cssText = btnCss; dl.title = "Download"; dl.textContent = "⤓";
  dl.setAttribute("data-testid", "attachment-lightbox-download");
  const close = document.createElement("button");
  close.type = "button"; close.style.cssText = btnCss; close.title = "Close"; close.textContent = "✕";
  close.setAttribute("data-testid", "attachment-lightbox-close");
  bar.append(title, dl, close);
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts"); // opaque origin; NO allow-same-origin — same containment as the card
  frame.setAttribute("data-testid", "attachment-lightbox-frame");
  frame.title = name || "attachment";
  frame.src = "/pdf-frame.html";
  frame.style.cssText = "flex:1;width:100%;min-height:0;border:none;background:#fff";
  panel.append(bar, frame);
  backdrop.appendChild(panel);

  let onMsg: ((e: MessageEvent) => void) | null = null;
  const teardown = () => {
    if (onMsg) window.removeEventListener("message", onMsg);
    window.removeEventListener("keydown", onKey);
    backdrop.remove();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); teardown(); } };
  dl.addEventListener("click", (e) => { e.stopPropagation(); triggerAttachmentDownload(view, id); });
  close.addEventListener("click", (e) => { e.stopPropagation(); teardown(); });
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) teardown(); }); // click outside the panel closes
  window.addEventListener("keydown", onKey);
  document.body.appendChild(backdrop);

  // Fetch the bytes fresh (view-gated; the resolver caches the blob URL). The card's copy was transferred to
  // its own frame and is neutered, so the lightbox needs its own ArrayBuffer. Hand them to the opaque frame on ready.
  void resolver.inlineUrl(id).then(async (url) => {
    if (!url || !backdrop.isConnected) return;
    const bytes = await fetch(url).then((r) => r.arrayBuffer()).catch(() => null);
    if (!bytes || !backdrop.isConnected) return;
    onMsg = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;
      if ((e.data as { type?: string })?.type === "pdf-frame:ready") { try { frame.contentWindow?.postMessage(bytes, "*", [bytes]); } catch { /* frame gone */ } }
    };
    window.addEventListener("message", onMsg);
  });
}

// #273 / ADR-120: INLINE file-attachment chip — [name](wks-attachment:id) with other text on
// the line. Renders 📎 name (+ size once resolved) with a small download button. On the EDIT
// surface the chip body passes clicks through (caret lands → the line reveals raw, like the
// inline image); only the ⤓ button is interactive, with the #265 mousedown guard. On a
// READ-ONLY surface (c 07-16 return, item 2) the body click runs the type's PRIMARY action
// PDF → the lightbox, anything else → download — and the chip shows hover + a matching cursor
// on BOTH surfaces (zoom-in for a PDF, pointer otherwise) so it reads as pressable.
class AttachmentChipWidget extends WidgetType {
  constructor(readonly id: string, readonly name: string) { super(); }
  eq(other: AttachmentChipWidget) { return other.id === this.id && other.name === this.name; }
  toDOM(view: EditorView) {
    const chip = document.createElement("span");
    chip.className = "cm-lp-attachment-chip";
    chip.setAttribute("data-testid", "attachment-chip");
    const label = document.createElement("span");
    label.textContent = `📎 ${this.name || "attachment"}`;
    chip.appendChild(label);
    const size = document.createElement("span");
    size.className = "cm-lp-attachment-size";
    chip.appendChild(size);
    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "cm-lp-attachment-dl";
    dl.title = "Download";
    dl.setAttribute("aria-label", "Download");
    dl.setAttribute("data-testid", "attachment-download");
    dl.textContent = "⤓";
    dl.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    dl.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); triggerAttachmentDownload(view, this.id); });
    chip.appendChild(dl);
    void view.state.facet(attachmentResolver).meta(this.id).then((m) => {
      if (m?.sizeBytes != null) size.textContent = ` (${fmtBytes(m.sizeBytes)})`;
    });
    if (view.state.readOnly) {
      // read surface: the whole chip is the primary action (there is no caret/raw to protect).
      // #273(user ruling): the INLINE chip has no rendered preview, so zooming was unnatural
      // EVERY chip click downloads (pointer cursor, no PDF special case); the lightbox belongs only to
      // the standalone card's ACTUALLY-RENDERED preview area (the ⤢ expand below).
      chip.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }); // #265 guard
      chip.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("button")) return; // ⤓ handles itself
        e.preventDefault();
        e.stopPropagation();
        triggerAttachmentDownload(view, this.id);
      });
    }
    return chip;
  }
  ignoreEvent() { return false; } // body clicks pass through (edit surface) → caret enters → raw reveal
}

// #273 / ADR-120: STANDALONE file attachment (its line is only the link) — an ATOM like the
// standalone image: click selects (ring), raw source only via explicit entry (Ctrl+Enter /
// the ✎ pill → macroRenderActiveField). Renders a download card (icon + name + size + ⤓);
// a server-sniffed PDF within the inline cap additionally mounts the sandboxed viewer
// an <iframe sandbox> (NO allow-scripts — the ADR-120 contract) whose src is a blob: URL of
// the PROXIED inline bytes (authoritative Content-Type + nosniff + CSP; see the resolver).
type AtDom = HTMLElement & { __atRo?: ResizeObserver; __atKey?: string; __atPdfMsg?: (e: MessageEvent) => void; __atInlineDone?: boolean };
class AttachmentCardWidget extends WidgetType {
  private ro?: ResizeObserver;
  constructor(readonly id: string, readonly name: string, readonly selected: boolean) { super(); }
  private key() { return `${this.id} ${this.name}`; }
  eq(o: AttachmentCardWidget) { return o.id === this.id && o.name === this.name && o.selected === this.selected; }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div") as AtDom;
    wrap.className = `cm-lp-macro-wrap cm-lp-attachment-wrap ${ATOM_BOX_CLASS}`;
    if (this.selected) wrap.classList.add("cm-lp-atom-sel");
    wrap.setAttribute("data-testid", "attachment-card");

    const card = document.createElement("div");
    card.className = "cm-lp-attachment-card";
    const label = document.createElement("span");
    label.className = "cm-lp-attachment-name";
    label.textContent = `📎 ${this.name || "attachment"}`;
    card.appendChild(label);
    const size = document.createElement("span");
    size.className = "cm-lp-attachment-size";
    card.appendChild(size);
    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "cm-lp-attachment-dl";
    dl.title = "Download";
    dl.setAttribute("aria-label", "Download");
    dl.setAttribute("data-testid", "attachment-download");
    dl.textContent = "⤓";
    // #265 guard: interactive DOM inside an atom widget must stopPropagation on mousedown
    // (NOT ignoreEvent=true, which would swallow keydown and break Esc).
    dl.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    dl.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); triggerAttachmentDownload(view, this.id); });
    card.appendChild(dl);
    wrap.appendChild(card);

    // #273(2): a DOWNLOAD card (non-inline binary) downloads on a click ANYWHERE in the card, not just
    // the ⤓. The wrap's mousedown still selects the atom (ring) first, so a click both selects AND acts
    // (owner-approved).(supersedes theall-open mapping): affordances split by REGION
    // the header (name + icon row) always DOWNLOADS with a pointer cursor, PDF or not; the PREVIEW
    // area is the "open" surface (zoom-in + lightbox via the frame's ⤢/expand path below).
    card.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) return; // the ⤓ (or edit) button handles itself
      e.preventDefault();
      triggerAttachmentDownload(view, this.id);
    });

    this.ensureInlineMount(view, wrap, size);

    // Click selects the atom (ring), never reveals raw — raw is explicit entry only (Ctrl+Enter / pill).
    wrap.addEventListener("mousedown", (e) => {
      if (view.state.readOnly || e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button, iframe")) return;
      e.preventDefault();
      view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(wrap)) });
      view.focus();
    });
    if (!view.state.readOnly) {
      const btnRow = document.createElement("div");
      btnRow.className = "cm-lp-macro-btnrow";
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "cm-lp-macro-edit cm-lp-macro-edit-hint";
      reveal.title = "Edit";
      reveal.innerHTML = MACRO_EDIT_BUTTON_HTML;
      reveal.setAttribute("data-testid", "macro-edit");
      reveal.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); enterMacroAt(view, view.posAtDOM(wrap), true); });
      btnRow.appendChild(reveal);
      wrap.appendChild(btnRow);
    }
    this.ro = observeBlockResize(view, wrap);
    wrap.__atRo = this.ro;
    wrap.__atKey = this.key();
    return wrap;
  }
  // #273(1): resolve the attachment meta and, for a PDF, mount the inline pdf.js frame — IDEMPOTENTLY.
  // The async continuation is torn down by `wrap.isConnected` if the wrap disconnects (e.g. the publish
  // transition rebuilds the widget DOM while this is in flight), and `updateDOM` reuses the surviving DOM
  // (no fresh toDOM). Previously the aborted mount never re-ran on the surviving DOM → the PDF frame only
  // appeared after a reload. Now updateDOM re-invokes this when the mount hasn't completed (`__atInlineDone`),
  // and the guards (done-flag + frame-present) make it safe to call again on an already-mounted card.
  private ensureInlineMount(view: EditorView, wrap: AtDom, size: HTMLElement) {
    if (wrap.__atInlineDone) return;
    const resolver = view.state.facet(attachmentResolver);
    void resolver.meta(this.id).then((m) => {
      if (!m) return; // couldn't resolve → leave undone so a later updateDOM re-attempts
      if (m.sizeBytes != null && size.textContent === "") size.textContent = ` (${fmtBytes(m.sizeBytes)})`;
      // v1 inline kind: PDF only (ADR-120 review). The server enforces the kind + the 25MB cap
      // (415/413 → inlineUrl resolves null → the card stays a plain download card).
      if (m.inlineKind !== "pdf") { wrap.__atInlineDone = true; return; } // non-inline → done (never re-run)
      if (wrap.querySelector(".cm-lp-attachment-frame")) { wrap.__atInlineDone = true; return; } // already mounted
      // Claim the mount SYNCHRONOUSLY so a concurrent ensureInlineMount (toDOM + updateDOM racing across the
      // publish transition) doesn't double-mount; reset it on failure so updateDOM can retry.
      wrap.__atInlineDone = true;
      // #273 / ADR-120 (Option B,): render the sniffed-PDF bytes with OUR pdf.js inside an
      // OPAQUE-ORIGIN iframe — `sandbox="allow-scripts"` (so pdf.js runs) but NO `allow-same-origin`
      // (the frame can't reach the app origin / cookies / storage). Chromium's native PDF viewer refused
      // a fully-empty sandbox (#1447), and PDF-embedded JS must never run against an app that will accept
      // anonymous-editor attachments (#274), so pdf.js (v6, no eval, byte→canvas) in an opaque frame is
      // the containment. The parent (which already view-gate-fetched the bytes) posts them IN — a blob
      // URL is origin-scoped and unreadable by the opaque frame, so we transfer the ArrayBuffer instead.
      void resolver.inlineUrl(this.id).then(async (url) => {
        if (!url) { wrap.__atInlineDone = false; return; } // no inline route → allow a retry
        // NB: do NOT revoke `url` — the resolver caches this blob URL (blobCache, alive until page unload)
        // and hands the SAME url back on a later render (publish→view re-mount). Revoking it here (the old
        // #273bug) killed the cached URL, so the second render's fetch failed and the frame never
        // reappeared without a reload.
        const bytes = await fetch(url).then((r) => r.arrayBuffer()).catch(() => null);
        if (!bytes) { wrap.__atInlineDone = false; return; }
        if (wrap.querySelector(".cm-lp-attachment-frame")) return; // a concurrent mount already won
        // #273(1): do NOT abort on a transient `!wrap.isConnected` — the publish transition briefly
        // detaches the reused card DOM while it swaps draft→published, and the old code dropped the mount
        // permanently (the frame only returned on reload). Append to the captured wrap regardless; if it is
        // the live/reused node the frame shows, and destroy removes the listener when CM discards the DOM.
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts"); // opaque origin; NO allow-same-origin
        frame.className = "cm-lp-attachment-frame";
        frame.title = this.name || "attachment";
        frame.setAttribute("data-testid", "attachment-inline-frame");
        frame.src = "/pdf-frame.html";
        // Hand the bytes over once the frame signals ready; size the frame to the rendered content.
        const onMsg = (e: MessageEvent) => {
          if (e.source !== frame.contentWindow) return;
          const d = e.data as { type?: string; height?: number };
          if (d?.type === "pdf-frame:ready") { try { frame.contentWindow?.postMessage(bytes, "*", [bytes]); } catch { /* frame gone */ } }
          else if (d?.type === "pdf-frame:rendered" && typeof d.height === "number") { frame.style.height = `${Math.min(d.height + 4, 800)}px`; }
        };
        window.addEventListener("message", onMsg);
        wrap.__atPdfMsg = onMsg; // removed in destroy() (below) so it never outlives the widget DOM
        // #273the inline PDF is a PREVIEW — wrap it so a hover overlay reveals it opens LARGE. The
        // sandboxed iframe swallows its own pointer events, so a sibling overlay (shown on wrap:hover) captures
        // the expand click and marks the affordance (cursor:zoom-in + a ⤢ hint). Reuses the same containment.
        const frameBox = document.createElement("div");
        frameBox.className = "cm-lp-attachment-framebox";
        frameBox.appendChild(frame);
        const expand = document.createElement("div");
        expand.className = "cm-lp-attachment-expand";
        expand.setAttribute("data-testid", "attachment-expand");
        expand.title = "Open";
        const hint = document.createElement("span");
        hint.className = "cm-lp-attachment-expand-hint";
        hint.textContent = "⤢";
        expand.appendChild(hint);
        expand.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        expand.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openAttachmentLightbox(view, this.id, this.name); });
        frameBox.appendChild(expand);
        wrap.appendChild(frameBox);
      });
    });
  }
  // A selection-only change must NOT rebuild (a rebuild re-fetches and reloads the PDF frame
  // the same flicker rule as the standalone image, #255).
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    if ((dom as AtDom).__atKey !== this.key()) return false;
    this.ro = (dom as AtDom).__atRo;
    dom.classList.toggle("cm-lp-atom-sel", this.selected);
    // #273(1): if a prior mount was aborted (the publish transition disconnected the earlier wrap),
    // this surviving DOM never got its PDF frame. Re-run the idempotent mount so it appears without a reload.
    const size = dom.querySelector<HTMLElement>(".cm-lp-attachment-size");
    if (size) this.ensureInlineMount(view, dom as AtDom, size);
    return true;
  }
  destroy(dom: HTMLElement) {
    (dom as AtDom).__atRo?.disconnect();
    const h = (dom as AtDom).__atPdfMsg; // #273: the PDF frame's postMessage bridge must not outlive the DOM
    if (h) window.removeEventListener("message", h);
  }
  ignoreEvent() { return false; }
}

// #255 comment 1073: a STANDALONE image (its line is only the image) is a first-class ATOM, like a
// diagram macro — a click SELECTS it (ring), never reveals raw; hover/selection shows a top-left btnRow
// (an align toggle + a reveal pill); raw source is reached only via Ctrl+Enter / the pill (explicit entry,
// gated on macroRenderActiveField — NOT caret-landing). Alignment (center default) drives the wrap's
// text-align. Inline images (text on the line) keep the plain ImageWidget + reveal-on-cursor.
type SiDom = HTMLElement & { __siRo?: ResizeObserver; __siKey?: string };
class StandaloneImageWidget extends WidgetType {
  private ro?: ResizeObserver;
  constructor(readonly id: string, readonly alt: string, readonly align: FenceAlign, readonly selected: boolean) {
    super();
  }
  // #255`align` is NOT in the reuse key — an align-only change updates the DOM in place
  // (updateDOM), never rebuilds. A rebuild re-resolves the <img> async, so its height collapses to 0
  // while it reloads, the doc shrinks, and CM loses its scroll position (jumps to top).
  private key() { return `${this.id} ${this.alt}`; }
  eq(o: StandaloneImageWidget) { return o.id === this.id && o.alt === this.alt && o.align === this.align && o.selected === this.selected; }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div") as SiDom;
    wrap.className = `cm-lp-macro-wrap cm-lp-image-wrap cm-lp-atom-body ${ATOM_BOX_CLASS}`; // #395/ADR-156: image = atom, no I-beam
    wrap.classList.add(`cm-lp-align-${this.align}`); // center default; drives text-align (same as diagrams)
    if (this.selected) wrap.classList.add("cm-lp-atom-sel");
    const img = document.createElement("img");
    img.className = "cm-lp-image";
    img.alt = this.alt;
    img.setAttribute("data-testid", "macro-image");
    const resolve = view.state.facet(imageResolver);
    const load = (refresh: boolean) => { void resolve(this.id, { refresh }).then((url) => { if (url) img.src = url; }); };
    let retried = false;
    img.addEventListener("error", () => { if (retried) return; retried = true; load(true); });
    load(false);
    wrap.appendChild(img);
    // A click SELECTS the atom (caret on it → ring), never reveals raw (ADR-024 for macros; #255 extends it
    // to images). The reveal pill / Ctrl+Enter are the explicit way to the raw markdown.
    wrap.addEventListener("mousedown", (e) => {
      if (view.state.readOnly || e.button !== 0) return; // left-click selects; right-click → context menu
      e.preventDefault();
      view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(wrap)) });
      view.focus();
    });
    if (!view.state.readOnly) {
      const btnRow = document.createElement("div");
      btnRow.className = "cm-lp-macro-btnrow";
      // reveal pill — the ✎ affordance; images have no rich editor, so it reveals the RAW markdown (like a
      // ``` source macro). Ctrl+↵ hint mirrors the diagram raw-entry pill.
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "cm-lp-macro-edit cm-lp-macro-edit-hint";
      reveal.title = "Edit";
      reveal.innerHTML = MACRO_EDIT_BUTTON_HTML;
      reveal.setAttribute("data-testid", "macro-edit");
      reveal.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); enterMacroAt(view, view.posAtDOM(wrap), true); });
      btnRow.appendChild(reveal);
      // #255a 3-button segmented align control (writes the standalone image's `?align=` query).
      btnRow.appendChild(makeAlignSegment(this.align, (a) => setImageAlign(view, view.posAtDOM(wrap), a)));
      wrap.appendChild(btnRow);
    }
    this.ro = observeBlockResize(view, img);
    wrap.__siRo = this.ro;
    wrap.__siKey = this.key();
    return wrap;
  }
  // A selection-only change (ring toggle) must NOT rebuild — that would re-resolve the image (flicker). Reuse
  // the DOM when the rendered content (id/alt/align) is identical and only `selected` differs.
  updateDOM(dom: HTMLElement): boolean {
    if ((dom as SiDom).__siKey !== this.key()) return false;
    this.ro = (dom as SiDom).__siRo;
    dom.classList.toggle("cm-lp-atom-sel", this.selected);
    // #255apply an align-only change in place (keep the loaded <img>) instead of rebuilding.
    for (const a of ["left", "center", "right"] as const) dom.classList.toggle(`cm-lp-align-${a}`, a === this.align);
    const seg = dom.querySelector<HTMLElement>(".cm-lp-align-seg"); // #255update the segment's active side
    if (seg) updateAlignSegment(seg, this.align);
    return true;
  }
  destroy(dom: HTMLElement) { (dom as SiDom).__siRo?.disconnect(); }
  ignoreEvent() { return false; }
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
export function linkHref(src: string): string | null {
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
    wrap.className = `cm-lp-table-wrap ${ATOM_BOX_CLASS}`;
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
    // #406the horizontal scroll belongs to a box of its OWN, between the wrap and the table.
    // Putting overflow on the wrap looked equivalent and was not: the wrap sizes to `fit-content`, so a
    // wide table stretched it, the widget stretched `.cm-content`, and the whole EDITOR scrolled
    // sideways — text, headings and all. The inner box is pinned to the line width instead
    // (`width: 0; min-width: 100%`), so it cannot grow, and the table overflows it rather than the page.
    // The wrap keeps no overflow: it anchors the chrome that floats above the table (top: -1.5em) and is
    // the ResizeObserver's target, and clipping either of those would be a different bug.
    const scroller = document.createElement("div");
    scroller.className = "cm-lp-table-scroll";
    scroller.appendChild(table);
    wrap.appendChild(scroller);
    // #216 comment 874: the RichUI-entry pill does NOT belong on the RENDERED table (a finished, non-edited
    // grid needs no entry affordance). It belongs on the RAW-EDITING state — when the caret is in the table
    // and the `| a | b |` source is visible. That pill is emitted by the reveal branch (TableRawRichuiPill),
    // not here. The rendered widget stays clean.
    // #393 / ADR-151 addendum 3: a rendered pipe (GFM) table gets the SAME hover align segment a rendered
    // `:::table` (MacroWidget) carries at :2651 — so hovering EITHER table exposes left/center/right, not
    // just `:::table`. A pipe table is invariantly LEFT (any non-left promotes to `:::table` = a MacroWidget,
    // a different widget), so the current side is always "left"; picking center/right runs setTableAlign,
    // which promotes the pipe to `:::table{align=…}` (thepipeline). Editable surface only — the
    // read-only view renders through md-render, never this widget. The btnrow rides in a `.cm-lp-macro-btnrow`
    // (shared chrome class); its hover-reveal is wired for `.cm-lp-table-wrap` in the theme CSS below.
    if (!view.state.readOnly) {
      const btnRow = document.createElement("div");
      btnRow.className = "cm-lp-macro-btnrow";
      btnRow.appendChild(makeAlignSegment("left", (a) => setTableAlign(view, view.posAtDOM(wrap), a)));
      wrap.appendChild(btnRow);
    }
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
    btn.innerHTML = MACRO_EDIT_BUTTON_HTML;
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
// #278point 4: the pill is no longer permanently visible while a block is revealed — it shows
// only while the MOUSE hovers the block or the CARET rests on the block's head line. The zone class
// marks every body line of the revealed block (the `:has` hover rule keys on it; only one block can
// be revealed at a time, so a doc-global rule is precise); the head class flags "caret on the head
// line" so the keyboard path still surfaces the affordance without a mouse.
const macroRawZone = Decoration.line({ attributes: { class: "cm-lp-macro-raw-zone" } });
const macroRawHead = Decoration.line({ attributes: { class: "cm-lp-macro-raw-head" } });
function addRawPillContext(ctx: { add(d: Decoration, pos: number): void; state: EditorState }, from: number, to: number) {
  const doc = ctx.state.doc;
  const firstLine = doc.lineAt(from);
  const lastLine = doc.lineAt(Math.min(to, doc.length));
  ctx.add(macroRawLead, firstLine.from);
  const h = ctx.state.selection.main.head;
  if (h >= firstLine.from && h <= firstLine.to) ctx.add(macroRawHead, firstLine.from);
  for (let n = firstLine.number + 1; n <= lastLine.number; n++) ctx.add(macroRawZone, doc.line(n).from);
}

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
    // #393 / ADR-151 addendum 3: the WHOLE-TABLE align segment stays visible while the RichUI
    // island is open — orthogonal to the toolbar's per-CELL text-align (patchStyle). mount cleared the
    // wrap, so (re-)append it here on every mount/updateDOM. Current side reads from the source (a promoted
    // `:::table{align=…}` keeps its side; a pipe is left); picking runs the same promote/demote setTableAlign.
    if (!view.state.readOnly) {
      const btnRow = document.createElement("div");
      btnRow.className = "cm-lp-macro-btnrow";
      btnRow.appendChild(makeAlignSegment(tableAlignOf(this.source), (a) => setTableAlign(view, this.from, a)));
      dom.appendChild(btnRow);
    }
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
  constructor(readonly from: number, readonly to: number, readonly source: string, readonly editUI: EditUI, readonly wrapSource: (body: string) => string, readonly theme: MacroTheme, readonly tier?: MacroTier, readonly caretOutOnExit = false) { super(); }
  eq(o: EditableEditUIWidget) { return o.from === this.from && o.to === this.to && o.source === this.source && o.editUI === this.editUI && o.theme === this.theme && o.caretOutOnExit === this.caretOutOnExit; }
  private mountInto(dom: EditUIDom, view: EditorView) {
    dom.__editUICtrl?.destroy();
    dom.replaceChildren();
    const save = (newBody: MacroSource) => {
      const ch = editUISaveChange(this.from, this.to, this.wrapSource, this.tier, newBody);
      view.dispatch({ changes: ch, effects: setMacroRenderActive.of({ from: ch.from, to: ch.from + ch.insert.length }) });
      view.focus();
    };
    // #243 / ADR-111 C3 (slice 2): pass the OUTER editor's vim ON/OFF as a SEPARATE editEnv (not folded into
    // the {theme} MacroContext), so a CM6 source pane (mermaid/plantuml) enables vim following the user's
    // keymap setting. Read from the vimEnabled facet the vim Compartment sets (editor-livepreview.ts).
    dom.__editUICtrl = this.editUI.mount(dom, asMacroSource(this.source), { theme: this.theme }, save, {
      vim: view.state.facet(vimEnabled),
      // #456 S1/S3: lend the macro the HOST's editing surface instead of it standing up its own. The
      // macro gets a handle — never an EditorView — so vim, the slash palette, completion and nested
      // rendering come from the same factory the page and the slot islands use, and the {theme}
      // boundary is unchanged.
      mountSurface: (opts) => this.mountCoEditSurface(view, opts),
    });
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
    focused?.blur(); // commit-on-blur → the editUI's change fires save(), which dispatches the doc change
    // #243 / ADR-111 C1 (arbitration (a)): a fence diagram macro (mermaid/plantuml) now reveals its
    // RAW source on caret-in (the callout reveal class). So clearing render-active with the caret still on
    // the block would immediately re-reveal the source — "edit → Done → see the diagram" would show source,
    // not the rendered diagram (#239 regression). Place the caret on the line AFTER the block so the atom
    // renders. Scoped via caretOutOnExit so the callout editUI exit stays byte-identical. `save` above has
    // already set render-active to the NEW (post-edit) range, so read its `to` for the true block end.
    if (this.caretOutOnExit) {
      const doc = view.state.doc;
      const active = view.state.field(macroRenderActiveField, false);
      const end = Math.min(active ? active.to : this.to, doc.length);
      const endLine = doc.lineAt(end);
      const after = endLine.number < doc.lines ? doc.line(endLine.number + 1).from : endLine.to;
      view.dispatch({ selection: EditorSelection.cursor(after), effects: setMacroRenderActive.of(null) });
    } else {
      view.dispatch({ effects: setMacroRenderActive.of(null) });
    }
    view.focus();
  }
  // #502 / ADR-184 slice 2b-2b (final): a CO-EDIT-AWARE editing surface. Absent the coEditHost facet
  // (guests, tests, no live collab) it is EXACTLY mountHostSurface — byte-identical to the shipped path.
  // With the facet it returns a thin PROXY over a swappable inner surface: the IslandCoEditController
  // watches co-occupancy of this block's anchor and, ONLY when 2+ peers co-occupy, swaps `inner` to a
  // yCollab-bound shared-ephemeral surface (remote carets included); when occupancy drops it swaps back to
  // a local surface and flushes the merged body to the canonical Y.Text via the macro's own commit. A LONE
  // editor never crosses 2, so the controller never spins up and the surface stays the plain local one
  // shipped single-user editing is untouched. The re-mount focus/flush interaction (and the 2-client caret)
  // are device-visual: this ships behind a review (needs-human-check) with the 2-client gates.
  private mountCoEditSurface(view: EditorView, opts: HostSurfaceOptions): HostSurfaceHandle {
    const coHost = view.state.facet(coEditHost);
    if (!coHost) return mountHostSurface(view, opts); // no collab host → the shipped private-doc surface
    const anchor = String(this.from);
    let inner = mountHostSurface(view, opts);
    let destroying = false;
    const swap = (collab?: { text: Y.Text; awareness: unknown }, initial?: string) => {
      if (destroying) return;
      inner.destroy();
      inner = mountHostSurface(view, { ...opts, doc: asMacroSource(initial ?? opts.doc) }, collab);
      inner.focus();
    };
    const ctrl = new IslandCoEditController({
      awareness: coHost.awareness,
      anchor,
      fenceText: () => inner.getValue(),
      connect: () => coHost.connect(anchor),
      onBind: (session) => swap({ text: ephemeralBody(session.doc), awareness: session.awareness }),
      onUnbind: (flushed) => {
        // Flush the merged co-edit to the canon — but ONLY if it actually changed the body (a no-op flush
        // dispatches an identical edit → widget updateDOM → churn). CRUCIALLY, defer the flush to a
        // microtask: onUnbind can fire from the widget's OWN destroy/updateDOM, which runs INSIDE an outer
        // view.dispatch — and onCommit → the macro save → view.dispatch would be a NESTED dispatch (CM
        // throws "update in progress", and the merged body would be lost). Deferring runs it after the
        // current update completes, on the still-alive outer view (design-review). Guarded against a
        // torn-down view (full editor unmount between here and the microtask).
        if (flushed !== String(this.source)) {
          queueMicrotask(() => { try { opts.onCommit?.(asMacroSource(flushed)); } catch { /* outer view gone */ } });
        }
        swap(undefined, flushed); // back to a local surface so a now-lone editor keeps editing (no-op if destroying)
      },
    });
    return {
      getValue: () => inner.getValue(),
      focus: () => inner.focus(),
      inVimInsert: () => inner.inVimInsert(),
      destroy: () => { destroying = true; ctrl.dispose(); inner.destroy(); },
    };
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div") as EditUIDom;
    wrap.className = "cm-lp-editui-wrap"; // position:relative anchors the Done button (#239)
    wrap.contentEditable = "false"; // atom root (ADR-054): CM keeps the block atomic, no focus reclaim
    this.mountInto(wrap, view);
    // Escape exits (the keyboard way out; the Done button is added per-mount in mountInto). On wrap so it
    // survives updateDOM's replaceChildren. Capture so it beats an input that might also read Escape.
    // #243 / ADR-111 C3 slice 2b: if the editUI's editor is a vim CM6 pane currently in INSERT mode
    // (handlesEscape → true), DEFER — let the event reach the nested vim so the first Escape does
    // insert→normal (stays in the panel); only a NORMAL-mode Escape falls through to exit. Additive
    // a panel editUI without handlesEscape (callout) always exits, unchanged.
    wrap.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (wrap.__editUICtrl?.handlesEscape?.()) return; // vim insert → let the nested CM6 handle it
      e.preventDefault(); e.stopPropagation(); this.exit(wrap, view);
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
// #424: THE edit-entry button face — icon + the visible "Ctrl+↵" key hint, identical for every macro
// (editUI-opening and raw-revealing alike; what the press DOES stays per-macro). Trusted constant markup
// (no user input → XSS-safe). Never compose a bare-pencil variant — the uniform face is the contract.
const MACRO_EDIT_BUTTON_HTML = MACRO_EDIT_ICON + '<span class="cm-lp-macro-richui-key">Ctrl+↵</span>';
// #198 (comment 724): Lucide copy / check glyphs for the code-fence copy button. Trusted constants
// (no user input) → safe as innerHTML.
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
  // #278A: NO scrollIntoView. The `` click preventDefaults (the outer caret does NOT move to the
  // insertion point), so scrollIntoView would scroll to wherever the caret happens to be — jumping the page to
  // the top when the caret is above. The widget re-renders in place; the new item is visible without scrolling.
  view.dispatch({ changes: { from: closeLine.from, insert: `${colons}${childName}${label}\n\n${colons}\n` }, userEvent: "input.insert" });
}
// #278 §1: remove the i-th column/tab (was #213's remove-LAST only). One offset-invariant Y.Text delete of
// that child's fence range; never removes the last remaining item (a degenerate empty container).
function removeLayoutItemAt(view: EditorView, pos: number, childName: "column" | "tab", index: number): void {
  const d = directiveMacroAt(view.state, pos);
  if (!d) return;
  const items = resolveDirectiveRanges(view.state.doc.toString()).filter((r) => r.name === childName && r.from >= d.from && r.to <= d.to);
  if (items.length <= 1) return; // never remove the last remaining item (an empty container is degenerate)
  const it = items[index];
  if (!it) return;
  const fromLine = view.state.doc.lineAt(it.from);
  const toLine = view.state.doc.lineAt(Math.min(it.to, view.state.doc.length));
  view.dispatch({ changes: { from: fromLine.from, to: Math.min(toLine.to + 1, view.state.doc.length) }, userEvent: "delete" });
}

// #278A2: rewrite the i-th tab's label (`:::tab[old]` → `:::tab[new]`) — one offset-invariant
// replace of the OPEN-fence's head. Brackets/newlines are stripped from the label (they would corrupt the
// fence); an empty result keeps the old label (a nameless tab renders as "Tab n", which reads as data loss).
function renameTabAt(view: EditorView, pos: number, index: number, label: string): void {
  const d = directiveMacroAt(view.state, pos);
  if (!d || d.name !== "tabs") return;
  const items = resolveDirectiveRanges(view.state.doc.toString()).filter((r) => r.name === "tab" && r.from >= d.from && r.to <= d.to);
  const it = items[index];
  if (!it) return;
  const line = view.state.doc.lineAt(it.from);
  const m = /^(\s*:+tab)(\[[^\]]*\])?/.exec(line.text);
  if (!m) return;
  const safe = label.replace(/[[\]\n]/g, "").trim();
  if (!safe) return;
  const next = `${m[1]}[${safe}]`;
  if (next === m[0]) return;
  view.dispatch({ changes: { from: line.from, to: line.from + m[0].length, insert: next }, userEvent: "input" });
}

// #278A2: inline tab rename — clicking the ALREADY-ACTIVE tab swaps its label for an input; Enter /
// blur commit (renameTabAt → the widget rebuilds from the new source), Escape cancels. The input's mousedown
// AND keydown stopPropagation (the #265 widget-input lesson + the island key-routing lesson): its keys belong
// to the input, never to the outer CM/vim.
function startTabRename(view: EditorView, wrap: HTMLElement, cell: HTMLElement, index: number): void {
  if (cell.querySelector(".cm-lp-tab-rename-input")) return; // already renaming
  const textNode = Array.from(cell.childNodes).find((n) => n.nodeType === Node.TEXT_NODE) as Text | undefined;
  const old = (textNode?.textContent ?? cell.textContent ?? "").trim();
  const input = document.createElement("input");
  input.type = "text";
  input.value = old;
  input.className = "cm-lp-tab-rename-input";
  input.setAttribute("data-testid", "tab-rename-input");
  input.size = Math.max(old.length, 3);
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const value = input.value;
    input.remove();
    if (textNode) cell.insertBefore(textNode, cell.firstChild);
    if (commit && value.trim() && value.trim() !== old) renameTabAt(view, view.posAtDOM(wrap), index, value);
  };
  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  textNode?.remove();
  cell.insertBefore(input, cell.firstChild);
  setTimeout(() => { input.focus(); input.select(); }, 0);
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

// #393 / ADR-151: the `:::table` directive whose range contains `pos` (innermost), else null — the
// context-menu / align-segment gate, mirroring diagramFenceAt.
export function tableDirectiveAt(state: EditorState, pos: number): number | null {
  let best: { from: number; depth: number } | null = null;
  for (const d of resolveDirectiveRanges(state.doc.toString())) {
    if (d.name !== "table" || pos < d.from || pos > d.to) continue;
    if (!best || d.depth > best.depth) best = { from: d.from, depth: d.depth };
  }
  return best ? best.from : null;
}

// #393 / ADR-151 (+): rewrite a `:::table` block's alignment by setting/dropping its `{align=…}`
// directive attribute. LEFT is the default → the attribute is DROPPED, so an untagged block stays
// untagged; center and right are written out. One offset-invariant replace of the OPENING fence line;
// other attributes on the line are preserved verbatim (serializeDirectiveAttrs round-trips the map).
export function setTableAlign(view: EditorView, pos: number, align: FenceAlign): void {
  const from = tableDirectiveAt(view.state, pos);
  // #393a GFM PIPE table has nowhere to put the attribute, so aligning one PROMOTES it to
  // `:::table{align=…}` with an HTML body — one offset-invariant replacement of the whole block.
  // Asking for `left` is a no-op there: a pipe table already IS the default, and promoting it would
  // trade the plainest possible Markdown for nothing (Open formats).
  if (from == null) {
    if (align === "left") return;
    const blk = tableBlockAt(view.state, pos);
    if (!blk || blk.tier !== "pipe") return;
    const insert = `${tableFence(align as TableAlign)}\n${toHtml(blk.grid)}\n:::`;
    view.dispatch({ changes: { from: blk.from, to: blk.to, insert }, userEvent: "input" });
    return;
  }
  // …and back: returning a promoted table to the default writes plain pipes again whenever the grid
  // can express itself that way, so a round-trip through the align control leaves standard Markdown
  // rather than an attribute-less :::table wrapper.
  if (align === "left") {
    const blk = tableBlockAt(view.state, pos);
    if (blk && blk.tier === "html" && representableAsPipe(blk.grid)) {
      view.dispatch({ changes: { from: blk.from, to: blk.to, insert: toPipe(blk.grid) }, userEvent: "input" });
      return;
    }
  }
  const line = view.state.doc.lineAt(from);
  const open = parseDirectiveOpen(line.text);
  if (!open || open.name !== "table") return;
  const attrs: Record<string, string> = { ...(open.attrs ?? {}) };
  if (align === "left") delete attrs.align;
  else attrs.align = align; // fixed enum — never a free-form value (XSS boundary: enum → class switch)
  const label = open.label ? `[${open.label}]` : "";
  const next = `${":".repeat(open.colons)}table${label}${serializeDirectiveAttrs(Object.keys(attrs).length ? attrs : undefined)}`;
  if (next === line.text) return;
  view.dispatch({ changes: { from: line.from, to: line.to, insert: next }, userEvent: "input" });
}
// #255: align glyphs (three stacked bars, justified per side) — trusted constant SVGs (no user input).
const ALIGN_ICON: Record<FenceAlign, string> = {
  left: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h13M3 12h18M3 18h13"/></svg>',
  center: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6h12M3 12h18M6 18h12"/></svg>',
  right: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 6h13M3 12h18M8 18h13"/></svg>',
};

// #255a 3-button SEGMENTED align control (left | center | right) replacing the single cycling button.
// Each side is a distinct button; the active one is highlighted. mousedown picks that side directly (no
// cycle). Shared by the standalone-image widget and the diagram macro widget. `data-testid=macro-align` stays
// on the group so the existing hover/geometry tests keep resolving it. pick writes the `?align=` / `align=`.
function makeAlignSegment(current: FenceAlign, pick: (a: FenceAlign) => void): HTMLElement {
  const seg = document.createElement("div");
  seg.className = "cm-lp-macro-align cm-lp-align-seg";
  seg.setAttribute("data-testid", "macro-align");
  seg.setAttribute("data-align", current); // #255the live current align (read by handlers/tests)
  for (const a of ["left", "center", "right"] as const) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cm-lp-align-seg-btn";
    b.innerHTML = ALIGN_ICON[a];
    b.title = `Align ${a}`;
    b.setAttribute("data-testid", `macro-align-${a}`);
    b.setAttribute("data-align", a);
    b.setAttribute("aria-pressed", String(a === current));
    b.classList.toggle("cm-lp-align-seg-on", a === current);
    b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); pick(a); });
    seg.appendChild(b);
  }
  return seg;
}
// Update the segment's active side in place (updateDOM path — no rebuild, keeps the loaded img/SVG).
function updateAlignSegment(seg: HTMLElement, current: FenceAlign): void {
  seg.setAttribute("data-align", current);
  for (const b of Array.from(seg.querySelectorAll<HTMLButtonElement>(".cm-lp-align-seg-btn"))) {
    const on = b.getAttribute("data-align") === current;
    b.setAttribute("aria-pressed", String(on));
    b.classList.toggle("cm-lp-align-seg-on", on);
  }
}

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
  // #265: stop mousedown from bubbling to CM's content DOM (the same guard the raw nested-source textarea
  // below already uses). Without it, clicking into the island's body/label/type-chips reaches CM's mousedown
  // handler, which posAtCoords→moves the caret OUT of the container atom — clearing nestedEditActiveField
  // and tearing the island down the instant you click into it (reported as "the island opens but can't be
  // written to; the outer columns swallows the input"). Not preventDefault — the field still focuses
  // natively; keydown still reaches CM so Escape (escExit) can back out of the island.
  host.addEventListener("mousedown", (e) => e.stopPropagation());
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

// #278 §2a / ADR-122 (A): mount an inline CM6 island (the ADR-111 C3 source-editor primitive) INTO a layout
// SLOT cell, editing that column/tab's BODY (the lines between its fences) with the full editor (vim, undo,
// wrapping). Single Y.Text is preserved: the island holds its OWN document and commits via ONE offset-invariant
// Y.Text replace of the body range on BLUR — no second CRDT, no Y.Text sub-range live-binding (ADR-025 /
// ADR-017). vim follows the outer editor (vimEnabled facet). Escape bubbles to escExit which clears the field;
// mousedown is stopped so the outer container atom doesn't swallow the caret (#265). Returns true if mounted.
// The island EditorView is stashed on the host DOM so the widget's destroy(dom) can dispose it on EVERY unmount
// path (commit, Escape, caret-leave, rebuild) — not only the blur→onCommit path (the reviewer's leak finding).
//
// #278 rev4 (②③): the island IS a live-preview surface — the same livePreview field + theme as the
// host surface, mounted on the island's OWN state. The slot renders in place while only the caret's
// surroundings reveal syntax (the main-editor experience), instead of the earlier source-pane + separate
// preview stack (two renditions of the same content = the bounce). This changes DISPLAY
// only: the island still holds its own plain document and still commits on blur exactly as above.
type SlotHost = HTMLElement & { __slotHandle?: { destroy(): void } };

// ADR-122 addendum (b) / #278: the HOST supplies the shared live-preview decoration/keymap layer for
// nested markdown editors. mountLivePreview provides its buildLivePreviewExtensions closure here (the
// SAME factory — and the same opts/resolvers — its own surface is built from), so the slot island
// renders and edits EXACTLY like the page; collab/presence and host chrome are excluded by the factory
// itself (single Y.Text: the island never live-binds the page doc — it commits on blur). This facet is
// the seam that replaces the island's former hand-mirrored facet list (the config-drift source,).
// Null (no host factory — a bare test mount) → the island opens with no shared layer (plain text).
export type NestedLivePreviewEnv = { vim: boolean; displayMode: DisplayMode };
export const nestedLivePreviewConfig = Facet.define<(env: NestedLivePreviewEnv) => Extension, ((env: NestedLivePreviewEnv) => Extension) | null>({
  combine: (v) => (v.length ? v[v.length - 1]! : null),
});

// #278 rev4 (① +): the island's typography = the RENDERED surface's typography. Everything
// inherits from the page (16px proportional body, not the 13px code face the default source-editor theme
// uses for code-source macros), and there is NO fixed min-height — the box hugs its content (an empty
// island is still one text line tall, so it stays clickable). "Editing looks like the render" (north star 1).
//③: ZERO horizontal padding — the rendered slot's text has none, so any island padding shifted the
// text right the moment the island opened ("the look changes when I click"). The .cm-line default gutter
// (6px) is zeroed for the same reason; the box outline is drawn OUTSIDE layout (see the island CSS) so
// opening the editor never moves the text.
const slotIslandTheme = EditorView.theme({
  "&": { fontSize: "inherit", background: "transparent" },
  ".cm-content": { fontFamily: "inherit", padding: "0" },
  ".cm-line": { padding: "0" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit" },
  "&.cm-focused": { outline: "none" },
});

// #456 S1/S3: the host's side of the shared-surface seam. A macro asks for an editing surface and
// gets a handle; the surface itself is the same CM6 mount the slot islands use, built from the shared
// factory, so behaviour cannot drift per macro. The macro never receives the view.
function mountHostSurface(view: EditorView, opts: HostSurfaceOptions, collab?: { text: Y.Text; awareness: unknown }): HostSurfaceHandle {
  const factory = view.state.facet(nestedLivePreviewConfig);
  const markdown = opts.kind !== "code"; // default: the content is prose, so keep reading typography
  const handle = mountSourceEditor({
    parent: opts.parent,
    doc: opts.doc,
    dark: currentMacroTheme() === "dark",
    testid: opts.testid ?? "macro-surface",
    vim: view.state.facet(vimEnabled),
    // #502 / ADR-184: when the host has bound this surface to a shared EPHEMERAL Y.Text (co-occupied
    // island), pass it through so mountSourceEditor live-binds via yCollab; absent → the private-doc path.
    collab,
    // A prose surface gets the page's own decoration/keymap layer (reveal, vim-atom motion, nested
    // macro render, the slash palette). A code surface stays a plain source pane — the factory would
    // render markdown inside what is not markdown.
    extraExtensions: markdown && factory
      ? [factory({ vim: view.state.facet(vimEnabled), displayMode: view.state.facet(displayMode) === "wysiwyg" ? "wysiwyg" : "live" })]
      : [],
    ...(markdown ? { theme: slotIslandTheme } : {}),
    onInput: (v) => opts.onInput?.(asMacroSource(v)),
    onCommit: (v) => opts.onCommit?.(asMacroSource(v)),
  });
  return {
    getValue: () => asMacroSource(handle.getValue()),
    focus: () => handle.focus(),
    inVimInsert: () => handle.inVimInsert(),
    destroy: () => handle.destroy(),
  };
}

function mountSlotEditIsland(view: EditorView, cell: HTMLElement, container: { from: number; to: number }, index: number, childName: "column" | "tab", dark: boolean, bodyFrom: number): boolean {
  const doc = view.state.doc;
  const items = resolveDirectiveRanges(doc.toString()).filter((r) => r.name === childName && r.from >= container.from && r.to <= container.to);
  const it = items[index];
  if (!it) return false;
  // Body = the lines between the child's open fence and its closing fence. Captured once at mount; commit-on-blur
  // is the first write, so it stays valid.
  const first = doc.lineAt(it.from);
  const closeLine = doc.lineAt(Math.min(it.to, doc.length));
  const fb = first.number + 1, lb = closeLine.number - 1;
  const hasBody = lb >= fb && fb <= doc.lines;
  const bodyText = hasBody ? doc.sliceString(doc.line(fb).from, doc.line(lb).to) : "";
  // Commit target. For a slot with a body, REPLACE the body lines. For an EMPTY / adjacent-fence slot
  // (`:::column` immediately followed by `:::` — reachable via GFM paste/import), the naive body point is the
  // CLOSE-fence line start, so inserting text there would produce `hello:::` and destroy the fence (the
  // reviewer's round-trip finding). Instead insert AT THE END OF THE OPEN-FENCE LINE and add the surrounding
  // newlines, so an empty slot becomes `:::column\n<text>\n:::` (fence intact) and stays empty when cleared.
  const insFrom = hasBody ? doc.line(fb).from : first.to;
  const insTo = hasBody ? doc.line(lb).to : first.to;
  const shape = (v: string) => (hasBody ? v : v ? `\n${v}` : "");

  const host = document.createElement("div") as SlotHost;
  host.className = "cm-lp-slot-edit-island";
  host.setAttribute("data-testid", "slot-edit-island");
  host.addEventListener("mousedown", (e) => e.stopPropagation()); // #265: the outer atom must not steal the caret
  let committed = false;
  const commitNow = (value: string) => {
    if (committed) return; // blur / tab-switch / field-clear can race; write exactly once, never after destroy
    committed = true;
    // #278an unchanged body commits as a CLEAR-ONLY dispatch — writing identical text is still a
    // doc change (dirty flag, history step, collab traffic) for what the user experienced as "just leaving".
    const next = shape(value);
    if (next === view.state.doc.sliceString(insFrom, insTo)) {
      view.dispatch({ effects: setSlotEditActive.of(null) });
    } else {
      view.dispatch({ changes: { from: insFrom, to: insTo, insert: next }, effects: setSlotEditActive.of(null) });
    }
    view.focus();
  };
  // ADR-122 addendum (b): the island's decoration/keymap layer comes from the HOST's shared factory
  // the very buildLivePreviewExtensions the outer surface is built from (same resolvers/seams closure),
  // so reveal / vim-atom motion / WYSIWYG marker-hide / nested-macro render / the slash palette behave
  // exactly like the page. Collab/presence/host chrome are excluded by the factory (nested mount): the
  // island holds its OWN doc and commits on blur — never a second live Y.Text binding. This replaces the
  // hand-mirrored facet list (the config-drift sourcediagnosed). It reaches the macro-side helper
  // as opaque extensions — the ADR-023 sandbox boundary is unchanged (the §2b pattern).
  // displayMode: the island FOLLOWS the outer mode (①; #164: wysiwyg stays syntax-free). Reading
  // never reaches here (the click gate refuses) and Source containers never render widgets.
  const factory = view.state.facet(nestedLivePreviewConfig);
  const handle = mountSourceEditor({
    parent: host,
    doc: bodyText,
    dark,
    testid: "slot-edit-src",
    guardTeardownBlur: true, // #278an in-island editUI swap must not blur-commit the island closed
    vim: view.state.facet(vimEnabled),
    extraExtensions: factory
      ? [factory({ vim: view.state.facet(vimEnabled), displayMode: view.state.facet(displayMode) === "wysiwyg" ? "wysiwyg" : "live" })]
      : [],
    theme: slotIslandTheme, // rev4: body typography, not the code face — see slotIslandTheme
    onInput: () => {}, // rev4: the island renders itself (livePreview) — still NO doc write until blur
    onCommit: commitNow,
  });
  // #278commit at POINTERDOWN-capture when the pointer goes down OUTSIDE the island — before
  // CM's own mousedown creates a MouseSelection on the outer view. Committing later (on blur, mid-click)
  // shrinks the outer doc BETWEEN mousedown and mouseup, and CM's mouse selection then dispatches its
  // (pre-shrink) positions → "RangeError: Selection points outside of document". The tab BAR is exempt
  // the tab-switch capture handler (below) owns that commit and must record the clicked tab first.
  const onDocPointerDown = (e: PointerEvent) => {
    const t = e.target as HTMLElement | null;
    if (!t || host.contains(t)) return;
    const wrapEl = host.closest(".cm-lp-macro-wrap") as HTMLElement | null;
    // #278point 2: the tab-bar exemption narrows to NON-ACTIVE tabs (the tab-SWITCH path owns
    // that commit so it can record the clicked index first). A click on the ACTIVE tab is the RENAME
    // gesture (supersedes thekeep-editing ruling): commit here — BEFORE mousedown side effects,
    // the(b) RangeError lesson — and mount the rename on the REBUILT widget by container offset +
    // tab index. The mount cannot ride the browser's own mousedown: the commit shrinks the outer doc and
    // shifts the layout, so the follow-up compat mouse events would hit-test a displaced element (the
    // probe showed them landing on .cm-content). preventDefault suppresses them instead.
    const ownBarTab = t.closest(".cm-lp-tab") as HTMLElement | null;
    if (ownBarTab && wrapEl?.contains(ownBarTab)) {
      if (!ownBarTab.classList.contains("cm-lp-tab-active")) return;
      e.preventDefault();
      const startFrom = wrapEl.dataset.layoutFrom;
      const idx = Array.from(ownBarTab.parentElement?.querySelectorAll(".cm-lp-tab") ?? []).indexOf(ownBarTab);
      commitNow(handle.getValue());
      if (startFrom == null || idx < 0) return;
      setTimeout(() => {
        const nw = view.dom.querySelector(`[data-layout-from="${startFrom}"]`) as HTMLElement | null;
        const cellNew = nw?.querySelectorAll<HTMLElement>(".cm-lp-tab")[idx];
        if (nw && cellNew) startTabRename(view, nw, cellNew, idx);
      }, 0);
      return;
    }
    if (!ownBarTab && t.closest(".cm-lp-tabbar") && wrapEl?.contains(t)) return;
    commitNow(handle.getValue());
  };
  document.addEventListener("pointerdown", onDocPointerDown, true);
  // Disposed by MacroWidget.destroy(dom) on any unmount path. Marking `committed` on destroy also pins
  // the deferred tab-switch commit (below) against stale offsets: once the island is gone, no write.
  host.__slotHandle = { destroy: () => { committed = true; document.removeEventListener("pointerdown", onDocPointerDown, true); handle.destroy(); } };
  //②: the island's keys must NEVER reach the outer editor. The island DOM lives INSIDE the outer
  // contentDOM, so every keydown bubbled into the outer CM — whose vim (normal mode) treated island keys
  // as ITS OWN motions/edits: an island `o`/`e`/`w` moved the outer selection, which clears slotEditField
  // (macro-edit.ts: head outside the container → null) and unmounts the island mid-typing; the caret then
  // landed in the container widget's hidden doc range (the reported "o on the last line → caret vanished"
  // trace, reproduced in e2e via typing `newline` whose letters are all vim motions). Stop propagation at
  // the island boundary — bubble phase, so the island's own CM/vim has already handled the key.
  //
  // Escape is the ONE deliberate exception, and it is two-stage (the C3 handlesEscape pattern, inline)
  // the capture listener samples the vim mode BEFORE the island's vim consumes the key (after it, the
  // mode is already normal); an INSERT-mode Escape is then stopped too (insert→normal stays inside),
  // while a NORMAL-mode (or non-vim) Escape alone bubbles out to escExit and closes the island.
  let escWasInsert = false;
  host.addEventListener("keydown", (e) => { if (e.key === "Escape") escWasInsert = handle.inVimInsert(); }, true);
  host.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (escWasInsert) { escWasInsert = false; e.stopPropagation(); return; }
      // #278a normal-mode Escape is an EXIT, and every exit commits (the ADR-168 semantic the
      // click-out path already has). Letting the bare escExit clear the field first destroyed the island
      // with `committed = true` and the pending text was silently DISCARDED. Commit here, before the key
      // bubbles on to escExit (which then sees the field already cleared and does nothing).
      commitNow(handle.getValue());
      return;
    }
    e.stopPropagation();
  });
  cell.replaceWith(host); // for columns: the column cell; for tabs: the active panel
  // #278item 1 (island lifecycle): switching tabs is DISPLAY-ONLY (class toggles + tabActiveIndex),
  // so the island — bound to the OLD tab's body range — used to stay mounted: the preview showed the new
  // tab while the island still edited the old one. Commit+close on a tab switch: capture-phase on the tab
  // bar records the CLICKED tab (setActiveTabIndex — it can't rely on the button's own mousedown: with
  // native events, microtasks run between listeners, so a deferred commit rebuilt the widget BEFORE
  // activate ever ran) and commits synchronously — the rebuild then renders the NEW active tab with no
  // island; the old button's late activate is a no-op on detached DOM. The `committed` flag (set by
  // commitNow AND by destroy) keeps every other unmount path race-safe (never a stale-offset dispatch).
  // Clicking the edited tab's own header keeps editing; the `×` keeps its own doc-edit path.
  if (childName === "tab") {
    const bar = host.closest(".cm-lp-tabs")?.querySelector(".cm-lp-tabbar");
    bar?.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest(".cm-lp-tab-remove")) return;
      const btn = t.closest(".cm-lp-tab");
      if (!btn) return;
      const clicked = Array.from(bar.querySelectorAll(".cm-lp-tab")).indexOf(btn);
      if (clicked === index) return;
      setActiveTabIndex(bodyFrom, clicked); // the rebuild (below) restores the active tab from this
      commitNow(handle.getValue());
    }, true);
  }
  // Focus AFTER CM attaches this widget DOM to the document — focusing during toDOM (DOM not yet in the tree)
  // is a no-op, which left the island unfocused so a single click opened but couldn't type (reviewer B).
  requestAnimationFrame(() => handle.focus());
  return true;
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
  constructor(readonly macro: RenderableMacro, readonly body: string, readonly foldable: boolean, readonly name: string, readonly selected: boolean, readonly theme: MacroTheme, readonly from = 0, readonly to = 0, readonly bodyFrom = 0, readonly nestedSel: NestedSelection | null = null, readonly nestedEdit: NestedSelection | null = null, readonly align: FenceAlign = "center", readonly wysiwyg = false, readonly slotEdit: SlotEdit | null = null) {
    super();
  }
  private nestedKey(v: NestedSelection | null) { return v ? `${v.nested.from}:${v.nested.to}:${v.anchor}` : ""; }
  // #278 §2a: a STABLE key (container offsets + index) so the widget rebuilds ONLY when the edited slot
  // changes (mount / unmount the island) — never per-render churn (theeq-churn anti-test concern).
  private slotKey(v: SlotEdit | null) { return v ? `${v.container.from}:${v.container.to}:${v.index}` : ""; }
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
      && this.nestedKey(other.nestedSel) === this.nestedKey(this.nestedSel) && this.nestedKey(other.nestedEdit) === this.nestedKey(this.nestedEdit)
      && this.slotKey(other.slotEdit) === this.slotKey(this.slotEdit);
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = `cm-lp-macro-wrap ${ATOM_BOX_CLASS}`;
    // #395 / ADR-156 rule 2: an atom-class body never shows the text I-beam (cursor: default via CSS).
    if (ATOM_CLASS_MACROS.has(this.name)) wrap.classList.add("cm-lp-atom-body");
    // #255: a rendered DIAGRAM macro (mermaid/plantuml/excalidraw) is centred by DEFAULT (align="center")
    // and can be pushed left/right via the fence `align=` attribute. Only diagrams align (text macros
    // callout/table/columns — are unaffected). The class drives `text-align` on the wrap (below).
    // #455: only a RENDERED diagram centres/aligns — the EMPTY placeholder must be a full-width
    // block like every other macro's (the centre class shrank the dashed box to content width).
    if (DIAGRAM_MACROS.has(this.name) && this.body.trim() !== "") wrap.classList.add(`cm-lp-align-${this.align}`);
    // #393 / ADR-151 (+addendum): a `:::table{align=center|right}` aligns as a block; LEFT is
    // the default and adds no class, so an untagged table keeps plain flow layout. This used to
    // exclude `center` instead, which silently made "centre" mean "no class" — i.e. left.
    if (this.name === "table" && this.align !== "left") wrap.classList.add(`cm-lp-align-${this.align}`);
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
    if (this.body.trim() === "" && this.name !== "backlinks" && this.name !== "children") {
      // #307 / ADR-127: `:::backlinks` has an ALWAYS-empty body (its content is the host-resolved list, not
      // the source), so it must NOT take this generic "Empty macro" placeholder — it flows to the liveRender +
      // host-resolve path below (which renders the list, or collapses/placeholders when there are no backlinks).
      // #370`:::children` is the same shape (always-empty body, host-resolved list) and MUST take the
      // same exemption — without it this branch swallowed the widget as "Empty children" and the listSource
      // fetch below never fired (the review return: a parent with published children showed Empty).
      // `:::tagged` is NOT exempt: its body carries the tag name, so an empty body IS an unfinished macro.
      const ph = document.createElement("div");
      ph.className = "cm-lp-macro cm-lp-macro-empty";
      ph.setAttribute("data-testid", "macro-empty");
      // #174 / ADR-087: the empty-macro affordance matches how the macro is actually edited
      // "inline" macros (table/callout/mermaid) edit in place on click, "modal" ones (Excalidraw)
      // open a separate editor. editModeOf is the single source of truth for that branch.
      // #455: ONE localized pattern for every macro, and the text is now TRUE — the placeholder
      // click actually enters the macro (the empty branch previously advertised "click to edit"
      // while wiring nothing; the mousedown below routes through the same enterMacroAt as the
      // rendered branch / Ctrl+Enter). Display-only: readOnly surfaces no-op inside enterMacroAt.
      const opens = editModeOf(this.macro) === "modal";
      ph.textContent = i18n.t(opens ? "macro.emptyOpen" : "macro.emptyEdit", { name: this.name });
      // #455: no bespoke click wiring here — the SHARED entry affordances below (the ✎/Ctrl+↵
      // button row appended after this if/else, plus the keyboard Ctrl+Enter) already work on an
      // empty wrap (probe-verified: the button opens mermaid's editUI from the empty state). The
      // placeholder text now advertises exactly that entry (Ctrl+↵), instead of the old
      // "click to edit" that no code backed. (A widget-level click-to-enter was prototyped and
      // dropped: a cold-caret programmatic entry from the placeholder gets its selection re-synced
      // away by CM's DOM-selection observer — the button path is the reliable one.)
      wrap.appendChild(ph);
    } else {
      // #215 / ADR-100: for the layout containers, hand the inner-body base offset to the liveRender so its
      // nested macros tag themselves (data-mac-pos) for the hit-test. Consumed by columns/tabs liveRender;
      // reset immediately after so it never leaks to another macro's render.
      const isLayout = this.name === "columns" || this.name === "tabs";
      // #278point 2: a stable re-lookup key — the rename flow commits the island (the widget
      // rebuilds mid-capture), so the handler must find the FRESH wrap; the container's start offset
      // is unchanged by an in-slot commit (all edits land after it).
      if (isLayout) wrap.dataset.layoutFrom = String(this.from);
      if (isLayout) setPendingBaseOffset(this.bodyFrom);
      // #370thread the view's ListSource through the md-render seam so a `:::tagged`/`:::children`
      // NESTED in this container resolves (same view-filtered fetch as the top level — no new authz path).
      const rendered = withListHost(view.state.facet(listSource), () => this.macro.liveRender(this.body, { theme: this.theme })); // #200: the widget's built theme (eq() rebuilds on a switch), not a live DOM read
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
            edit.className = "cm-lp-macro-edit cm-lp-macro-edit-hint cm-lp-nested-macro-edit";
            edit.title = "Edit (Ctrl+Enter)";
            edit.innerHTML = MACRO_EDIT_BUTTON_HTML; // #424: the uniform face (the macro IS selected here, so Ctrl+↵ works directly)
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
            edit.className = "cm-lp-macro-edit cm-lp-macro-edit-hint cm-lp-nested-macro-edit cm-lp-nested-macro-edit-hover";
            edit.title = "Edit (Ctrl+Enter)";
            // #424 (user ruling, supersedes thebare-pencil rule): ONE face for every entry button
            // icon + Ctrl+↵ — even where the key needs the macro selected first; uniformity beats the nuance.
            edit.innerHTML = MACRO_EDIT_BUTTON_HTML;
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
        void renderDiagram(this.name, this.body, this.theme).then((blob) => {
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
            appendMarkdownInto(rendered, content); // sanitized DOM (no innerHTML); .wks-prose (#381)
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
      // #370 / ADR-145: host-mediated `:::tagged` / `:::children`. The macro can't fetch (narrow host-API);
      // the host resolves the VIEWER-authorized list and the widget renders it — or, when EMPTY, renders
      // NOTHING per surface: on a read surface (view / Reading / readOnly) the widget collapses to zero
      // height; on the EDIT surface it keeps a dim one-line placeholder so the author can still see, select
      // and delete the atom they inserted (a 0-height atom is mouse-unreachable). Loading shows nothing (no
      // skeleton). The host resolver is MEMBER-ONLY (absent on anonymous/template surfaces — those render the
      // baked anonymous snapshot server-side). Height changes as the async result lands → view.requestMeasure
      // so CM's block ResizeObserver reflows (block-widget motion rule).
      if (this.name === "tagged" || this.name === "children") {
        const listName = this.name;
        const src = view.state.facet(listSource);
        if (src) {
          const editable = !view.state.readOnly;
          const renderResult = (items: { id: string; title: string }[] | null) => {
            if (this.destroyed) return;
            rendered.replaceChildren();
            if (!items || items.length === 0) {
              if (editable) {
                const ph = document.createElement("div");
                ph.className = "cm-lp-backlinks-empty";
                ph.setAttribute("data-testid", `macro-${listName}-empty`);
                ph.textContent = src.emptyLabel;
                rendered.appendChild(ph);
              } else {
                wrap.style.display = "none"; // read surface: render nothing (collapse to zero height)
              }
            } else {
              const label = directiveLabel(view.state.doc.lineAt(this.from).text, listName);
              rendered.appendChild(buildLinkList(items, label, src, listName));
            }
            view.requestMeasure();
          };
          // The raw body rides to the server (`tagged` = a tag name; `children` ignores it); anything
          // unresolvable is 0 results (never a parse error). A denied/absent host → null → nothing.
          void src.fetch(listName, this.body).then(renderResult);
        }
      }
    }
    if (!view.state.readOnly) {
      // ADR-087 (unified editUI model) / #84 comment 696: a body click SELECTS the atom (caret → ring);
      // the rich UI opens only via the ✎ edit button / Ctrl+Enter. A stray click must NOT launch an
      // editor — otherwise Excalidraw pops a modal on a mis-click AND the click swallows the grip so drag
      // can't start. This holds for macros with the unified editUI (mermaid/callout) and for modal macros
      // (Excalidraw). EXCEPTION: a legacy richEditUI macro (table via InnerEditHost, #154) keeps its
      // in-place click-to-edit — its cell-edit UX depends on the body click and is not an editUI atom yet.
      // #395 / ADR-156: gate on an ACTUAL inline rich editor (the :::table InnerEditHost, #154).
      // editModeOf defaults to "inline" for a macro with NO edit UI at all, so a zero-arg dynamic
      // block (:::children) hit this branch and a body click became EXPLICIT ENTRY (raw reveal with
      // nothing to type) instead of the atom selection its class demands.
      const clickEdits = !this.macro.editUI && this.macro.richEditUI?.present === "inline"; // table (#154) only
      const isLayout = this.name === "columns" || this.name === "tabs";
      wrap.addEventListener("mousedown", (e) => {
        e.preventDefault();
        // #255 / #243: a RIGHT-click (or middle) opens the context menu (diagram alignment etc.) and must
        // NOT move the caret into the macro. With the #243 caret-in reveal, dropping the caret into a
        // mermaid/plantuml fence would reveal its raw source and REMOVE the rendered widget before the
        // context menu can act on it. Leave the caret put on any non-left button so the menu opens on the
        // still-rendered widget (preventDefault above already stops CM's own caret placement).
        if (e.button !== 0) return;
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
      // #255 comment 1040: the top-left action buttons (✎ edit, ⬍ align) live in ONE flex row instead of
      // fixed `left` offsets. The #174 "Ctrl+↵" hint widens the ✎ past the old 1.7em magic number, so the
      // align toggle overlapped it. A flex row auto-spaces them regardless of each button's width and needs
      // no re-tuning as buttons come and go. Retarget (embeds) is a separate top-right control, unaffected.
      const btnRow = document.createElement("div");
      btnRow.className = "cm-lp-macro-btnrow";
      wrap.appendChild(btnRow);
      // #395①: an ATOM with NO edit UI (children / backlinks — zero-arg dynamic blocks) had a ring
      // but NO visible Ctrl+↵ entry affordance (the raw pill only reveals on raw-zone hover, which a
      // rendered atom never has) — the ADR-156 "ring + entry pill" pair was half-missing. Give those
      // macros the SAME faced button (inherits the hover/atom-sel visibility gating at the btnrow CSS);
      // the press routes through enterMacroCommand = exactly what Ctrl+Enter does on this atom.
      if (!hasEditUI(this.macro) && !nestedActive) {
        const entry = document.createElement("button");
        entry.type = "button";
        entry.className = "cm-lp-macro-edit cm-lp-macro-edit-hint";
        entry.title = "Edit (Ctrl+Enter)";
        entry.innerHTML = MACRO_EDIT_BUTTON_HTML;
        entry.setAttribute("data-testid", "macro-entry-pill");
        entry.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(wrap)) }); // park ON the atom first
          enterMacroCommand(view); // the Ctrl+Enter action (retarget picker / raw reveal, per macro class)
        });
        btnRow.appendChild(entry);
      }
      if (hasEditUI(this.macro) && !nestedActive) {
        const edit = document.createElement("button");
        edit.type = "button";
        // #424 (user ruling, supersedes therichEditUI-only hint rule): EVERY entry button wears the
        // same face — icon + visible Ctrl+↵ — whether the press opens an editUI, a richEditUI modal, or a
        // raw reveal; what it opens stays per-macro. Hover/selection gating unchanged (#254: edit-hint is
        // layout-only, never the always-visible richui-raw class).
        edit.className = "cm-lp-macro-edit cm-lp-macro-edit-hint";
        edit.title = "Edit (Ctrl+Enter)";
        edit.innerHTML = MACRO_EDIT_BUTTON_HTML;
        edit.setAttribute("data-testid", "macro-edit");
        edit.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          enterMacroAt(view, view.posAtDOM(wrap));
        });
        btnRow.appendChild(edit);
      }
      // #255: a rendered DIAGRAM macro gets an ALIGN toggle just right of the ✎ — one click cycles
      // center → left → right, rewriting the fence `align=` attribute (center drops the attr). Same
      // hover/selection gating as ✎ (CSS). Suppressed while a nested macro is selected (no diagram nests
      // in a layout child in v1, but keep the single-pencil rule). Right-click also offers align (below).
      if (DIAGRAM_MACROS.has(this.name) && !nestedActive) {
        // #255the 3-button segmented align control (writes the diagram fence's `align=` attribute).
        btnRow.appendChild(makeAlignSegment(this.align, (a) => setDiagramAlign(view, view.posAtDOM(wrap), a)));
      }
      // #393 / ADR-151: the SAME segmented align control on a `:::table` block — writes/drops the
      // directive's `{align=…}` attribute (center = attribute-less, the fence-info convention). The
      // right-click menu offers the same three entries (context-menu.ts).
      if (this.name === "table" && !nestedActive) {
        btnRow.appendChild(makeAlignSegment(this.align, (a) => setTableAlign(view, view.posAtDOM(wrap), a)));
      }
      // #278 §1: columns/tabs structure ops are now PER-ITEM inline affordances on the rendered cells (retiring
      // the #213 bottom-right +/− bar and the #257 panel's +/− buttons): each column/tab shows a hover `×`
      // (remove THAT item — not just the last) and a trailing `` adds one. Editor surface only (added here, in
      // the widget's !readOnly path — never in the read-only view / the panel preview, which use liveRender
      // directly). Real Y.Text edits (removeLayoutItemAt / addLayoutItem); reorder-by-drag is a fast follow.
      // #278E part 1: the (add-item) renders WHENEVER the container is editable — NOT gated on
      // !nestedActive. It is a flex child of the row/tabbar, so skipping it when a nested macro is selected
      // removed it and REFLOWED the columns (a measured 315→336px jump on clicking a nested callout). Rendering
      // it unconditionally keeps the flex width constant; the × / slot-open click handlers stay nested-gated
      // below (structure ops are suppressed while editing a nested macro, but the width must not move).
      if ((this.name === "columns" || this.name === "tabs") && !view.state.readOnly) {
        const child = this.name === "columns" ? "column" : "tab";
        const add = document.createElement("button");
        add.type = "button";
        add.className = "cm-lp-layout-item-add";
        add.textContent = "＋";
        add.title = `Add ${child}`;
        add.setAttribute("data-testid", `layout-add-${child}`);
        // #278(E continued): the renders in the slot-edit state too — dropping it there
        // reflowed the columns the moment an island opened (the same 315→336px jump). The ACTION stays
        // gated: an outer structure edit mid-island would invalidate the island's captured commit offsets,
        // so while a slot is being edited the is visually present but inert.
        add.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); if (view.state.readOnly || view.state.field(slotEditField, false)) return; addLayoutItem(view, view.posAtDOM(wrap), child); });
        (this.name === "columns" ? wrap.querySelector(".cm-lp-columns") : wrap.querySelector(".cm-lp-tabbar"))?.appendChild(add);
      }
      // #278B4: NOT gated on !nestedActive — the × used to vanish the moment a nested macro was
      // selected (the "tab × disappears" repro: select the tab's mermaid → × gone), reflowing the corner.
      // Render the affordances whenever the container is editable; actions stay gated at CLICK time.
      if ((this.name === "columns" || this.name === "tabs") && !view.state.readOnly) {
        const child = this.name === "columns" ? "column" : "tab";
        const contentSel = this.name === "columns" ? ".cm-lp-column" : ".cm-lp-tabpanel";
        // #278B4 (part 2): the ×/rename affordances render in EVERY editable state — the slot-edit
        // branch used to skip them, so opening an island still made the tab × vanish (the same reflow the
        // !nestedActive gate caused). For columns the edited CELL is replaced by the island right below, so
        // its × simply leaves with it; the tab buttons (and other columns) keep theirs.
        {
        const cells = wrap.querySelectorAll<HTMLElement>(this.name === "columns" ? ".cm-lp-column" : ".cm-lp-tab");
        cells.forEach((cell: HTMLElement, i: number) => {
          // A span (not a button): the tab `×` nests inside a <button> tab, and a button-in-button is invalid.
          // The `×` glyph comes from CSS ::before, NOT textContent, so it does NOT pollute the tab/column text
          // (e.g. a tab's label stays "T1", not "T1×").
          const x = document.createElement("span");
          x.setAttribute("role", "button");
          x.className = this.name === "columns" ? "cm-lp-layout-item-remove" : "cm-lp-tab-remove";
          x.setAttribute("aria-label", `Remove ${child}`);
          x.title = `Remove ${child}`;
          x.setAttribute("data-testid", `layout-remove-${child}`);
          // stopPropagation so removing doesn't also select the atom / switch the tab; preventDefault keeps focus.
          //①: gate at CLICK time — the widget DOM (and these listeners) can be REUSED across a
          // display-mode switch, so a listener attached in Live survives into Reading; Reading must not
          // structure-edit (readOnly covers it — checked live, not at build).
          // #278inert while a slot island is open (same reason as the — an outer structure edit
          // would invalidate the island's captured commit offsets); visible so the corner never reflows.
          x.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); if (view.state.readOnly || view.state.field(slotEditField, false)) return; removeLayoutItemAt(view, view.posAtDOM(wrap), child, i); });
          if (this.name === "columns") cell.style.position = "relative"; // the × is absolutely placed in the cell
          cell.appendChild(x);
          // #278A2: clicking the ALREADY-ACTIVE tab again renames it inline (edits `:::tab[label]`).
          // CAPTURE phase so the active-state check runs BEFORE the tab button's own activate flips the
          // classes (bubble) — otherwise every tab click would look "already active" by the time we check.
          if (this.name === "tabs") {
            cell.addEventListener("mousedown", (e) => {
              if (e.button !== 0 || view.state.readOnly) return;
              if ((e.target as HTMLElement).closest(".cm-lp-tab-remove, .cm-lp-tab-rename-input")) return;
              if (!cell.classList.contains("cm-lp-tab-active")) return; // first click = switch (bubble handler)
              e.preventDefault();
              e.stopImmediatePropagation(); // a re-click must not re-run activate / the island tab-switch commit
              // #278point 2: this only ever fires with NO island open in this container — an
              // active-tab pointerdown with an island open is handled (commit + deferred rename mount)
              // by the island's document-capture handler, which preventDefaults the compat mousedown.
              startTabRename(view, wrap, cell, i);
            }, true);
          }
        });
        if (this.slotEdit) {
          // #278 §2a: a slot is being edited → swap its cell for the inline CM6 island. Mark the host so
          // updateDOM rebuilds (toDOM) when slot-edit toggles (else the DOM is reused + the island never
          // mounts/unmounts — the same reason nested-host forces a rebuild). No slot-open listeners on the
          // OTHER cells in this state: a preventDefault'd open would skip the island's blur→commit and lose
          // the edit; the plain flow (blur commits, then the next click opens) stays the safe path.
          wrap.classList.add("cm-lp-slot-edit-host");
          const slotCell = wrap.querySelectorAll<HTMLElement>(contentSel)[this.slotEdit.index];
          if (slotCell) mountSlotEditIsland(view, slotCell, { from: this.from, to: this.to }, this.slotEdit.index, child, this.theme === "dark", this.bodyFrom);
        } else {
        // (#278E part 1: the is rendered above, unconditionally, so a nested-select doesn't reflow.)
        // #278 §2a: clicking a slot's CONTENT enters inline edit for THAT slot (the CM6 island). Ignore clicks
        // on the ×/add/tab-button (those have their own actions); for tabs only the ACTIVE panel is
        // visible, so this naturally targets the active tab only. Captured `from`/`to` = this container.
        // #278A1 (user ruling): a nested macro (`[data-mac-pos]`) is NO LONGER an ignore — ONE click
        // anywhere in the slot (a nested warning included) enters the slot's edit mode, matching how an empty
        // slot already behaves. Until entered, nested macros are not directly touchable; INSIDE the island
        // they get the full top-level behaviour (reveal, pill, ✎/align, editUI) from the shared factory.
        const from = this.from, to = this.to;
        wrap.querySelectorAll<HTMLElement>(contentSel).forEach((slot: HTMLElement, i: number) => {
          slot.addEventListener("mousedown", (e) => {
            if ((e.target as HTMLElement).closest(".cm-lp-layout-item-remove, .cm-lp-tab-remove, .cm-lp-layout-item-add, .cm-lp-tab")) return;
            //①: the display-mode gate lives at CLICK time, not build time — the widget DOM (with
            // this listener) is reused across a display-mode switch, so a listener attached in Live
            // survives into Reading. Reading is a reading surface (#166/#314: no body editing; the task
            // checkboxes keep working inside the widget) → never open the island there; readOnly
            // likewise (Reading sets it, and a truly read-only surface must not edit either).
            if (view.state.readOnly || view.state.facet(displayMode) === "reading") return;
            e.preventDefault();
            e.stopPropagation();
            // Do NOT view.focus here — the rebuild mounts the island and focuses IT; focusing the outer view
            // would steal focus back (a single click must open AND focus the island). #278 §2a reviewer B.
            view.dispatch({ effects: setSlotEditActive.of({ container: { from, to }, index: i }) });
          });
        });
        }
        }
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
        retarget.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); changeEmbedTarget(view, () => view.posAtDOM(wrap), this.name); });
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
    // #278 §2a: a slot-edit toggle must rebuild (toDOM) so the inline CM6 island mounts / unmounts — the DOM
    // content identity (__mwKey) is unchanged, so without this updateDOM would reuse the DOM and the island
    // would never appear.
    const slotNow = !!this.slotEdit;
    const slotBefore = dom.classList.contains("cm-lp-slot-edit-host");
    if (!prev || prev.body !== this.body || prev.theme !== this.theme || prev.name !== this.name || prev.foldable !== this.foldable || prev.wysiwyg !== this.wysiwyg || nestedNow || nestedBefore || slotNow || slotBefore) {
      return false; // content / theme / nested affordance / #174 wysiwyg nested-✎ / slot-edit changed → rebuild via toDOM
    }
    this.ro = (dom as MwDom).__mwRo; // adopt the live ResizeObserver so this instance's destroy() disconnects it
    this.objectUrl = (dom as MwDom).__mwObjUrl; // adopt any host-rendered blob url so destroy() revokes it
    dom.classList.toggle("cm-lp-atom-sel", this.selected); // selection ring only — the rendered content stays
    // #255an align-only change is applied IN PLACE (keep the rendered SVG/img) — rebuilding would
    // re-render mermaid / re-resolve the diagram async, collapsing its height → the doc shrinks → CM jumps.
    if (DIAGRAM_MACROS.has(this.name)) {
      // #455an EMPTY macro shows its placeholder full width, never nudged left or right
      // there is no diagram to align yet. toDOM guards for that; this in-place path did not, so
      // picking an alignment on an empty diagram (or emptying an aligned one) shoved the hint aside.
      const alignable = this.body.trim() !== "";
      for (const a of ["left", "center", "right"] as const) dom.classList.toggle(`cm-lp-align-${a}`, alignable && a === this.align);
      const seg = dom.querySelector<HTMLElement>(".cm-lp-align-seg"); // #255update the segment's active side
      if (seg) updateAlignSegment(seg, this.align);
      if (prev) prev.align = this.align;
    }
    // #393 / ADR-151 (+): table block-align changes apply in place too (sameno-rebuild
    // rule). Unlike diagrams the default (LEFT) carries no class, so every non-default side is toggled
    // here — listing only left/right was how a fresh centre pick left the DOM untouched.
    if (this.name === "table") {
      const alignable = this.body.trim() !== "" // #455same guard — an empty table's placeholder stays full width
      for (const a of ["center", "right"] as const) dom.classList.toggle(`cm-lp-align-${a}`, alignable && a === this.align);
      const seg = dom.querySelector<HTMLElement>(".cm-lp-align-seg");
      if (seg) updateAlignSegment(seg, this.align);
      if (prev) prev.align = this.align;
    }
    return true;
  }
  destroy(dom?: HTMLElement) {
    this.destroyed = true;
    if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = undefined; }
    this.ro?.disconnect();
    this.ro = undefined;
    // #278 §2a: dispose the inline slot-edit island's CM6 EditorView on ANY unmount (commit / Escape /
    // caret-leave / rebuild) — CM calls destroy(dom) when it removes the widget DOM. Without this the EditorView
    // (and its DOM listeners) leaked on the non-blur exit paths (reviewer finding A).
    const host = (dom as HTMLElement | undefined)?.querySelector?.(".cm-lp-slot-edit-island") as SlotHost | null;
    host?.__slotHandle?.destroy();
  }
  ignoreEvent() {
    // #265: do NOT blanket-ignore island events here — that would also swallow keydown, so the CM-level
    // escExit (Escape backs out of the nested island) would never fire. The island's caret-swallow bug is
    // fixed at the DOM edge instead (mountNestedEditIsland stops mousedown propagation), which keeps the
    // keyboard path — including Escape — reaching CM.
    return false; // clicks pass through so the cursor can enter → reveal raw
  }
}

// #90 / #337 details: a real open/close model with THREE states (the collapsed-only bar was issue 2)
// closed (caret away) → "▸ summary" bar only.
// open (caret away) → "▾ summary" bar + the body RENDERED (renderMarkdownToDom). Clicking the bar
// toggles open↔closed — DISPLAY-ONLY (no doc/offset/presence): a module-level Map
// keyed by the block anchor + an in-place DOM toggle, the SAME discipline as the tabs
// tabActiveIndex (no dispatch → no decoration rebuild → single Y.Text untouched).
// edit (caret-in) → the raw source reveals for editing (enterMacroAt via Ctrl+Enter / the hover ✎),
// unchanged. Clicking the bar NO LONGER enters raw (that was the "only 2 states" bug);
// editing is reached via the atom's Ctrl+Enter or the ✎ button, like the callout panel.
// The open state survives a widget rebuild (body edited) via detailsOpenState (keyed by the block start, which
// is stable across body edits) and no-change re-renders via CM's DOM reuse. Height settles after the body
// renders / on toggle → observeBlockResize + requestMeasure re-measure so lines below don't drift (#255/#282).
const detailsOpenState = new Map<number, boolean>();
class DetailsSummaryWidget extends WidgetType {
  private ro?: ResizeObserver;
  private destroyed = false;
  constructor(readonly summary: string, readonly body: string, readonly from: number) { super(); }
  eq(o: DetailsSummaryWidget) { return o.summary === this.summary && o.body === this.body; }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = `cm-lp-details-collapsible ${ATOM_BOX_CLASS}`; // #337: a SINGLE enclosing box (border + radius); it grows
    wrap.setAttribute("data-testid", "macro-details");
    const isOpen = detailsOpenState.get(this.from) ?? false;
    wrap.classList.toggle("cm-lp-details-open", isOpen);
    const bar = document.createElement("div");
    bar.className = "cm-lp-details-summary";
    bar.setAttribute("data-testid", "details-summary-bar");
    const arrow = document.createElement("span");
    arrow.className = "cm-lp-details-arrow"; // one glyph; CSS rotates it 90° in the open state (no text swap)
    arrow.textContent = "▸";
    const label = document.createElement("span");
    label.className = "cm-lp-details-label";
    label.textContent = ` ${this.summary}`; // textContent — never innerHTML
    bar.append(arrow, label);
    // #337 point 2: the body lives in a grid wrapper whose single row animates 0fr↔1fr, so the WHOLE box grows
    // and shrinks as ONE container (not a separate quoted block appearing below). The inner body clips.
    const bodyWrap = document.createElement("div");
    bodyWrap.className = "cm-lp-details-bodywrap";
    bodyWrap.setAttribute("aria-hidden", String(!isOpen)); // collapsed body is out of the a11y tree (it's clipped, not display:none)
    // The grid child clips (overflow hidden, min-height 0) and carries NO padding — padding on the clipped
    // element would keep a residual height at 0fr; it lives on the inner block instead. #337 point 2.
    const bodyEl = document.createElement("div");
    bodyEl.className = "cm-lp-details-body";
    bodyEl.setAttribute("data-testid", "details-body");
    const bodyInner = document.createElement("div");
    bodyInner.className = "cm-lp-details-body-inner cm-lp-md-directive"; // padding + nested-block styling
    withListHost(view.state.facet(listSource), () => appendMarkdownInto(bodyInner, this.body)); // shared renderer, sanitized DOM; .wks-prose (#381); #370nested-list seam
    bodyEl.appendChild(bodyInner);
    bodyWrap.appendChild(bodyEl);
    wrap.append(bar, bodyWrap);
    // #337 point 1: the bar toggle is DISPLAY-ONLY (no doc / offset / presence change), so it must work on
    // EVERY surface — including the read-only view / Reading / guest panels (mountPublishedView is readOnly).
    // Only the ✎ raw-reveal edit entry stays gated on !readOnly (same split as #314's Reading task checkbox).
    bar.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const now = !(detailsOpenState.get(this.from) ?? false);
      detailsOpenState.set(this.from, now);
      wrap.classList.toggle("cm-lp-details-open", now);
      bodyWrap.setAttribute("aria-hidden", String(!now));
      // #359in WYSIWYG, ALSO park an empty caret on the block (mermaid parity) so a follow-up
      // Ctrl+C/Ctrl+X hits atomClipboard and takes the WHOLE `:::details…:::` source — the bar's
      // preventDefault otherwise leaves the caret elsewhere and the copy silently no-ops. WYSIWYG never
      // reveals on caret (syntaxRevealsAt), so the atom stays rendered; in Live a caret here WOULD flip
      // the panel to raw source, destroying the click-to-toggle affordance (#337), so Live keeps the
      // caret untouched (copy there goes through ✎ reveal or a cross-boundary selection).
      if (!view.state.readOnly && view.state.facet(displayMode) === "wysiwyg") {
        view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(wrap)) });
        view.focus();
      }
      view.requestMeasure(); // the ResizeObserver follows the transition; transitionend settles the final height
    });
    // #255/#282 block-widget rule: nail the final height at the END of the open/close animation so lines below
    // don't drift once the transition finishes (the continuous change is tracked by observeBlockResize).
    bodyWrap.addEventListener("transitionend", (e) => { if (e.propertyName === "grid-template-rows") view.requestMeasure(); });
    if (!view.state.readOnly) {
      // Edit entry (raw reveal): a hover ✎ button (mouse) + Ctrl+Enter (the atom is selected) — the callout
      // panel's affordance. stopPropagation so it doesn't also toggle the bar.
      wrap.classList.add("cm-lp-callout-panel-editable");
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "cm-lp-macro-edit cm-lp-macro-edit-hint cm-lp-callout-panel-edit";
      edit.title = "Edit (Ctrl+Enter)";
      edit.innerHTML = MACRO_EDIT_BUTTON_HTML;
      edit.setAttribute("data-testid", "details-edit");
      edit.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); enterMacroAt(view, view.posAtDOM(wrap)); view.focus(); });
      wrap.appendChild(edit);
    }
    this.ro = observeBlockResize(view, wrap);
    // Enable transitions only AFTER the first paint, so the initial mount / a rebuild (body edit) doesn't
    // animate the box — only a user toggle does.
    requestAnimationFrame(() => { if (!this.destroyed) wrap.classList.add("cm-lp-details-animated"); });
    return wrap;
  }
  destroy() { this.destroyed = true; this.ro?.disconnect(); this.ro = undefined; }
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
  constructor(readonly containerClass: string, readonly icon: string, readonly label: string, readonly body: string, readonly selected: boolean) { super(); }
  eq(o: CalloutWidget) {
    return o.containerClass === this.containerClass && o.icon === this.icon && o.label === this.label && o.body === this.body && o.selected === this.selected;
  }
  toDOM(view: EditorView) {
    const el = withListHost(view.state.facet(listSource), () => renderCalloutPanel(this.containerClass, this.icon, this.label, this.body)); // #370nested-list seam
    // #438the SHARED atom-selection ring — every other atom (mermaid/details/embeds) rings via
    // cm-lp-atom-sel; the callout panel was the one widget without it. Only ever visible where the
    // caret can rest ON the atom without revealing (WYSIWYG / atom-select contexts) — in Live a
    // caret-in reveals raw instead, so the click-to-edit path is untouched.
    if (this.selected) el.classList.add("cm-lp-atom-sel");
    if (!view.state.readOnly) {
      // #174 comment 878 (ADR-087 addendum 2): a click PLACES THE CARET (reveals raw `:::type[label]` + body),
      // it does NOT open the editUI panel directly (that was the reversed behaviour the reviewer rejected).
      // Same plain caret placement the pipe TableWidget uses; the RichUI is reached via the caret-in pill /
      // Ctrl+Enter (enterMacroAt), matching the table 4-quadrant model.
      // #278(2): park on the BODY line, not the head — a head-parked caret keeps the Ctrl+↵ pill
      // lit (macroRawHead) until the caret moves, which read as a stuck hint right after entry. The body
      // start is where typing continues anyway; the head rule stays for deliberate caret-on-head (vim).
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const pos = view.posAtDOM(el);
        const head = view.state.doc.lineAt(pos);
        view.dispatch({ selection: EditorSelection.cursor(Math.min(head.to + 1, view.state.doc.length)) });
        view.focus();
      });
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
      edit.innerHTML = MACRO_EDIT_BUTTON_HTML;
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
// #358: EXPLICIT entry (Ctrl+Enter / the ✎ pill → enterMacroAt → macroRenderActiveField) reveals the
// COVERED range in every EDITABLE mode — including WYSIWYG. #164's "wysiwyg never reveals" rule governs
// the AUTOMATIC caret-in reveal only (syntaxRevealsAt above, unchanged); without this split, every
// reveal-only macro (details, embed-page, standalone image/attachment, legacy source fences) had NO edit
// path at all in WYSIWYG (enterMacroAt dispatched the effect, but the reveal predicates ignored it).
// Containment (not overlap) so an active block never bleeds reveal into its neighbours; readOnly still
// never reveals (nothing to edit). Esc / caret-out clears the field (escExit) in every mode alike.
function explicitEntryCovers(state: EditorState, from: number, to: number): boolean {
  if (state.readOnly) return false;
  const a = state.field(macroRenderActiveField, false);
  return !!a && a.from <= from && a.to >= to;
}
function rangeRevealed(state: EditorState, from: number, to: number): boolean {
  if (explicitEntryCovers(state, from, to)) return true; // #358: explicit entry wins in every editable mode
  return syntaxRevealsAt(
    state.facet(displayMode),
    state.readOnly,
    state.selection.ranges.some((r) => r.from <= to && r.to >= from),
  );
}

// #359: like rangeRevealed, but reveal fires ONLY for an EMPTY CARET inside [from,to] — never for a NON-EMPTY
// selection overlapping it. Used at the BLOCK-MACRO atom sites (directiveRevealed + the collapsible/icon/nested
// block renders): a `v`/`V` visual selection dragged across a block widget must NOT flip its atom↔raw, because
// that churns `EditorView.atomicRanges` mid-selection and warps vim's visual head (the project design notes: vim cursor respects
// atomicRanges). Inline markers keep the overlap-based `rangeRevealed` (they are not atoms → no vim warp, and the
// on-selection reveal is the established format-toolbar/vim-decorate behaviour). For a single empty caret this is
// byte-identical to rangeRevealed, so only visual selections over BLOCK atoms change.
// #438: is this selection range LINEWISE — anchored at a line start and ending at a line start (or
// EOF)? vim operators (dd / dj / yy / V) materialise a TRANSIENT linewise selection before acting; a
// mouse/charwise drag virtually never is. Used to keep operator selections from flipping a block's
// reveal state mid-operator (below).
function isLinewiseRange(state: EditorState, r: { from: number; to: number }): boolean {
  if (state.doc.lineAt(r.from).from !== r.from) return false;
  return r.to === state.doc.length || state.doc.lineAt(r.to).from === r.to;
}

function blockRevealed(state: EditorState, from: number, to: number): boolean {
  if (explicitEntryCovers(state, from, to)) return true; // #358: explicit entry wins in every editable mode
  // #359(option B): an EMPTY caret inside [from,to] reveals (the editing entry), and so does a
  // NON-EMPTY selection FULLY CONTAINED in [from,to] — the writer is selecting revealed source to copy;
  // dropping the reveal the moment the drag/visual became non-empty (the first #359 fix) made the raw
  // snap back to an atom mid-selection, so a sub-range of a mermaid/details source could not be copied.
  // A selection CROSSING the block's boundary still never reveals: that is exactly the #359 vim-warp
  // case (atom↔raw churn moves EditorView.atomicRanges under the moving visual head).
  // #438: EXCEPT a LINEWISE contained selection. vim's dd/yy/dj materialise a transient linewise
  // selection before operating; under the unconditional form that selection kept the block revealed
  // mid-operator, so dd deleted ONE raw line of a frontmatter block instead of the whole unit. With
  // linewise selections excluded the block collapses for that instant and CM's atomicRanges extend the
  // operator's deletion over the whole atom — the pre-#359 dd-takes-the-block behaviour. The
  // select-to-copy flow (a charwise drag inside revealed source) is untouched; a deliberate vim `V`
  // inside revealed source now selects the collapsed atom, which is coherent linewise-vim semantics.
  //
  // #359for a non-empty selection the test is on the ANCHOR, not on containment of the whole
  // range. Containment flipped the moment a GROWING selection crossed the block's edge — revealed→atom
  // (or atom→revealed) mid-drag — and that flip is exactly the atomicRanges churn this function exists
  // to avoid: the raw offsets the selection was built on fold away, so the selection dies or the vim
  // head warps. The anchor cannot move while the head does, so keying on it FREEZES each block's
  // reveal for the whole life of the selection: start outside and the block stays an atom as you grow
  // over it; start inside revealed source and it stays raw as you grow out. Contained selections are
  // unaffected (a contained range's anchor is inside it), so thecopy flow is byte-identical.
  // The #438 linewise exclusion keeps its ORIGINAL scope — a CONTAINED linewise range, which is the
  // shape an operator materialises. Left unscoped it also swallowed growing charwise selections that
  // merely happen to be line-aligned at both ends (thej-intercept lands the head exactly on an
  // atom's first line), collapsing the anchor block mid-growth — the very bug above, wearing a hat.
  const containedLinewise = (r: { from: number; to: number }) => r.from >= from && r.to <= to && isLinewiseRange(state, r);
  return syntaxRevealsAt(
    state.facet(displayMode),
    state.readOnly,
    state.selection.ranges.some((r) => (r.empty ? r.head >= from && r.head <= to : r.anchor >= from && r.anchor <= to && !containedLinewise(r))),
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
// #332: whether a directive block should show its RAW source right now. Identical to `rangeRevealed`
// for every macro EXCEPT an `atomSelectable` one (embed-page): there an empty caret resting on the block
// SELECTS the atom (the widget stays rendered — the image-atom model), and the raw reveals only on
// EXPLICIT entry (Ctrl+Enter sets macroRenderActiveField over the block) or a NON-empty selection. This
// is the single source of truth the three reveal sites (widget render + the two fence-hide passes) share
// so the widget and its `:::` fences never disagree (one rendered, one raw). Source mode is handled
// upstream (isSourceMode short-circuits before any widget renders), so it is not re-checked here.
function directiveRevealed(state: EditorState, name: string, from: number, to: number): boolean {
  const macro = findDirectiveMacro(name);
  if (macro?.revealOnCursor && macro.atomSelectable) {
    const active = state.field(macroRenderActiveField, false);
    if (active && active.from <= from && active.to >= to) return true; // Ctrl+Enter / explicit entry
    return blockRevealed(state, from, to) && !atomSelected(state, from, to); // #359: empty-caret only (no visual-selection de-atom)
  }
  return blockRevealed(state, from, to); // #359: a directive BLOCK reveals on an empty caret, not a visual selection
}

// #332is `pos` inside a directive block that is an `atomSelectable` atom currently SELECTED (an empty
// caret resting on it → the atom-selection ring shows and the widget stays rendered, per directiveRevealed)?
// There the vim fat cursor must be suppressed ENTIRELY (the full-card ring is the only selection affordance)
// unlike a plain block atom (table cell / `:::` fence) where the fat cursor stays a position marker. Gated by
// the caller to the empty-caret / vim-normal / non-source / on-a-block case, so the full-doc scan is rare.
export function atomSelectableSelectedAt(state: EditorState, pos: number): boolean {
  if (state.readOnly) return false;
  for (const dir of resolveDirectiveRanges(state.doc.toString())) {
    if (pos < dir.from || pos > dir.to) continue;
    const macro = findDirectiveMacro(dir.name);
    if (macro?.revealOnCursor && macro.atomSelectable && atomSelected(state, dir.from, dir.to) && !directiveRevealed(state, dir.name, dir.from, dir.to)) return true;
  }
  return false;
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
  // #335the document-scoped footnote aggregation, computed ONCE per build and non-null ONLY on a
  // READ-ONLY surface (Reading / template preview). When set, the footnote renderers switch to aggregate mode
  // (numbered jump-refs + hidden def lines + an end-of-document section); null keeps the in-place edit rendering.
  readonly footnotes: DocFootnotes | null;
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
  // #334 / ADR-129: highlight — style the run, hide the `==` delimiters (reveal on the cursor line).
  { match: (n) => n === "Highlight", enter: (node, ctx) => ctx.add(highlightMark, node.from, node.to) },
  { match: (n) => n === "HighlightMark", enter: (node, ctx) => ctx.hideMarker(node.from, node.to) },
  // #335 / ADR-130: footnote reference `[^label]`. READ surface (ctx.footnotes,): replace it with a
  // numbered superscript that jumps to the end-section (aggregated view). EDIT surface: style the run as a
  // superscript and hide the `[^`/`]` (reveal-on-cursor, like highlight's `==`), keeping the source editable.
  {
    match: (n) => n === "FootnoteRef",
    enter: (node, ctx) => {
      if (ctx.footnotes) {
        const label = footnoteRefLabelD(ctx.state.doc.sliceString(node.from, node.to));
        ctx.add(Decoration.replace({ widget: new FootnoteRefWidget(ctx.footnotes.numbers.get(label) ?? null) }), node.from, node.to);
        return;
      }
      ctx.add(footnoteRefMark, node.from, node.to);
      ctx.hideMarker(node.from, node.from + 2); // `[^`
      ctx.hideMarker(node.to - 1, node.to); // `]`
    },
  },
  // #335 / ADR-130: footnote definition line `[^label]: body`. READ surface: HIDE the line entirely
  // it is aggregated into the end-of-document section. EDIT surface: a muted line style; the source stays
  // visible and editable in place.
  { match: (n) => n === "FootnoteDef", enter: (node, ctx) => {
    if (ctx.footnotes) {
      const line = ctx.state.doc.lineAt(node.from);
      const to = Math.min(line.to + 1, ctx.state.doc.length); // include the trailing newline so the line fully collapses
      if (to > line.from) ctx.add(Decoration.replace({ block: true }), line.from, to);
      return false; // the line is block-hidden — skip its inline children (like every other block-replace)
    }
    ctx.add(footnoteDefLine, ctx.state.doc.lineAt(node.from).from);
  } },
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
        // editor (EditableEditUIWidget). mermaid + plantuml declare editUI: inline (#239).
        // #243 / ADR-111 C4: an EXPLICIT enter (Ctrl+Enter via enterMacroCommand OR the ✎ button — both set
        // macroRenderActive) opens the rich editUI, unified across modes exactly like a callout's Ctrl+Enter/✎.
        // The old `!active.raw` guard (which made Ctrl+Enter reveal RAW instead) is dropped — raw is now reached
        // by the bare caret-in reveal below (C1), not an explicit command. So both entry keys land here.
        if (macro.editUI?.present === "inline" && active && active.from <= from && active.to >= to && !ctx.state.readOnly) {
          ctx.addAtomic(Decoration.replace({ widget: new EditableEditUIWidget(from, to, fenceBody(doc, node.from, node.to), macro.editUI, (b) => "```" + lang + "\n" + b + "\n```", ctx.macroTheme, macro.tier, true), block: true }), from, to);
          return;
        }
        if (active && !macro.richEditUI && active.from <= from && active.to >= to) return; // entered → source
        // #243 / ADR-111 C1: a TEXT fence diagram macro (mermaid / plantuml — editUI present "inline") joins
        // the callout reveal class. A caret INSIDE reveals the raw source (editable — vim / slash-completion)
        // instead of the rendered atom, PLUS the shared RichUI-entry pill (✎ / Ctrl+↵ → the editUI). Live +
        // editable only: rangeRevealed is false in WYSIWYG / Reading (C2 keeps the atom) and Source already
        // returned above. Excalidraw (editUI present "modal") is excluded → it stays an atom (modal on enter).
        // The bare caret reveals raw; the pill / Ctrl+Enter (active.raw, handled above) reach source / editUI.
        if (macro.editUI?.present === "inline" && !ctx.state.readOnly && blockRevealed(ctx.state, from, to)) {
          addRawPillContext(ctx, from, to);
          ctx.add(Decoration.widget({ widget: new MacroRawRichuiPill(from, enterMacroAt, "fence-richui-enter"), side: -1 }), from);
          return; // raw source shows (no widget) — the fence lines stay editable markdown
        }
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
        if (macro.richEditUI?.present === "inline" && active && !active.raw && active.from <= from && active.to >= to && !ctx.state.readOnly) {
          // #502 floor: `active.raw` (a peer co-edits → enterMacroAt forced the SOURCE reveal) falls THROUGH
          // to the raw `:::table` source below (canonical, yCollab-merged) instead of the clobbering grid
          // the same `!active.raw` guard the callout editUI uses above (decorations.ts callout site).
          ctx.addAtomic(Decoration.replace({ widget: new EditableTableWidget(from, to, doc.sliceString(from, to)), block: true }), from, to);
          return false; // skip inner nodes — the inline editor owns the block
        }
        if (macro.revealOnCursor && directiveRevealed(ctx.state, open!.name, from, to)) {
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
        // #278 §2a: the inline slot-edit state that targets THIS container (null otherwise).
        const sef = ctx.state.field(slotEditField, false);
        const slotEdit = sef && sef.container.from === from ? sef : null;
        // #174 comment 1003: layout containers in WYSIWYG draw hover ✎ on their nested editable slots (below);
        // the flag is part of eq so a display-mode switch rebuilds the widget (eq ignores the live facet).
        const wysiwygNested = (open!.name === "columns" || open!.name === "tabs") && ctx.state.facet(displayMode) === "wysiwyg";
        // #393 / ADR-151 (+): `:::table{align=center|right}` block alignment (fixed enum off the
        // directive attrs). A table with no attribute — or any other value — is LEFT, its natural flow
        // default, and writes no class. Non-table macros keep the diagram default of centre.
        const dirAlign: FenceAlign = open!.name === "table"
          ? (open!.attrs?.align === "center" || open!.attrs?.align === "right" ? open!.attrs!.align as FenceAlign : "left")
          : "center";
        ctx.addAtomic(Decoration.replace({ widget: new MacroWidget({ liveRender: macro.liveRender, richEditUI: macro.richEditUI, editUI: macro.editUI }, parts.join("\n"), false, open!.name, atomSelected(ctx.state, from, to), ctx.macroTheme, from, to, bodyFrom, nestedSel, nestedEdit, dirAlign, wysiwygNested, slotEdit), block: true }), from, to);
        return macro.revealOnCursor ? false : undefined;
      }
      if (macro.collapsible) {
        // #425 / ADR-168: EXPLICIT entry (✎ / Ctrl+↵ → macroRenderActiveField) opens the PANEL editUI
        // never raw `:::` (Source mode is the documented raw path). Checked FIRST so the explicit-entry
        // reveal (blockRevealed's explicitEntryCovers) can't fall through to the raw container render.
        const dActive = ctx.state.field(macroRenderActiveField, false);
        if (macro.editUI?.present === "inline" && dActive && !dActive.raw && dActive.from <= first.from && dActive.to >= lastLine.to && !ctx.state.readOnly) {
          const blockSrc = doc.sliceString(first.from, lastLine.to);
          ctx.addAtomic(Decoration.replace({ widget: new EditableEditUIWidget(first.from, lastLine.to, blockSrc, macro.editUI, (b) => b, ctx.macroTheme, macro.tier), block: true }), first.from, lastLine.to);
          return false; // the inline editor owns the block
        }
        if (!blockRevealed(ctx.state, first.from, lastLine.to)) {
          // #90 details, collapsed: replace the whole block with a "▸ summary" bar (one widget →
          // no per-line decoration conflict). Skip children so the fences aren't double-processed.
          // A SELECTION-driven reveal still falls through to the raw container render below (#359
          // select-to-copy stays raw — the panel mounts on explicit entry only).
          const dBody: string[] = [];
          for (let n = first.number + 1; n < lastLine.number; n++) dBody.push(doc.line(n).text);
          ctx.addAtomic(Decoration.replace({ widget: new DetailsSummaryWidget(open!.label ?? "Details", dBody.join("\n"), first.from), block: true }), first.from, lastLine.to);
          return false;
        }
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
        if (macro.icon && !blockRevealed(ctx.state, first.from, lastLine.to)) {
          const bodyParts: string[] = [];
          for (let n = first.number + 1; n < lastLine.number; n++) bodyParts.push(doc.line(n).text);
          ctx.addAtomic(
            Decoration.replace({ widget: new CalloutWidget(macro.containerClass, macro.icon, open!.label ?? "", bodyParts.join("\n"), atomSelected(ctx.state, first.from, lastLine.to)), block: true }),
            first.from,
            lastLine.to,
          );
          return false; // skip children — the panel owns the block
        }
        // CONTAINER directive (callout, caret-in = raw / details revealed): a CSS box over every
        // line; content stays markdown (raw-editable under the cursor).
        //
        // #278point 1: an ICON'D callout reaches this branch ONLY while revealed (caret-in;
        // otherwise the panel widget above owns the block). Revealed = the writer is editing SOURCE,
        // so the source shows PLAIN — no tint box, no ::before icon/label header. Mixing the panel
        // skin with raw `:::` lines was the twice-rejected broken state (cm-lp-callout + cm-lp-macro-raw
        // on one line); the raw state is now "plain source + the entry pill", nothing else. Non-icon
        // containers (todo / details / plain boxes) keep their box — it IS their live rendering.
        if (!macro.icon) {
          const box = Decoration.line({ attributes: { class: macro.containerClass } });
          // The OPEN line renders a header when there is a leading [label] (#94) — via CSS
          // ::before(attr(data-label)), display-only (the `:::name[label]` text stays the hidden
          // source, reveal-on-cursor to edit). No widget, so it never fights the DirectiveMark hide.
          const openLine = open!.label
            ? Decoration.line({ attributes: {
                class: `${macro.containerClass} cm-lp-directive-label`,
                'data-label': open!.label ?? '',
              } })
            : box;
          ctx.add(openLine, first.from);
          for (let n = first.number + 1; n <= lastLine.number; n++) ctx.add(box, doc.line(n).from);
        }
        // #290 / ADR-114: a :::todo shows a progress ring in its header, computed from the block's own task
        // lines (the body between the fences). Display-only side:1 widget on the open line (offset-invariant);
        // absolutely positioned to the right by CSS. Only when there are tasks (0/0 → no ring).
        if (macro.name === "todo") {
          let bodyTxt = "";
          for (let n = first.number + 1; n < lastLine.number; n++) bodyTxt += doc.line(n).text + "\n";
          const { done, total } = countTasks(bodyTxt);
          if (total > 0) ctx.add(Decoration.widget({ widget: new TodoRingWidget(done, total), side: 1 }), first.to);
          // #290: a "remove ring" (demote) button in the header, editable surface only (hover-shown).
          if (!ctx.state.readOnly) ctx.add(Decoration.widget({ widget: new TodoDemoteWidget(first.from), side: 1 }), first.to);
          // #290(3): the block-centred list-checks icon (measured into place — see TodoIconWidget;
          // the open-line ::before icon is suppressed in callout-icons.css).
          ctx.add(Decoration.widget({ widget: new TodoIconWidget(lastLine.number - first.number + 1, done, total), side: 1 }), first.to);
          // #290(4): round the BOX like the callout panel — per-line boxes need explicit first/last
          // corner classes (the panel gets its radius on one element; see callout-icons.css for the values).
          ctx.add(Decoration.line({ attributes: { class: "cm-lp-todo-first" } }), first.from);
          ctx.add(Decoration.line({ attributes: { class: "cm-lp-todo-last" } }), lastLine.from);
        }
        // #174 comment 878 (ADR-087 addendum 2): caret-in raw editing → the SHARED RichUI-entry pill at the
        // top-left (the same affordance as the pipe table, #216). Live + editable only. Click / Ctrl+Enter →
        // enterMacroAt → the callout editUI (type/header/content). macroRawLead adds position:relative to the
        // open line so the pill anchors and floats just above it (never covering the raw `:::type` source).
        if (blockRevealed(ctx.state, first.from, lastLine.to) && ctx.state.facet(displayMode) === "live" && !ctx.state.readOnly) {
          addRawPillContext(ctx, first.from, lastLine.to);
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
    if (dir && directiveRevealed(ctx.state, dir.name, dir.from, dir.to) && !caretInNestedMacro(ctx.state, dir.from, dir.to)) return;
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
      // #300/#314: disabled iff there's no toggle control (no edit permission / no view handler). NOT
      // view.state.readOnly — the published VIEW surface is a read-only editor but its box must stay
      // live. Reading display mode does NOT disable it (#314): Reading blocks PROSE edits, but the task
      // toggle is an allowed read-surface operation (ADR-019), same as the published view surface.
      const disabled = !ctx.state.facet(checkboxControl);
      ctx.hideMarker(node.from, node.to, checkbox(checked, node.from, disabled));
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
      const src = ctx.state.doc.sliceString(node.from, node.to);
      // #273 / ADR-120: [name](wks-attachment:<id>) — the FILE attachment link. Never styled as a
      // clickable anchor (the scheme is opaque); rendered as a chip (inline) or a download card /
      // sandboxed PDF viewer (standalone atom, mirroring the standalone image). Raw source: the
      // inline chip reveals on caret landing like an inline image; the standalone card only via
      // explicit entry (Ctrl+Enter / the ✎ pill).
      const aRef = parseAttachmentLinkRef(src);
      if (aRef) {
        const line = ctx.state.doc.lineAt(node.from);
        if (line.text.trim() === src.trim()) {
          const active = ctx.state.field(macroRenderActiveField, false);
          if (active && active.from <= node.from && active.to >= node.to) return; // revealed → raw markdown
          ctx.addAtomic(
            Decoration.replace({ widget: new AttachmentCardWidget(aRef.id, aRef.name, atomSelected(ctx.state, node.from, node.to)), block: true }),
            node.from,
            node.to,
          );
          return;
        }
        if (lineRevealed(ctx.state, node.from)) return; // caret on the line → raw markdown
        ctx.addAtomic(Decoration.replace({ widget: new AttachmentChipWidget(aRef.id, aRef.name) }), node.from, node.to);
        return;
      }
      // #323a bare `[text]` shortcut with NO resolvable destination is literal CommonMark text
      // render it plain (no cm-lp-link), matching the reader (md-render makes a <span>, an <a> only for a
      // real href). Its `[ ]` markers stay visible (the LinkMark visitor below). Only `[text](url)` (a
      // resolvable href) gets the clickable link mark.
      const href = linkHref(src);
      if (!href) {
        // #323/a bare `[text]` is literal CommonMark text — but the SYNTAX HIGHLIGHTER tints the
        // Link node blue (tags.link), so the literal `[text]` reads as a link. Override it to the body colour so
        // it looks like plain text (reader parity). ALWAYS — colour should reflect the SEMANTICS (does this
        // actually render as a link?), not the tokenizer's guess: lezer makes a bare shortcut a Link node, but it
        // has no destination, so it's plain text whether revealed, caret-away, or in Source. A REAL `[text](url)`
        // (resolvable href) keeps its syntax colour on reveal/Source (falls through below).dropped the old
        // `!lineRevealed` gate that left it blue on the revealed line and in Source mode.
        ctx.add(Decoration.mark({ class: "cm-lp-link-plain" }), node.from, node.to);
        return;
      }
      ctx.add(Decoration.mark({ class: "cm-lp-link", attributes: { "data-href": href } }), node.from, node.to);
    },
  },
  { match: (n) => n === "LinkMark", enter: (node, ctx) => {
    // #323hide the `[ ]` only for a link that actually RENDERS as a link/atom — a real
    // `[text](url)` (resolvable href) or an attachment chip/card. A bare `[text]` with no destination keeps
    // its brackets (literal text, reader parity) instead of collapsing to a link-looking `text`.
    const p = asTree(node).parent;
    if (p?.name === "Link") {
      const src = ctx.state.doc.sliceString(p.from, p.to);
      if (!linkHref(src) && !parseAttachmentLinkRef(src)) return; // bare shortcut → keep [ ] visible
    }
    ctx.hideMarker(node.from, node.to);
  } },
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
      if (active && !active.raw && active.from <= from && active.to >= to && !ctx.state.readOnly) {
        // #502 floor: `active.raw` (a peer co-edits → enterMacroAt forced source) falls through to the raw
        // pipe source below (rangeRevealed → canonical, yCollab-merged) instead of the clobbering grid.
        ctx.addAtomic(Decoration.replace({ widget: new EditableTableWidget(from, to, doc.sliceString(from, to)), block: true }), from, to);
        return;
      }
      if (rangeRevealed(ctx.state, from, to)) {
        // #216 comment 874: RAW-editing state (caret in the pipe table, `| a | b |` source visible) → this is
        // when to surface the RichUI-entry pill, NOT the rendered widget (the reversed condition the reviewer
        // rejected). LIVE + editable only: source mode already reveals everything raw, so a pill on every table
        // there would be noise. Mark the first line as the positioning context and float the pill above it.
        if (ctx.state.facet(displayMode) === "live") {
          addRawPillContext(ctx, from, to);
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
      const src = ctx.state.doc.sliceString(node.from, node.to);
      const ref = parseImageRef(src);
      if (!ref) return; // not our attachment ref → leave as raw markdown (no arbitrary external <img>)
      const line = ctx.state.doc.lineAt(node.from);
      const standalone = line.text.trim() === src.trim();
      if (standalone) {
        // #255 comment 1073: a standalone image is an ATOM (like a diagram) — reveal ONLY on explicit entry
        // (Ctrl+Enter / the pill → macroRenderActiveField), NEVER on caret landing. The wrap's align class
        // centres/aligns it, so the old cm-lp-img-center line deco is no longer needed.
        const active = ctx.state.field(macroRenderActiveField, false);
        if (active && active.from <= node.from && active.to >= node.to) return; // revealed → raw markdown
        ctx.addAtomic(
          Decoration.replace({ widget: new StandaloneImageWidget(ref.id, ref.alt, ref.align, atomSelected(ctx.state, node.from, node.to)), block: true }),
          node.from,
          node.to,
        );
        return;
      }
      // Inline image (text on the line): unchanged — reveal on caret landing, plain widget, stays in flow.
      if (lineRevealed(ctx.state, node.from)) return;
      ctx.addAtomic(Decoration.replace({ widget: new ImageWidget(ref.id, ref.alt) }), node.from, node.to);
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
    footnotes: state.readOnly ? collectDocFootnotes(state) : null, // #335aggregate on read surfaces only
  };

  // #370 / ADR-145 §2: the leading YAML frontmatter block renders as a top-of-page tag-chip widget atom.
  // Caret inside (blockRevealed) → raw YAML (the always-works edit fallback); source mode → raw. The whole
  // fence is one atomic block replace, so doc-line motion (gg / j / dd) treats it as a unit like any macro
  // atom. Position-0-only (parseFrontmatterRange), so a mid-document `---` fence is never captured. This
  // pass runs BEFORE the tree walk so renderers that respect coveredByBlock (the hr / setext renderers the
  // fence lines would otherwise hit) skip the covered range instead of shadowing this widget.
  {
    const fmr = parseFrontmatterRange(state.doc.toString());
    if (fmr && fmr.to > fmr.from && !isSourceMode(state) && !blockRevealed(state, fmr.from, fmr.to)) {
      ctx.addAtomic(
        Decoration.replace({ widget: new FrontmatterWidget(state.doc.sliceString(fmr.from, fmr.to), !state.readOnly, atomSelected(state, fmr.from, fmr.to)), block: true }),
        fmr.from, fmr.to,
      );
    }
  }


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
    if (typeof window !== "undefined") { const w = window as unknown as { __pp?: unknown[] }; (w.__pp ??= []).push({ name: dir.name, from: dir.from, to: dir.to, closed: dir.closed, revealed: directiveRevealed(state, dir.name, dir.from, dir.to), nested: caretInNestedMacro(state, dir.from, dir.to) }); }
    // #196 / ADR-092 (comment 740): innermost-wins — reveal a directive's raw fences ONLY when the caret
    // edits THIS directive itself, not when it's deeper inside a nested child. Without `!caretInNestedMacro`
    // a layout container (columns/tabs) whose nested callout is being edited kept its own `::::columns` /
    // `::::` fences raw (the leak): the caret is within the container's range, so plain `rangeRevealed` was
    // true. The frame + descend renderer keeps the container drawn, so hiding its fences here is correct.
    if (directiveRevealed(state, dir.name, dir.from, dir.to) && !caretInNestedMacro(state, dir.from, dir.to)) continue; // editing this block → raw fences
    const openLine = state.doc.lineAt(dir.from);
    if (!ctx.fenceLineStarts.has(openLine.from) && openLine.from < openLine.to) ctx.hideMarker(openLine.from, openLine.to, undefined, false);
    if (dir.closed) {
      const closeLine = state.doc.lineAt(Math.min(dir.to, state.doc.length));
      if (!ctx.fenceLineStarts.has(closeLine.from) && closeLine.from < closeLine.to) ctx.hideMarker(closeLine.from, closeLine.to, undefined, false);
    }
  }

  // #335on a read surface, append the aggregated end-of-document footnote section (numbered defs +
  // `↩` back-links). The refs were turned into numbered jump-widgets and the def lines hidden by the renderers.
  if (ctx.footnotes) {
    const fn = ctx.footnotes;
    const items = [
      ...fn.order.map((label) => { const d = fn.defRange.get(label)!; return { n: fn.numbers.get(label)!, from: d.from, to: d.to, refPos: fn.refFirstPos.get(label) ?? null, unref: false }; }),
      ...fn.unreferenced.map((label) => { const d = fn.defRange.get(label)!; return { n: 0, from: d.from, to: d.to, refPos: null, unref: true }; }),
    ];
    const key = items.map((it) => `${it.n}:${it.from}:${it.to}`).join("|");
    all.push(Decoration.widget({ widget: new FootnoteSectionWidget(key, items), side: 1, block: true }).range(state.doc.length));
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
    for (const e of tr.effects) if (e.is(foldEffect) || e.is(unfoldEffect) || e.is(setMacroRenderActive) || e.is(setNestedSelection) || e.is(setNestedEditActive) || e.is(setSlotEditActive)) return buildDecorations(tr.state);
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

// #506: is this atom INLINE — a replace widget sitting inside a text line (attachment chip, inline
// image), as opposed to a full-line/multi-line BLOCK atom (macro, table, hr, frontmatter)? An inline
// atom is single-line with NON-WHITESPACE line text outside its range (the standalone checks at the
// render sites use the same trim criterion). The distinction matters for motion: a block atom is an
// ADR-024 caret REST (land on it, step off), but an inline atom inside prose must be SKIPPED like any
// hidden inline run — resting on it parks the caret on an invisible offset (the reported "l doesn't
// cross the chip" defect: vim h/l crawled straight through the hidden range, one dead press per char).
export function isInlineAtom(doc: CmText, b: { from: number; to: number }): boolean {
  const lf = doc.lineAt(b.from);
  if (doc.lineAt(b.to).number !== lf.number) return false; // multi-line → block
  const before = doc.sliceString(lf.from, b.from);
  const after = doc.sliceString(b.to, lf.to);
  return before.trim().length > 0 || after.trim().length > 0;
}

export const blockEntry: Extension = EditorState.transactionFilter.of((tr) => {
  if (tr.docChanged || !tr.selection) return tr;
  if (tr.newSelection.ranges.length > 1) return tr; // #286: a blockwise vim selection (multi-range) — don't rebuild it to one cursor
  // #506: inline atoms (chip / inline image) are NOT vertical-motion atoms — their line is ordinary
  // prose; treating them as blocks snapped j/k landings on that line to its start.
  const baseBlocks = (tr.startState.field(livePreview, false)?.blocks ?? []).filter((b) => !isInlineAtom(tr.startState.doc, b));
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
// #522: wysiwygInlineSkip is the WYSIWYG-only BETWEEN-char (insert-caret) snap that steps a single-char
// arrow move over a hidden inline run. It used to defer to vim normal/visual via a `vimMotionActive`
// StateField mirrored from vimWysiwygCaretGuard — but #512 forces vim OFF in WYSIWYG
// (vimForcedOff = coarsePointer || wysiwyg), so `wysiwyg && vim-motion` can never hold and the mirror +
// its field + the deferral check were unreachable. Removed; the non-vim WYSIWYG snap below stays live.
export const wysiwygInlineSkip: Extension = EditorState.transactionFilter.of((tr) => {
  if (tr.docChanged || !tr.selection) return tr;
  if (tr.newSelection.ranges.length > 1) return tr; // #286: leave a blockwise vim selection (multi-range) intact
  if (tr.startState.facet(displayMode) !== "wysiwyg") return tr;
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
});

// ADR-024 dd/yy on an atom (Q3, Mode A) live in live-preview/vim-atom.ts — they remap the
// vim dd/yy *actions* to target the whole macro (register + delete), keeping the register
// correct so `p` pastes the whole macro. (Earlier a transactionFilter expanded the delete
// but couldn't set the register or handle yy; the vim-action approach does both.)

// ADR-024: "enter" a macro atom at a position — the explicit way to start editing a macro
// (Ctrl+Enter in vim, click with the mouse). A modal macro (Excalidraw) opens its modal;
// an inline/source macro becomes render-active (table → the cell-edit widget; mermaid /
// callout → revealed source via macroRenderActiveField). Returns true if a macro was
// entered. Display-only: the document is untouched; presence/collab unaffected.

// #456 S2 (host side): translate a container's declared entry point into the slot island the click
// path already opens. The macro returns offsets relative to its own source; the slot INDEX is what
// the island mount takes, and both agree because the children are counted in document order — the
// same ordering mountSlotEditIsland uses when it maps an index back to a range.
function enterDeclaredSlot(view: EditorView, dir: { from: number; to: number; macro: { enter?(src: MacroSource, ctx?: { anchor: number }): { from: number; to: number } | null } }): boolean {
  const src = view.state.doc.sliceString(dir.from, dir.to);
  // The anchor the host keys display state under is the macro's BODY offset (what the renderer is
  // handed), not the fence start — pass that, so "the tab on screen" resolves to the same entry.
  const nl = src.indexOf("\n");
  const target = dir.macro.enter?.(asMacroSource(src), nl < 0 ? undefined : { anchor: dir.from + nl + 1 });
  if (!target) return false;
  const abs = dir.from + target.from;
  const kids = resolveDirectiveRanges(view.state.doc.toString())
    .filter((r) => r.from > dir.from && r.to <= dir.to)
    .sort((a, b) => a.from - b.from);
  const direct = kids.filter((k) => !kids.some((o) => o !== k && o.from < k.from && o.to >= k.to)); // skip grandchildren
  const index = direct.findIndex((k) => abs >= k.from && abs <= k.to);
  if (index < 0) return false;
  view.dispatch({ effects: setSlotEditActive.of({ container: { from: dir.from, to: dir.to }, index }) });
  return true; // the rebuild mounts the island and focuses it — do NOT focus the outer view here
}

// #502 rework (review rejection — correctness FLOOR): is ANOTHER client already co-editing the macro
// at `macroFrom`? The inline RichUI paths (table grid / callout / fence editUI) write straight to the
// canonical Y.Text via replaceSource, so opening one WHILE a peer holds the macro's ephemeral co-edit doc
// (source island) lets the two clobber each other (LWW re-emergence — the very loss ADR-184 prevents for
// source↔source). Until the RichUI writes are unified onto the ephemeral doc (the merge re-architecture,
// the follow-up), the safe floor is: don't open the clobbering inline RichUI while a peer edits — reveal
// the SOURCE instead, which IS ephemeral-bound and merges. The Excalidraw MODAL is exempt: it already
// co-edits through its own ephemeral room (#92), so it never clobbers.
function peerEditingMacroAt(view: EditorView, macroFrom: number): boolean {
  const coHost = view.state.facet(coEditHost);
  return coHost ? isPeerEditingIsland(coHost.awareness, String(macroFrom)) : false;
}

export function enterMacroAt(view: EditorView, pos: number, raw = false): boolean {
  if (view.state.readOnly) return false;
  const tbl = tableBlockAt(view.state, pos);
  if (tbl) {
    // #502 Option B (ADR-184 addendum 2): the table grid co-edits IN PLACE now. Its
    // InnerEditHost.replaceSource writes a MINIMAL diff to the canonical Y.Text (slice 1), and the raw table
    // source a peer may reveal is ALSO canonical — so grid↔source↔grid all converge through the page's
    // yCollab (no ephemeral; canonical is the single source of truth). The old floor (redirect a co-occupied
    // grid to raw source) is therefore removed. Single-user is byte-identical (there was never a peer to
    // redirect for). The callout/fence editUI floors below STAY: their bodies ride an EPHEMERAL doc
    // (mountSurface), which does NOT converge with a canonical raw source, so redirecting to source remains
    // the safe merge path there until that body-granularity question is resolved (a follow-up slice).
    return openTableEditing(view, pos); // pipe OR :::table (#86)
  }
  const fence = macroFenceAt(view.state, pos);
  if (fence) {
    if (fence.macro.richEditUI?.present === "modal") {
      openMacroModal(view, fence.macro, () => fence.from, currentMacroTheme()); // modal co-edits via its own ephemeral — exempt
    } else {
      // #174 addendum: a ``` -notation macro's Ctrl+Enter (raw=true) reveals the RAW source (vim-editable);
      // the ✎ button (raw=false) opens the editUI. `raw` only matters for an editUI macro (mermaid); a
      // legacy source macro reveals raw either way.
      // #502 floor: while a peer co-edits, force the SOURCE reveal (merges) over the editUI (clobbers).
      const rawEff = raw || peerEditingMacroAt(view, fence.from);
      view.dispatch({ selection: EditorSelection.cursor(fence.from), effects: setMacroRenderActive.of({ from: fence.from, to: fence.to, raw: rawEff }) });
      view.focus();
    }
    return true;
  }
  let dir = directiveMacroAt(view.state, pos);
  if (!dir) {
    // #332: an atomSelectable block (embed-page) rests the caret at its atomic EDGE (block start/end),
    // which is a syntax-tree boundary where directiveMacroAt can miss. When the caret sits on a block
    // atom, retry from a position strictly inside it so Ctrl+Enter still reveals the raw source to edit.
    const b = view.state.field(livePreview, false)?.blocks?.find((bl) => pos >= bl.from && pos <= bl.to);
    if (b) dir = directiveMacroAt(view.state, Math.min(b.from + 1, view.state.doc.length));
  }
  if (dir) {
    // #456 S2: a CONTAINER says where entering it lands (tabs → the tab on screen, columns → the
    // first). Revealing raw source here would drop the reader into fences instead of the slot they
    // were looking at. The macro answers in ITS OWN source offsets; mapping them to a slot is the
    // host's job, done the same way the island mount does it — by direct children in document order.
    if (dir.macro.enter && enterDeclaredSlot(view, dir)) return true;
    // #502 floor: while a peer co-edits this callout/directive, reveal its SOURCE (merges) instead of the
    // editUI (whose replaceSource writes canonical and would clobber the peer's ephemeral flush).
    view.dispatch({ selection: EditorSelection.cursor(dir.from), effects: setMacroRenderActive.of({ from: dir.from, to: dir.to, raw: peerEditingMacroAt(view, dir.from) || undefined }) });
    view.focus();
    return true;
  }
  // #255 comment 1073: a standalone image has no rich editor — entering it reveals its RAW markdown
  // (explicit-entry via macroRenderActiveField), the same as a ``` source macro.
  const img = imageBlockAt(view.state, pos);
  if (img) {
    view.dispatch({ selection: EditorSelection.cursor(img.from), effects: setMacroRenderActive.of({ from: img.from, to: img.to, raw: true }) });
    view.focus();
    return true;
  }
  // #273: a standalone file-attachment card reveals its raw link the same way.
  const att = attachmentBlockAt(view.state, pos);
  if (att) {
    view.dispatch({ selection: EditorSelection.cursor(att.from), effects: setMacroRenderActive.of({ from: att.from, to: att.to, raw: true }) });
    view.focus();
    return true;
  }
  return false;
}

// Ctrl+Enter (ADR-024 Q1): enter the macro atom at the caret. event.key "Enter" is
// layout/JIS-safe. Bound via the editor keymap; remappable later (#4).
// #290 / ADR-114: PROMOTE a plain GFM task-list block to a :::todo directive (the table-precedent
// promotion — an explicit action, never auto). Wraps the contiguous task-list block at the caret in
// `:::todo[]\n…\n:::` as ONE offset-invariant Y.Text edit and drops the caret in the `[]` to type the title.
// Skips when already inside a directive (so a :::todo / callout task list doesn't double-wrap). Reached via
// Ctrl+Enter on a task line (below); the plain body keeps the ADR-019 checkboxes working throughout.
const PROMOTE_TASK_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/;
export function promoteTaskListToTodo(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const { state } = view;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  if (!PROMOTE_TASK_RE.test(line.text)) return false;
  if (directiveMacroAt(state, head)) return false; // already inside a directive (e.g. a :::todo) → no double-wrap
  let first = line.number;
  let last = line.number;
  while (first > 1 && PROMOTE_TASK_RE.test(state.doc.line(first - 1).text)) first--;
  while (last < state.doc.lines && PROMOTE_TASK_RE.test(state.doc.line(last + 1).text)) last++;
  const from = state.doc.line(first).from;
  const to = state.doc.line(last).to;
  const body = state.doc.sliceString(from, to);
  view.dispatch({
    changes: { from, to, insert: `:::todo[]\n${body}\n:::` },
    selection: { anchor: from + ":::todo[".length }, // caret inside the [] for the title
    userEvent: "input.promote",
  });
  view.focus();
  return true;
}

// #290 / ADR-114: DEMOTE a :::todo back to a plain GFM task list — an EXPLICIT action ("remove ring"),
// never the table-style auto-demote (the ring is the directive's reason to exist). Replaces the whole
// `:::todo[…]\n…\n:::` block with just its body (the task list) in one offset-invariant Y.Text edit; the
// title is dropped (the body task list is lossless — Open formats). Reached via the header ✕ button (below).
export function demoteTodoToTaskList(view: EditorView, pos: number): boolean {
  if (view.state.readOnly) return false;
  const dir = directiveMacroAt(view.state, pos);
  if (!dir || dir.name !== "todo") return false;
  view.dispatch({
    changes: { from: dir.from, to: dir.to, insert: dir.body },
    selection: { anchor: dir.from },
    userEvent: "input.demote",
  });
  view.focus();
  return true;
}

// #332the embed macro at `pos` if it is an `atomSelectable` embed (embed-page) — resolved with the
// atom-edge retry (an empty caret rests at the block edge, where directiveMacroAt can miss). Ctrl+Enter on such
// an atom opens its RETARGET picker (the ⇆ UI), NOT the raw reveal: the id is re-picked, never hand-edited in
// the block (raw editing stays reachable via Source mode — Open formats intact). Returns the directive name.
function atomSelectableEmbedAt(state: EditorState, pos: number): string | null {
  let dir = directiveMacroAt(state, pos);
  if (!dir) {
    const b = state.field(livePreview, false)?.blocks?.find((bl) => pos >= bl.from && pos <= bl.to);
    if (b) dir = directiveMacroAt(state, Math.min(b.from + 1, state.doc.length));
  }
  if (!dir) return null;
  const m = findDirectiveMacro(dir.name);
  return m?.revealOnCursor && m.atomSelectable ? dir.name : null;
}

export function enterMacroCommand(view: EditorView): boolean {
  // #174 comment 1003 / ADR-100 (innermost-wins): if a NESTED macro (inside a columns/tabs container) is
  // selected, Ctrl+Enter opens ITS editUI — the same target as the nested ✎ — not the container's. In
  // WYSIWYG the container is one atom (the caret can't sit inside), so a nested macro is reached by click
  // (setNestedSelection); this makes the keyboard entry match the mouse one for the selected nested macro.
  const nsel = view.state.field(nestedSelectionField, false);
  if (nsel && enterNestedMacroAt(view, nsel)) return true;
  // #332(user ruling): Ctrl+Enter on a selected atomSelectable embed (embed-page) opens the RETARGET
  // picker (same as the ⇆ button), not the raw reveal. The picker re-picks the page id; raw editing is via
  // Source mode. Only when the picker seam exists (else fall through to the raw reveal below).
  const embedName = atomSelectableEmbedAt(view.state, view.state.selection.main.head);
  const embedSeam = embedName === "embed-page" ? view.state.facet(pageEmbedPicker) : embedName === "embed-external" ? view.state.facet(embedUrlPrompt) : null;
  if (embedName && embedSeam) {
    changeEmbedTarget(view, () => view.state.selection.main.head, embedName);
    return true;
  }
  // #174 addendum: otherwise Ctrl+Enter reveals RAW source (raw=true) — for a ``` editUI macro (mermaid)
  // that means the vim-editable source, NOT the editUI (which the ✎ button opens). Harmless for others.
  if (enterMacroAt(view, view.state.selection.main.head, true)) return true;
  // #290: no macro at the caret but on a plain task-list block → promote it to :::todo.
  return promoteTaskListToTodo(view);
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

// #278④: Reading REUSES the edit-built widget DOM (① — listeners AND the ×/ chrome
// spans survive a display-mode switch), so reading-surface styling cannot key on the DOM. Stamp the
// mode on the editor root; the theme's `&.cm-lp-mode-reading` rules key on it. editorAttributes merges
// on every update, so the class follows the Compartment-toggled displayMode with no re-pin.
const readingModeClass: Extension = EditorView.editorAttributes.of((view): Record<string, string> | null =>
  view.state.facet(displayMode) === "reading" ? { class: "cm-lp-mode-reading" } : null);

const livePreviewBaseTheme = EditorView.baseTheme({
  // #359symptom 2: the visual-selection tint painted OVER a block atom the selection crosses
  // the widget's opaque surface hides .cm-selectionBackground, so without this the selection extent is
  // invisible on atoms. Overlay (::after), never a background swap: the rendered content stays put.
  ".cm-lp-atom-insel": { position: "relative" },
  ".cm-lp-atom-insel::after": {
    content: "''", position: "absolute", inset: "0", pointerEvents: "none", zIndex: "3",
    background: "color-mix(in srgb, var(--accent, #4ea1ff) 18%, transparent)", borderRadius: "6px",
  },
  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-emphasis": { fontStyle: "italic" },
  // #334 / ADR-129: highlight (`==text==`) — a themed marker tint, foreground preserved (matches the
  // rendered <mark> in callout-icons.css so the editor and the published page look identical).
  ".cm-lp-highlight": { background: "color-mix(in srgb, var(--accent, #4ea1ff) 22%, transparent)", borderRadius: "2px", padding: "0 0.1em" },
  ".cm-lp-strike": { textDecoration: "line-through", opacity: "0.75" },
  // #335 / ADR-130: footnote — a superscript accent reference and a muted definition line (matches the
  // rendered `.cm-lp-footnote-ref` / `.cm-lp-footnotes` in callout-icons.css so editor and page don't drift).
  ".cm-lp-footnote-ref": { verticalAlign: "super", fontSize: "0.75em", color: "var(--link, #4ea1ff)", lineHeight: "1" },
  ".cm-lp-footnote-def": { fontSize: "0.9em", opacity: "0.8" },
  // #307 / ADR-127 → #370(user ruling): the `:::tagged` / `:::children` list renders as a PLAIN
  // Markdown bullet list — no box chrome (border / radius / panel wash / inner padding). The nested
  // `:::children` tree indents via real sub-<ul>s, background-free.
  ".cm-lp-backlinks": { margin: "0.3em 0" },
  ".cm-lp-backlinks-label": { fontSize: "0.85em", fontWeight: "600", color: "var(--fg-dim, #888)", marginBottom: "0.3em" },
  ".cm-lp-backlinks-list": { listStyle: "disc", margin: "0", padding: "0 0 0 1.4em" },
  ".cm-lp-backlinks-list li": { margin: "0.1em 0" },
  // #370: the frontmatter properties widget (tag chips). Padding, not margin (block-widget heightMap rule).
  ".cm-lp-frontmatter": { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "0.4em", padding: "0.35em 0.2em 0.6em", borderBottom: "1px solid var(--border)" },
  ".cm-lp-frontmatter-label": { fontSize: "0.75em", color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: "0.04em" },
  ".cm-lp-frontmatter-chip": { display: "inline-flex", alignItems: "center", gap: "0.25em", fontSize: "0.8em", lineHeight: "1.6", padding: "0 0.55em", borderRadius: "999px", background: "var(--panel-2)", color: "var(--fg)" },
  ".cm-lp-frontmatter-remove": { border: "none", background: "none", cursor: "pointer", color: "var(--fg-dim)", padding: "0 0.1em", fontSize: "1em", lineHeight: "1" },
  ".cm-lp-frontmatter-remove:hover": { color: "var(--fg)" },
  ".cm-lp-frontmatter-empty": { fontSize: "0.8em", color: "var(--fg-dim)" },
  // #402: the find/replace panel + match highlights, on DS tokens (the CM defaults clash with dark).
  ".cm-panels": { background: "var(--panel)", color: "var(--fg)", border: "none" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel.cm-search": { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.3em", padding: "0.4em 0.6em", fontSize: "0.85em" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { font: "inherit" },
  ".cm-panel.cm-search input": { background: "var(--panel-2)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: "5px", padding: "0.15em 0.45em", outline: "none" },
  ".cm-panel.cm-search input:focus-visible": { borderColor: "var(--accent)" },
  ".cm-panel.cm-search button.cm-button": { background: "var(--panel-2)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: "5px", padding: "0.15em 0.6em", cursor: "pointer", backgroundImage: "none" },
  ".cm-panel.cm-search button.cm-button:hover": { background: "var(--panel-3)" },
  ".cm-panel.cm-search label": { display: "inline-flex", alignItems: "center", gap: "0.25em", color: "var(--fg-dim)" },
  ".cm-panel.cm-search [name=close]": { color: "var(--fg-dim)", cursor: "pointer" },
  ".cm-searchMatch": { background: "color-mix(in srgb, var(--accent) 28%, transparent)", outline: "1px solid color-mix(in srgb, var(--accent) 45%, transparent)" },
  ".cm-searchMatch-selected": { background: "color-mix(in srgb, var(--accent) 55%, transparent)" },
  ".cm-lp-frontmatter-input": { border: "none", outline: "none", background: "transparent", font: "inherit", fontSize: "0.8em", color: "var(--fg)", minWidth: "6em", flex: "0 1 auto" },
  // #413the custom tag-suggest popup (replaces the native datalist). Popover surface tokens
  // (light/dark follow), keyboard-highlight row, and a font/browser-independent Lucide trigger.
  ".cm-lp-fm-inputrow": { position: "relative", display: "inline-flex", alignItems: "center", gap: "0.15em", flex: "0 1 auto" },
  ".cm-lp-fm-suggest-trigger": { border: "none", background: "none", cursor: "pointer", color: "var(--fg-dim)", padding: "0 0.1em", lineHeight: "1", display: "inline-flex", alignItems: "center" },
  ".cm-lp-fm-suggest-trigger:hover": { color: "var(--fg)" },
  ".cm-lp-fm-suggest": {
    position: "absolute", top: "100%", left: "0", zIndex: "30", marginTop: "2px",
    minWidth: "12em", maxHeight: "14em", overflowY: "auto",
    display: "flex", flexDirection: "column", padding: "0.25em",
    background: "var(--popover, var(--panel))", color: "var(--fg)",
    border: "1px solid var(--border)", borderRadius: "var(--radius-md, 8px)",
    boxShadow: "var(--shadow-md, 0 8px 24px rgba(0,0,0,0.28))",
  },
  ".cm-lp-fm-suggest-item": {
    border: "none", background: "none", cursor: "pointer", textAlign: "left",
    font: "inherit", fontSize: "0.8em", color: "var(--fg)",
    padding: "0.25em 0.5em", borderRadius: "5px", whiteSpace: "nowrap",
  },
  ".cm-lp-fm-suggest-item:hover": { background: "var(--panel-2)" },
  ".cm-lp-fm-suggest-active": { background: "color-mix(in srgb, var(--accent) 14%, transparent)" },
  ".cm-lp-backlinks-item": { color: "var(--link, #4ea1ff)", textDecoration: "none", cursor: "pointer" },
  ".cm-lp-backlinks-item:hover": { textDecoration: "underline" },
  ".cm-lp-backlinks-empty": { fontSize: "0.85em", color: "var(--fg-dim, #888)", fontStyle: "italic", padding: "0.2em 0" },
  ".cm-lp-inline-code": {
    fontFamily: "var(--font-code)", // #190: code face (Wikistead Mono), distinct from prose --font-body
    background: "var(--wks-inline-code-bg, rgba(127,127,127,0.18))", // #381 shared value token
    borderRadius: "var(--wks-inline-code-radius, 3px)",
    padding: "0 3px",
  },
  ".cm-lp-link": { color: "var(--link, #4ea1ff)", textDecoration: "underline" }, // #223: semantic token, not a hardcoded blue
  // #323a bare `[text]` (no href) at caret-away — cancel the syntax highlighter's link tint so it reads
  // as plain body text (reader parity). The highlight span nests INSIDE this mark span, so force the inner span
  // to inherit too (a mark-only rule would be overridden by the inner highlight colour).
  ".cm-lp-link-plain, .cm-lp-link-plain span": { color: "inherit !important", textDecoration: "none !important" },
  // #276 / ADR-117: a dead internal link (target not viewable) reads as struck-through + dimmed. Layered
  // OVER cm-lp-link (a second mark), so line-through + the muted colour win over the link's underline/colour.
  ".cm-lp-link-dead": { textDecoration: "line-through", color: "var(--fg-dim, #8a8f98)", cursor: "pointer" },
  // In the read-only render links are click-to-open, so show the affordance there.
  ".cm-content[contenteditable=false] .cm-lp-link[data-href]": { cursor: "pointer" },
  // #224 / ADR-104: auto internal links — a subtler affordance than explicit links (dotted underline) so a
  // title match reads as "there's a page here" without competing with authored [text](url) links.
  ".cm-lp-title-link": { color: "var(--link-auto, #83c092)", textDecoration: "underline dotted", cursor: "pointer" }, // #224(5): tokenized (light/dark)
  // #190: headings follow the PROSE font (--font-body) too, so the user's font choice / locale default
  // applies to titles, not just body. .cm-content already sets --font-body (cm-theme.ts) and headings
  // inherit it, but set it EXPLICITLY here so no inherited/default family can strand headings on a
  // different face than the body (the bounce: titles didn't track the font selection).
  ".cm-lp-h": { fontWeight: "700", lineHeight: "1.3", fontFamily: "var(--font-body)" },
  // #381 / ADR-163 §2: the heading scale / inline-code box / quote / hr / table-border VALUES are shared
  // custom properties (styles/prose.css :root) consumed by BOTH this CM vocabulary and the raw-tag
  // .wks-prose vocabulary — selectors stay per-vocabulary (structural), magnitudes cannot drift.
  ".cm-lp-h1": { fontSize: "var(--wks-prose-h1, 1.8em)" },
  ".cm-lp-h2": { fontSize: "var(--wks-prose-h2, 1.5em)" },
  ".cm-lp-h3": { fontSize: "var(--wks-prose-h3, 1.3em)" },
  ".cm-lp-h4": { fontSize: "var(--wks-prose-h4, 1.15em)" },
  ".cm-lp-h5": { fontSize: "var(--wks-prose-h5, 1.05em)" },
  ".cm-lp-h6": { fontSize: "var(--wks-prose-h6, 1em)", opacity: "0.85" },
  ".cm-lp-code-line": {
    fontFamily: "var(--font-code)", // #190: fenced code uses the code face, not prose --font-body
    background: "var(--wks-code-bg, rgba(127,127,127,0.12))", // #381shared value token (prose.css)
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
  // #456 rev (review ①): the code-settings ✎ shares the copy button's chrome, placed to its LEFT — the
  // ✎ carries the marginLeft:auto that pushes the whole corner group right, and the adjacent copy drops its
  // own auto-margin so the two sit together (a single top-right control cluster).
  ".cm-lp-code-settings-btn": {
    display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
    marginLeft: "auto", padding: "0.2em", marginBottom: "0.15em", borderRadius: "5px", border: "1px solid transparent",
    background: "transparent", color: "var(--fg-dim, #888)", opacity: "0.65", transition: "opacity 120ms ease, background 120ms ease, color 120ms ease",
  },
  ".cm-lp-code-settings-btn:hover": { opacity: "1", background: "var(--hover, rgba(128,128,128,0.16))", color: "var(--fg)" },
  ".cm-lp-code-settings-btn:focus-visible": { outline: "2px solid var(--accent, #4ea1ff)", outlineOffset: "1px" },
  ".cm-lp-code-settings-btn + .cm-lp-code-copy": { marginLeft: "2px" }, // sit next to ✎, not pushed apart by a 2nd auto-margin
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
    borderLeft: "var(--wks-quote-border, 3px solid var(--border, #888))", // #381 shared value token
    paddingLeft: "0.8em",
    color: "var(--fg-dim, #888)",
  },
  // Thematic break: the glyph is hidden, so the empty line shows a rule. NOTE: never
  // zero the line height — a 0-height .cm-line corrupts CodeMirror's vertical-motion
  // geometry (caret jumps over lines). Draw the rule with a centered border instead.
  ".cm-lp-hr": {
    borderTop: "var(--wks-hr-border, 2px solid var(--border, #888))", // #381 shared value token
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
    border: "var(--wks-table-cell-border, 1px solid var(--border, #444))", // #381 shared value token
    padding: "var(--wks-table-cell-padding, 3px 8px)", // #381shared value token
    textAlign: "left",
    // #197 (comment 638): a min row height so an EMPTY cell/row doesn't collapse to a sliver. In table
    // layout `height` acts as a minimum, so every row is at least ~1 line tall whether it has text or not.
    height: "1.8em",
    verticalAlign: "top",
    // #406and a min COLUMN width, for the same reason in the other axis. The editor wraps text
    // anywhere (CM's lineWrapping breaks mid-word), so a table's minimum width collapsed to almost
    // nothing: on a phone an eight-column table squeezed into 332px, one or two characters per line,
    // and ran off the bottom of the screen. With a floor per column the table simply gets wider than
    // the surface and scrolls inside its wrap, which is what a wide table should do.
    minWidth: "5em",
  },
  // #197: a PALE, token-driven header (was a hardcoded grey wash). Neutral surface + --fg text so the
  // header is always readable in any theme — no accent tint that could clash with the header text.
  ".cm-lp-table th": { background: "var(--wks-table-th-bg, var(--panel-2, #f0f1f3))", color: "var(--fg)", fontWeight: "700" }, // #381shared value token
  // #518: explicit headers stick on scroll — the GFM top row (thead th) and a :::table row header (a th
  // that is the first cell of its row). The scroll wrap gets a max-height (below) so a TALL table scrolls
  // inside its box with the header pinned; short tables keep their natural height. Opaque th-bg + an
  // inset box-shadow edge keep the separating border with the sticky cell (a border-collapse border
  // otherwise scrolls away).
  // #518 (re-design): the header follows the PAGE scroll — NOT a box-scroll. The whole table shows
  // all its rows; as you scroll the editor (`.cm-scroller`, the nearest scroll ancestor now that the wrap
  // no longer clips), `thead th` sticks at `top: var(--wks-band-h)` so it stops JUST BELOW the frosted app
  // header band, never under it. The left-column `th:first-child` sticks left on horizontal scroll (secondary
  // — the .cm-scroller scrolls sideways for a wide table so every column stays reachable/editable).
  ".cm-lp-table thead th": { position: "sticky", top: "var(--wks-band-h, 0px)", zIndex: "2", boxShadow: "inset 0 -1px 0 var(--border)" },
  ".cm-lp-table th:first-child": { position: "sticky", left: "0", zIndex: "1", boxShadow: "inset -1px 0 0 var(--border)" },
  ".cm-lp-table thead th:first-child": { top: "var(--wks-band-h, 0px)", zIndex: "3", boxShadow: "inset -1px -1px 0 var(--border)" },
  ".cm-lp-image": { maxWidth: "100%", height: "auto", borderRadius: "4px", verticalAlign: "bottom" },
  // #273: file-attachment affordances. The inline chip flows with the text; the standalone card
  // is a bordered row; the sandboxed PDF frame gets a bounded height (the ResizeObserver keeps
  // CM's heightMap honest — block-widget motion rule). Padding, not margin, on the wrap (heightMap).
  ".cm-lp-attachment-chip": {
    display: "inline-flex", alignItems: "center", gap: "4px", padding: "0 6px",
    border: "1px solid var(--wks-border, rgba(128,128,128,.35))", borderRadius: "6px",
    background: "color-mix(in srgb, currentColor 6%, transparent)", whiteSpace: "nowrap",
    cursor: "pointer", // c 07-16 return (2): the chip reads as pressable (download; PDF overrides to zoom-in)
  },
  ".cm-lp-attachment-chip:hover": {
    background: "color-mix(in srgb, currentColor 12%, transparent)",
    borderColor: "color-mix(in srgb, currentColor 50%, transparent)",
  },
  // #273the chip-pdf zoom-in cursor is retired — an inline chip always downloads (pointer).
  ".cm-lp-attachment-size": { opacity: "0.65", fontSize: "0.85em" },
  ".cm-lp-attachment-dl": {
    border: "none", background: "transparent", cursor: "pointer", padding: "0 2px",
    fontSize: "0.95em", lineHeight: "inherit", color: "inherit", opacity: "0.75",
  },
  ".cm-lp-attachment-dl:hover": { opacity: "1" },
  // #273/hovering the HEADER makes its operations prominent (the ⤓ was too faint at
  // 0.75). Scoped to the header row, not the whole wrap: on an inline-PDF card the wrap also covers
  // the preview, andsplit the card into two click targets (header = download, preview =
  // expand). Hover feedback has to name the target it belongs to, or the split reads as noise.
  ".cm-lp-attachment-card:hover .cm-lp-attachment-dl": { opacity: "1" },
  ".cm-lp-attachment-wrap": { padding: "2px 0" },
  ".cm-lp-attachment-card": {
    display: "flex", alignItems: "center", gap: "6px", padding: "8px 10px",
    border: "1px solid var(--wks-border, rgba(128,128,128,.35))", borderRadius: "8px",
    background: "color-mix(in srgb, currentColor 5%, transparent)",
  },
  ".cm-lp-attachment-name": { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: "0", flex: "1" },
  // #273a DOWNLOAD card is full-surface clickable (c1660-2), so it must LOOK clickable — pointer
  // cursor + a slightly stronger hover wash/border. Gated on frame ABSENCE via :has, the same condition
  // the click handler uses (so it also covers a PDF the server refused to inline, and never applies to an
  // inline viewer card whose body is the pdf.js frame). currentColor color-mix tracks light/dark themes.
  ".cm-lp-attachment-wrap:not(:has(.cm-lp-attachment-frame)) .cm-lp-attachment-card": { cursor: "pointer" },
  ".cm-lp-attachment-wrap:not(:has(.cm-lp-attachment-frame)) .cm-lp-attachment-card:hover": {
    background: "color-mix(in srgb, currentColor 11%, transparent)",
    borderColor: "color-mix(in srgb, currentColor 50%, transparent)",
  },
  // #273(supersedes thezoom-in): the PDF INLINE card's HEADER means DOWNLOAD — pointer
  // cursor, same hover wash; the zoom-in "open" affordance belongs to the PREVIEW area (frame + ⤢).
  ".cm-lp-attachment-wrap:has(.cm-lp-attachment-frame) .cm-lp-attachment-card": { cursor: "pointer" },
  ".cm-lp-attachment-wrap:has(.cm-lp-attachment-frame) .cm-lp-attachment-card:hover": {
    background: "color-mix(in srgb, currentColor 11%, transparent)",
    borderColor: "color-mix(in srgb, currentColor 50%, transparent)",
  },
  // #273the frame lives in a relative box so the hover "open large" overlay can sit over it.
  ".cm-lp-attachment-framebox": { position: "relative", marginTop: "6px" },
  ".cm-lp-attachment-frame": {
    display: "block", width: "100%", height: "480px",
    border: "1px solid var(--wks-border, rgba(128,128,128,.35))", borderRadius: "8px", background: "#fff",
  },
  // #273an overlay over the inline PDF preview — invisible until the card is hovered, then it dims the
  // preview slightly and shows a ⤢ hint with a zoom-in cursor. Clicking it opens the lightbox (the sandboxed
  // iframe can't bubble its own clicks, so this captures the expand intent). Not shown for non-PDF (no frame).
  ".cm-lp-attachment-expand": {
    position: "absolute", inset: "0", display: "flex", alignItems: "flex-start", justifyContent: "flex-end",
    padding: "8px", borderRadius: "8px", cursor: "zoom-in", opacity: "0", pointerEvents: "none",
    background: "color-mix(in srgb, #000 0%, transparent)", transition: "opacity 120ms, background 120ms",
  },
  // #273the dim + ⤢ appear when the PREVIEW is hovered — not when anything on the card is.
  // Keyed on the whole wrap it fired from the header too, dimming the preview while the pointer was
  // over the download target: the two halvesseparated looked like one control again.
  ".cm-lp-attachment-framebox:hover .cm-lp-attachment-expand": {
    opacity: "1", pointerEvents: "auto", background: "color-mix(in srgb, #000 8%, transparent)",
  },
  ".cm-lp-attachment-expand-hint": {
    display: "inline-flex", alignItems: "center", justifyContent: "center", width: "26px", height: "26px",
    borderRadius: "6px", fontSize: "1.05em", lineHeight: "1",
    background: "var(--wks-panel, rgba(20,20,20,.82))", color: "var(--wks-fg, #fff)",
    border: "1px solid var(--wks-border, rgba(128,128,128,.4))",
  },
  // #305: a TRULY inline image (text shares its line) renders as a line-height thumbnail so it flows WITH the
  // text instead of forcing a wrap (a large natural size used to occupy the whole line width, pushing the
  // surrounding text onto new visual rows — the "a newline got inserted" report). Click/enter still reaches
  // the raw source; place the image on its OWN line for the full-size standalone atom (#255, unaffected — it
  // uses cm-lp-image WITHOUT this modifier, inside cm-lp-image-wrap).
  //display must be OVERRIDDEN here — the Tailwind Preflight sets `img { display: block }` on every
  // img, so without inline-block the thumbnail still broke the line (sized right, but block = own row).
  ".cm-lp-image-inline": { display: "inline-block", maxHeight: "1.6em", width: "auto", verticalAlign: "text-bottom" },
  // #255 comment 1036: a standalone-image line centres its (inline) <img>. Display-only — the line deco is
  // dropped when the line reveals raw for editing, so it never shifts offsets or affects motion.
  ".cm-lp-img-center": { textAlign: "center" },
  // Macro block (e.g. ```mermaid). The wrap is relative so the fold button can sit in
  // a corner; the rendered DOM is whatever the macro's liveRender returns.
  // padding NOT margin: CM measures a block widget's height via getBoundingClientRect /
  // offsetHeight, which EXCLUDE margin. Margin on the widget root is therefore uncounted in
  // the heightMap and accumulates across stacked widgets → vim/arrow motion below 2+ macros
  // drifts by a line. Padding is included in the measured height, so the heightMap matches.
  ".cm-lp-macro-wrap": { position: "relative", padding: "0.4em 0" },
  // #395 / ADR-156 rule 2: atom bodies never suggest text editing. Interactive children (links,
  // buttons, checkboxes) keep their own element-level `pointer` rules, which win over inheritance.
  ".cm-lp-atom-body": { cursor: "default" },
  // ADR-024 atom selection: the caret resting on the atom rings it (selected as a unit).
  // #395UX: a soft halo AROUND the 2px ring — with tenant accents far from blue, the thin
  // outline alone read as decoration, not selection. The halo widens the selected signal without
  // touching layout (box-shadow is paint-only) and stays accent-tinted so themes keep their voice.
  ".cm-lp-atom-sel": { outline: "2px solid var(--accent, #4ea1ff)", outlineOffset: "1px", borderRadius: "4px", boxShadow: "0 0 0 5px color-mix(in srgb, var(--accent, #4ea1ff) 22%, transparent)" },
  // #174 / ADR-087: mouse HOVER shows a subtle block-boundary highlight on EVERY block macro
  // (columns/tabs/table/mermaid/…), so a mouse user sees the block is an interactive unit — parity
  // with the selection ring. `:not(.cm-lp-atom-sel)` so the accent selection ring wins when selected.
  // Display-only (never edits/offsets).
  ".cm-lp-macro-wrap:hover:not(.cm-lp-atom-sel)": { outline: "1px solid var(--border, #888)", outlineOffset: "1px", borderRadius: "4px" },
  // #319 c1587-B: on a READ-ONLY surface (public reader / Reading / template preview = mountPublishedView, whose
  // .cm-content is contenteditable=false) a macro cannot be edited, so its edit AFFORDANCES are noise — suppress
  // the hover block-boundary frame AND the atom selection ring (the ✎ edit button is already gated on
  // !state.readOnly at build time). Higher specificity than the two rules above, so it wins. One rule fixes all
  // three read-only faces (the #335 read-only-unification axis).
  ".cm-content[contenteditable=\"false\"] .cm-lp-macro-wrap:hover, .cm-content[contenteditable=\"false\"] .cm-lp-atom-sel": { outline: "none", boxShadow: "none" },
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
  // #92 presence (comment 982 ②③): the old inline "N editing" badge was replaced by the outline + avatar
  // overlay in macro-presence-overlay.ts (its own baseTheme). Nothing to style here anymore.
  // pointer-events:none on the SVG so a click on the diagram falls through to the macro
  // container (CM then places the caret → reveal-on-cursor shows the raw source). An
  // SVG-internal click can't be mapped to a doc position, so without this clicking a
  // diagram wouldn't reveal it. Scoped to the svg so the container stays hoverable
  // (the fold button shows on hover).
  ".cm-lp-mermaid svg": { maxWidth: "100%", height: "auto", pointerEvents: "none" },
  // #174 / ADR-087: the mermaid inline editUI — source textarea beside a live preview (stacks on a
  // narrow block). The preview reuses the .cm-lp-mermaid svg sizing above.
  // #278D: the source pane HUGS its content — alignItems flex-start (was `stretch`, which pulled the
  // source pane up to the preview's height so a 1-line diagram sat in a huge empty box). The src container no
  // longer forces minHeight/font/resize: it now hosts a CM6 mini-editor (mountSourceEditor) that controls its
  // own font (inherits the host size, code face) and height; the container only frames it.
  ".cm-lp-mermaid-edit": { display: "flex", gap: "0.8em", alignItems: "flex-start", flexWrap: "wrap" },
  ".cm-lp-mermaid-edit-src": { flex: "1 1 16em", minWidth: "12em", border: "1px solid var(--border, #888)", borderRadius: "6px", overflow: "hidden", background: "var(--bg, #fff)", color: "var(--fg, inherit)" },
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
    top: "-1.5em", // above the content box (outside the iframe/widget), in the block's top margin — the
    // #424 UNIFIED offset: every edit affordance sits at block top-left with this exact top (btnrow,
    // raw pill, nested, callout panel), so Live and WYSIWYG render the button in the same place.
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
  // #255 comment 1040: the top-left action buttons flow in ONE flex row (no fixed `left` magic numbers), so
  // the ✎ + its "Ctrl+↵" hint (#174) and the align toggle never overlap regardless of width. The row is the
  // positioned element; its buttons flow statically inside it.
  // #278point 1: pointer-INERT until the chrome is actually shown. The row floats -1.5em ABOVE
  // its wrap, overlapping the PREVIOUS line — with pointer-events alive there, hovering that line hit
  // the row (a wrap CHILD), satisfied `.cm-lp-macro-wrap:hover`, and lit the chrome "permanently" in a
  // slot island (where the line above is dense editing text). Interactivity returns with visibility.
  ".cm-lp-macro-btnrow": { position: "absolute", top: "-1.5em", left: "0", display: "inline-flex", alignItems: "center", gap: "4px", zIndex: "3", pointerEvents: "none" },
  // #278① (the FINAL permanent form, superseding theboundary guards): every wrap-state
  // reveal is DIRECT-CHILD (`>`) — a wrap's hover/atom-sel lights ONLY its own top-level chrome and
  // can never reach a NESTED macro's chrome (the atom-selected container leaking the inner warning's
  // ✎ was exactly a descendant match) nor an island's (a deep descendant by construction). One rule
  // shape for top level, nested renders and islands alike; no enumeration guards remain.
  ".cm-lp-macro-wrap:hover > .cm-lp-macro-btnrow, .cm-lp-macro-wrap.cm-lp-atom-sel > .cm-lp-macro-btnrow": { pointerEvents: "auto" },
  // #393 / ADR-151 addendum 3: the pipe (GFM) table's root is `.cm-lp-table-wrap` (TableWidget) /
  // `.cm-lp-table-edit` (EditableTableWidget), NOT `.cm-lp-macro-wrap` — so the reveal rules above never
  // reach its align btnrow. Mirror them for the table wraps so a pipe table's hover align segment reveals
  // exactly like a `:::table`'s (the #216/trap: a btnrow mounted but styled only under
  // `.cm-lp-macro-wrap:hover` is present-but-invisible — the actual non-affordancereported).
  ".cm-lp-table-wrap:hover > .cm-lp-macro-btnrow, .cm-lp-table-edit:hover > .cm-lp-macro-btnrow": { pointerEvents: "auto" },
  ".cm-lp-macro-btnrow > .cm-lp-macro-edit, .cm-lp-macro-btnrow > .cm-lp-macro-align": { position: "static", top: "auto", left: "auto" },
  // #424: the standalone (non-btnrow) edit button pins to the block's LEFT edge too — one position for
  // every entry affordance. Scoped to the edit button only (retarget is a top-RIGHT control).
  ".cm-lp-macro-edit": { left: "0" },
  // #255the 3-button segmented align control. The group is a rounded pill of 3 buttons sharing a
  // border; the active side gets an accent tint. Reuses the macro-align hover-reveal (it carries that class).
  ".cm-lp-align-seg": { display: "inline-flex", border: "1px solid var(--border, #888)", borderRadius: "5px", overflow: "hidden", background: "var(--panel, var(--bg, #fff))", padding: "0" },
  ".cm-lp-align-seg-btn": { display: "inline-flex", alignItems: "center", justifyContent: "center", border: "none", borderRight: "1px solid var(--border, #8884)", background: "transparent", color: "var(--fg-dim, #888)", cursor: "pointer", padding: "2px 5px", lineHeight: "1" },
  ".cm-lp-align-seg-btn:last-child": { borderRight: "none" },
  ".cm-lp-align-seg-btn:hover": { background: "color-mix(in srgb, var(--fg-dim, #888) 14%, transparent)", color: "var(--fg, #222)" },
  ".cm-lp-align-seg-on": { background: "color-mix(in srgb, var(--accent, #4ea1ff) 20%, transparent)", color: "var(--accent, #4ea1ff)" },
  ".cm-lp-macro-retarget": { left: "0" }, // embeds: a separate top-left control (no edit/align co-occur)
  // #216 comment 836: the pipe-table wrap positions the hover-revealed RichUI-entry button at the table's
  // top-left. fit-content keeps the wrap the table's width so the button aligns to the table's left edge
  // (not the full editor width). The button reuses .cm-lp-macro-edit chrome; reveal it on wrap hover.
  // #406a table wider than the surface SCROLLS sideways instead of being squeezed into it.
  // With only max-width the columns compressed until every cell wrapped, turning a wide table into a
  // very tall one — and since nothing overflowed, no scrollbar ever appeared to say otherwise.
  // #406the wrap spans the line and never scrolls (chrome anchor + resize target); the inner
  // box is the only horizontal scroller, held to the line width so a wide table can never widen the
  // editor; the table takes its natural width inside it.
  ".cm-lp-table-wrap": { position: "relative", width: "100%", maxWidth: "100%" },
  // #518 (re-design): NO local scroll box. The earlier box-scroll (max-height + overflow) both fought
  // the user's intent (they want ALL rows shown with the header following the PAGE scroll) AND clipped a wide
  // table's right columns so they were unreachable/uneditable. So `.cm-lp-table-scroll` is now a passthrough
  // (overflow: visible): a tall table shows every row, and a wide table overflows onto `.cm-scroller`, which
  // scrolls sideways so every column stays reachable — the accepted #406 trade-off (page-follow header
  // and reachable columns beat a contained sidescroll). With no overflow ancestor, `thead th`'s sticky top
  // now resolves against `.cm-scroller` = the page-basis header-follow the user asked for.
  ".cm-lp-table-scroll": { display: "block", overflow: "visible" },
  ".cm-lp-table-scroll > table": { minWidth: "max-content" },
  // #216 comment 874 / #174 comment 878 (ADR-087 addendum 2): the SHARED RichUI-entry pill on the RAW-editing
  // state of a macro (pipe table + callout). Anchored to the first revealed line (.cm-lp-macro-raw =
  // position:relative) and floated JUST ABOVE it so it never covers the raw source it advertises. ALWAYS
  // visible (opacity 0.8, full on hover) — reliably recognizable without a hover (the #216 show/no-show
  // regression was hover-dependency). Solid panel bg + border are inherited from .cm-lp-macro-edit; this rule
  // must follow .cm-lp-macro-edit in source order so its top/left/opacity/display win at equal specificity.
  ".cm-lp-macro-raw": { position: "relative" },
  // #278point 4 → #452 (owner ruling): the raw-entry pill is visible for the WHOLE reveal
  // .cm-lp-macro-raw sits on the head line only while the block is revealed, so gating on IT (not on
  // the caret-position macroRawHead) means "revealed ⇒ hint shown", whichever line the caret is on.
  // The hover rules remain for mouse affordance; macroRawHead keeps its non-pill styling duties.
  ".cm-lp-macro-richui-raw": { top: "-1.5em", left: "0", zIndex: "4", opacity: "0", pointerEvents: "none", display: "inline-flex", alignItems: "center", gap: "3px", padding: "1px 5px", transition: "opacity 120ms" },
  ".cm-lp-macro-richui-key": { fontSize: "0.72em", fontWeight: "600", letterSpacing: "0.02em" },
  //①: the zone `:has` walks DIRECT-child lines only (`>`), so hovering raw lines inside a slot
  // island can never light pills of the OUTER document (or vice versa) — .cm-content elements nest.
  ".cm-lp-macro-raw .cm-lp-macro-richui-raw, .cm-content:has(> .cm-lp-macro-raw-zone:hover) .cm-lp-macro-richui-raw": { opacity: "0.9", pointerEvents: "auto" },
  ".cm-lp-macro-richui-raw:hover": { opacity: "1", pointerEvents: "auto" },
  // #278(owner ruling, supersedes thereposition + thehover-only): island chrome
  // renders EXACTLY like top-level — same reveal triggers (hover OR macroRawHead), same -1.5em/left:0
  // position, no island-only overrides. The only island-specific CSS anywhere is the BOUNDARY scoping
  // (`:not(.cm-lp-slot-edit-island *)` / `:has(>)`), which keeps outer state from leaking in — never a
  // different look or trigger. Theclipping that motivated the reposition is solved by the
  // island scroller's overflow: visible (below); theperma-show by parking the entry caret on
  // the body line instead of the head (CalloutWidget mousedown — shared code, both surfaces).
  // #254: the LAYOUT-only variant for the ✎+Ctrl+↵ hint on a RENDERED macro. Adds the key's gap but NOT
  // the always-visible opacity of cm-lp-macro-richui-raw, so the button keeps the base opacity:0 and is
  // revealed only by the hover/selection gate (below for macro-wrap; the callout-panel rule for the panel).
  ".cm-lp-macro-edit-hint": { gap: "3px" },
  ".cm-lp-callout-panel-editable:hover .cm-lp-callout-panel-edit": { opacity: "1" },
  // #174 / ADR-087 (Class 1): the callout icon-badge type picker + the shared type CHIP now live in
  // callout-icons.css (GLOBAL) — the menu is mounted on document.body, outside .cm-editor, where these
  // baseTheme rules never applied; and keeping a baseTheme copy would OVERRIDE the global chip look for
  // the editUI panel's in-editor chips (higher editor-scoped specificity). One source: the global sheet.
  // #278 §1: PER-ITEM structure affordances on columns/tabs (retired the #213 bottom bar). A column's `×`
  // sits top-right IN the cell (hover-revealed); a tab's `×` rides the tab button; a trailing `` adds one.
  // The `×` glyph is a ::before so it never enters textContent (keeps tab labels / column text clean).
  // #278B3: the glyph fills the 1.4em chip (the 0.85em element font left it looking tiny in the box).
  ".cm-lp-layout-item-remove::before, .cm-lp-tab-remove::before": { content: '"×"', fontSize: "1.35em", lineHeight: "1" },
  // #278F: destructive affordances (the column/tab `×`) use the semantic danger token, not fg-dim
  // delete reads as delete. Hover deepens (danger-tinted fill / full-strength colour). Token-referenced, not
  // hardcoded, so it tracks light/dark (tokens.css --danger).
  // #278B5: margin 0 — the column's prose flow spacing (adjacent-sibling margin-top) leaked onto the
  // absolutely-placed chip, so a NON-empty column drew its x ~14px lower than an empty one (measured).
  ".cm-lp-layout-item-remove": { margin: "0", position: "absolute", top: "2px", right: "2px", zIndex: "3", display: "inline-flex", alignItems: "center", justifyContent: "center", width: "1.4em", height: "1.4em", border: "1px solid color-mix(in srgb, var(--danger, #cf222e) 45%, transparent)", borderRadius: "4px", background: "var(--panel, #fff)", color: "var(--danger, #cf222e)", cursor: "pointer", fontSize: "0.85em", lineHeight: "1", padding: "0", opacity: "0", transition: "opacity 120ms, filter 120ms" },
  ".cm-lp-column:hover .cm-lp-layout-item-remove": { opacity: "1" },
  // #278item 6: hover BRIGHTENS the × (thedarker/deeper hover read as a heavier action and
  // invited mis-clicks — the user ruled the opposite). brightness tracks light/dark without new tokens.
  ".cm-lp-layout-item-remove:hover": { filter: "brightness(1.3)", borderColor: "color-mix(in srgb, var(--danger, #cf222e) 70%, transparent)" },
  // #278G: absolute (top-right of the tab) so it never adds flow width — hover-revealed, danger red.
  // #278point 2: the tab × gets the SAME box treatment as the column × (1.4em bordered chip on
  // the panel background) — the borderless bare glyph was too small a target. Placement stays inside
  // the tab (right-centred; the tab's 1.4em right padding is its slot).
  ".cm-lp-tab-remove": { position: "absolute", top: "50%", right: "0.15em", transform: "translateY(-50%)", zIndex: "3", display: "inline-flex", alignItems: "center", justifyContent: "center", width: "1.4em", height: "1.4em", border: "1px solid color-mix(in srgb, var(--danger, #cf222e) 45%, transparent)", borderRadius: "4px", background: "var(--panel, #fff)", color: "var(--danger, #cf222e)", cursor: "pointer", fontSize: "0.85em", lineHeight: "1", padding: "0", opacity: "0", pointerEvents: "none", transition: "opacity 120ms, filter 120ms" },
  ".cm-lp-tab:hover .cm-lp-tab-remove, .cm-lp-tabbar:hover .cm-lp-tab-remove": { opacity: "0.75", pointerEvents: "auto" },
  ".cm-lp-tab-remove:hover": { opacity: "1", filter: "brightness(1.3)" },
  // #278A2: the inline tab-rename input — inherits the tab's face, minimal chrome (accent underline).
  ".cm-lp-tab-rename-input": { font: "inherit", color: "var(--fg, inherit)", background: "transparent", border: "none", borderBottom: "1px solid var(--accent, #4ea1ff)", outline: "none", padding: "0", width: "auto", minWidth: "3em" },
  ".cm-lp-layout-item-add": { flex: "0 0 auto", alignSelf: "flex-start", display: "inline-flex", alignItems: "center", justifyContent: "center", width: "1.6em", height: "1.6em", border: "1px dashed var(--border, #888)", borderRadius: "4px", background: "transparent", color: "var(--fg-dim, #888)", cursor: "pointer", fontSize: "0.9em", lineHeight: "1", padding: "0", opacity: "0", transition: "opacity 120ms" },
  //①: direct-child chains only — the lights from ITS container's wrap state, never an
  // ancestor container's (wrap > .cm-lp-columns > / wrap > .cm-lp-tabs > bar > ).
  ".cm-lp-macro-wrap:hover > .cm-lp-columns > .cm-lp-layout-item-add, .cm-lp-macro-wrap:hover > .cm-lp-tabs > .cm-lp-tabbar > .cm-lp-layout-item-add, .cm-lp-macro-wrap.cm-lp-atom-sel > .cm-lp-columns > .cm-lp-layout-item-add, .cm-lp-macro-wrap.cm-lp-atom-sel > .cm-lp-tabs > .cm-lp-tabbar > .cm-lp-layout-item-add": { opacity: "1" },
  // #278 §2a (rev4): the inline CM6 slot-edit island — an accent-ringed box that replaces the slot's
  // rendered content while its body is edited IN a live-preview mini-editor (the box hugs its content
  // no fixed height,①).③: the ring is an OUTLINE (outside layout), not a border — a border
  // added 1px to the text's x/y so opening the island nudged the content; with an outline + zero editor
  // padding the text keeps its exact rendered position.
  ".cm-lp-slot-edit-island": { flex: "1 1 0", minWidth: "0", outline: "1px solid var(--accent, #4ea1ff)", outlineOffset: "2px", borderRadius: "4px", background: "color-mix(in srgb, var(--accent, #4ea1ff) 4%, var(--panel, #fff))" },
  // #278the island hugs its content (no fixed height,①) so it never actually scrolls
  // overflow: visible lets the -1.5em chrome (the Ctrl+↵ pill on a first-line block) float above the
  // island exactly like top-level instead of being clipped by the scroll box (theclipping that
  // used to force an island-only reposition). No content nudge (③ holds).
  ".cm-lp-slot-edit-island .cm-scroller": { overflow: "visible" },
  // Visible on mouse hover AND when the atom is SELECTED via caret-entry (#174/ADR-087 — the
  // keyboard/vim user sees the edit affordance without a mouse).
  // #278① (the FINAL permanent form): DIRECT-CHILD terms only — a wrap's state reveals its
  // own btnrow chrome / direct edit / retarget / align, and can never reach a nested macro's or an
  // island's chrome (both are deeper descendants by construction). This retires the
  // `:not(island *)` + island-scoped enumeration entirely: one rule shape everywhere.
  ".cm-lp-macro-wrap:hover > .cm-lp-macro-btnrow .cm-lp-macro-edit, .cm-lp-macro-wrap:hover > .cm-lp-macro-btnrow .cm-lp-macro-align, .cm-lp-macro-wrap:hover > .cm-lp-macro-edit, .cm-lp-macro-wrap:hover > .cm-lp-macro-retarget, .cm-lp-macro-wrap:hover > .cm-lp-macro-align, .cm-lp-macro-wrap.cm-lp-atom-sel > .cm-lp-macro-btnrow .cm-lp-macro-edit, .cm-lp-macro-wrap.cm-lp-atom-sel > .cm-lp-macro-btnrow .cm-lp-macro-align, .cm-lp-macro-wrap.cm-lp-atom-sel > .cm-lp-macro-edit, .cm-lp-macro-wrap.cm-lp-atom-sel > .cm-lp-macro-retarget, .cm-lp-macro-wrap.cm-lp-atom-sel > .cm-lp-macro-align": { opacity: "1" },
  // #393 / ADR-151 addendum 3: same opacity reveal for the pipe table's align segment on hover (its wrap
  // is `.cm-lp-table-wrap` for the rendered widget, `.cm-lp-table-edit` while the RichUI island is open
  //wants the whole-table align visible in BOTH states, orthogonal to the toolbar's per-cell align).
  ".cm-lp-table-wrap:hover > .cm-lp-macro-btnrow .cm-lp-macro-align, .cm-lp-table-edit:hover > .cm-lp-macro-btnrow .cm-lp-macro-align": { opacity: "1" },
  // #174 point 3: innermost-wins for the edit ✎. Hovering a NESTED macro slot reveals THAT slot's own ✎;
  // while it does, suppress the CONTAINER's ✎ (its own direct btnrow) so the inner and outer buttons never
  // co-occur. `:has([data-mac-pos]:hover)` scopes it to the container holding the hovered slot; `>` keeps it
  // to the container's own btnrow, so the nested ✎ (appended to the slot, not in the btnrow) is unaffected.
  ".cm-lp-macro-wrap:has([data-mac-pos]:hover) > .cm-lp-macro-btnrow .cm-lp-macro-edit": { opacity: "0", pointerEvents: "none" },
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
  // #424: nested macros use the SAME top-left offset as every other edit affordance (the old
  // -0.9em/-0.4em special case made the button wander between nesting levels).
  ".cm-lp-nested-macro-edit": { position: "absolute", top: "-1.5em", left: "0", opacity: "1", zIndex: "5" },
  // #278point 5: INSIDE a layout cell / tab panel the floated corner controls (-0.9em / -1.55em
  // above their slot) stick out past the container's top edge and get cut (the clipped mermaid toolbar
  // in a tab). Nested contexts pin them INSIDE the slot's top-left corner instead — the container never
  // clips them and they still sit "at the corner" (the user-suggested in-container placement).
  // #424: the old tabpanel/column overrides (top:2px left:2px — an INSIDE-the-block position) are gone;
  // nested affordances sit at the unified block-top-left like everywhere else.
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
  // (#257's structured layout-edit panel CSS removed — the panel itself was retired by #278 §2a and the
  // rules were dead: nothing emits .cm-lp-layout-edit-* any more.)
  // #278H: align-items STRETCH (was flex-start) so a short/EMPTY column follows the row height — its
  // whole box is clickable (opens the island), not just a 1.6em top strip next to a tall neighbour.
  ".cm-lp-columns": { display: "flex", gap: "1.2em", alignItems: "stretch" },
  // #278 §2a / rev4 (④): an EMPTY column must stay comfortably clickable (click = open its inline
  // editor) — a full text line of hit area, not a sliver.
  ".cm-lp-column": { flex: "1 1 0", minWidth: "0", minHeight: "1.6em" },
  // #278H: an EMPTY column / active empty tab panel shows a faint dashed accent frame on hover so the
  // (now full-height, via stretch) clickable slot is DISCOVERABLE — "you can write here". Editor-scoped
  // (baseTheme). The island opens on click as before.
  ".cm-lp-column-empty:hover, .cm-lp-tabpanel-empty.cm-lp-tabpanel-active:hover": { outline: "1px dashed color-mix(in srgb, var(--accent, #4ea1ff) 50%, transparent)", outlineOffset: "-2px", borderRadius: "3px" },
  ".cm-lp-column > :first-child": { marginTop: "0" },
  // #90 tabs: a tab bar + only the active panel shown (display-only switch).
  ".cm-lp-tabbar": { display: "flex", gap: "0.25em", borderBottom: "1px solid var(--border, #888)", marginBottom: "0.6em" },
  // #278G: position:relative anchors the tab's × (below) absolutely so it takes NO flow width — a tab
  // is the same width with or without the × (Reading vs edit modes match). A little right padding gives the
  // hover-shown × a home at the tab's right edge without overlapping the label; it's on ALL tabs (both modes)
  // so widths stay equal.
  // #278④: symmetric padding by default — the 1.9em right ×-slot only exists when the ×
  // actually renders (editable surfaces append .cm-lp-tab-remove; a FRESH read/published render never
  // does, so those tabs had a phantom right gap). :has keeps the editable width stable, × or not.
  // Reading needs the mode-class override below too: switching Live→Reading REUSES the edit-built
  // widget DOM (the × spans survive the display-mode switch — the① lesson), so the DOM alone
  // cannot distinguish the surface there.
  ".cm-lp-tab": { position: "relative", border: "none", background: "transparent", color: "var(--fg-dim, #888)", cursor: "pointer", padding: "0.3em 0.7em", fontSize: "0.9em", borderBottom: "2px solid transparent", marginBottom: "-1px" },
  ".cm-lp-tab:has(.cm-lp-tab-remove)": { paddingRight: "1.9em" },
  // #278④ (Reading): the reading surface is symmetric AND never shows structural-edit chrome
  // the reused edit DOM keeps the ×/ elements (inert via the click-time readOnly gate, but they still
  // revealed on hover and held the ×-slot). readingModeClass stamps the editor root.
  "&.cm-lp-mode-reading .cm-lp-tab": { paddingRight: "0.7em" },
  "&.cm-lp-mode-reading .cm-lp-tab-remove, &.cm-lp-mode-reading .cm-lp-layout-item-remove, &.cm-lp-mode-reading .cm-lp-layout-item-add": { display: "none" },
  ".cm-lp-tab:hover": { color: "var(--fg, inherit)" },
  ".cm-lp-tab-active": { color: "var(--fg, inherit)", borderBottomColor: "var(--accent, #4ea1ff)", fontWeight: "600" },
  ".cm-lp-tabpanel": { display: "none" },
  // #278 rev4 (④): the ACTIVE panel of an empty tab needs the same clickable hit area as an empty
  // column — without it an empty panel is 0px tall and the slot can never be opened.
  ".cm-lp-tabpanel-active": { display: "block", minHeight: "1.6em" },
  ".cm-lp-tabpanel > :first-child": { marginTop: "0" },
  // #196 innermost-wins reveal: while a NESTED child of columns/tabs is being edited, the container
  // descends to raw lines rather than its flex/tab widget — so the caret can sit inside the child. A
  // subtle left rail marks the container/child frame so the structure stays visible ("which layer am I
  // editing"). Display-only line decorations (no widget → no new motion atom); the flex/tab layout
  // returns as soon as the caret leaves the block.
  ".cm-lp-columns-frame, .cm-lp-tabs-frame": { borderLeft: "2px solid var(--border, #888)", paddingLeft: "0.6em" },
  ".cm-lp-column-frame, .cm-lp-tab-frame": { borderLeft: "2px solid color-mix(in srgb, var(--accent, #4ea1ff) 40%, transparent)", paddingLeft: "0.6em" },
  // #90 / #337: the collapsible details container is ONE box (border + radius) that GROWS when opened — the
  // summary bar and the body share the same box, and the body's row animates its height (no separate quoted
  // block appearing below). #337 point 2.
  // #424overflow VISIBLE (was hidden) — the box-level clip existed only for the rounded
  // corners, but it also clipped the unified top-left edit button (top:-1.5em floats ABOVE the box),
  // making it unpaintable/unclickable. Corner clipping moves to the children below.
  ".cm-lp-details-collapsible": { position: "relative", border: "1px solid var(--border, rgba(127,127,127,0.4))", borderRadius: "6px", margin: "0.3em 0" },
  // borderRadius: the corner clip moved here from the box's overflow:hidden (#424) — all
  // corners while CLOSED (the bar IS the box), top corners only when open (rule below).
  ".cm-lp-details-summary": { display: "flex", alignItems: "center", gap: "0.35em", padding: "0.4em 0.7em", cursor: "pointer", color: "var(--fg-dim, #888)", userSelect: "none", fontWeight: "600", borderRadius: "5px" },
  ".cm-lp-details-open .cm-lp-details-summary": { borderRadius: "5px 5px 0 0" },
  ".cm-lp-details-summary:hover": { background: "var(--panel-2, rgba(127,127,127,0.06))" },
  // ONE glyph rotated 90° in the open state (no ▸/▾ text swap). Transitions apply only after mount (the
  // `details-animated` class is added post-paint) so a rebuild / initial render doesn't animate.
  ".cm-lp-details-arrow": { display: "inline-block", flex: "none", transformOrigin: "center", lineHeight: "1" },
  ".cm-lp-details-animated .cm-lp-details-arrow": { transition: "transform 160ms ease" },
  ".cm-lp-details-open .cm-lp-details-arrow": { transform: "rotate(90deg)" },
  // The body wrapper animates its single grid row 0fr↔1fr → the box height grows/shrinks smoothly. The inner
  // body clips (overflow hidden, min-height 0) so its padding is hidden when collapsed.
  ".cm-lp-details-bodywrap": { display: "grid", gridTemplateRows: "0fr" },
  ".cm-lp-details-animated .cm-lp-details-bodywrap": { transition: "grid-template-rows 180ms ease" },
  ".cm-lp-details-open .cm-lp-details-bodywrap": { gridTemplateRows: "1fr" },
  // borderRadius rounds the bottom corners (the clip moved off the box — #424).
  ".cm-lp-details-body": { overflow: "hidden", minHeight: "0", borderRadius: "0 0 5px 5px" }, // grid child clips; NO padding (see above)
  ".cm-lp-details-body-inner": { padding: "0.1em 0.7em 0.55em" },
  ".cm-lp-details-body-inner > :first-child": { marginTop: "0" },
  "@media (prefers-reduced-motion: reduce)": {
    ".cm-lp-details-animated .cm-lp-details-bodywrap, .cm-lp-details-animated .cm-lp-details-arrow": { transition: "none" },
  },
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
  // #256 comment 1035: the DELETE ops (column/row) read in the --danger semantic token so a destructive
  // action is visually distinct from insert/merge/align/no-fill. currentColor drives the SVG stroke, and
  // the hover uses a soft danger tint. --danger is defined for both light and dark (tokens.css).
  ".cm-lp-table-edit-btn-danger": { color: "var(--danger, #cf222e)" },
  ".cm-lp-table-edit-btn-danger:hover": { background: "color-mix(in srgb, var(--danger, #cf222e) 14%, transparent)" },
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

// The public theme = the base theme + the reading-mode root stamp (see readingModeClass above).
export const livePreviewTheme: Extension = [livePreviewBaseTheme, readingModeClass];
