import { syntaxTree, foldedRanges, foldEffect, unfoldEffect } from "@codemirror/language";
import { Facet, StateField, EditorState, EditorSelection, Prec, type Range, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { findFenceMacro, findDirectiveMacro, type FenceMacro, type MacroTheme } from "../macros/registry";
import { fenceLang, fenceBody, macroFenceAt, tableBlockAt } from "../macros/fence";
import { currentMacroTheme } from "../macros/theme";
import { parseDirectiveOpen } from "../macros/directive-parser";
import { openMacroModal } from "./macro-modal";
import { macroRenderActiveField, setMacroRenderActive } from "./macro-edit";
import { TableEditWidget } from "./table-edit";

// Whether the vim keymap is active. Set from the vim Compartment (Editor.tsx) so the
// state-only decoration builder can be mode-aware (ADR-022 Part 11): non-vim renders
// rich-editable macros always (never reveal-on-cursor); vim keeps reveal-on-cursor.
export const vimEnabled = Facet.define<boolean, boolean>({ combine: (v) => (v.length ? v[v.length - 1]! : false) });

// Reveal-on-cursor for MACROS is vim-only — non-vim renders EVERY macro, always (the
// user's invariant: " vim render"). This applies to non-rich macros too
// (mermaid/callout): in non-vim they render and are read-only there; edit their source in
// vim. (An earlier version kept `!richEditable || vim`, which let mermaid reveal in non-vim
// — so vim→non-vim left a mermaid under the caret as raw source. That was the #5 hole.)
function revealAllowed(state: EditorState): boolean {
  return state.facet(vimEnabled);
}

// Mode-based rich edit (ADR-022 Part 11): a CLICK on a table enters edit mode in BOTH
// modes (the mouse is independent of vim; vim still reveals on the keyboard). Returns true
// if it entered edit mode (caller preventDefaults so the caret isn't also placed).
function tryEnterTableEdit(view: EditorView, pos: number): boolean {
  const tb = tableBlockAt(view.state, pos);
  if (!tb) return false;
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
const codeBlockLine = Decoration.line({ attributes: { class: "cm-lp-code-line" } });
const quoteLine = Decoration.line({ attributes: { class: "cm-lp-quote" } });
const hrLine = Decoration.line({ attributes: { class: "cm-lp-hr" } });

class BulletWidget extends WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-lp-bullet";
    span.textContent = "•";
    return span;
  }
  eq() {
    return true;
  }
}
const bullet = Decoration.replace({ widget: new BulletWidget() });

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
    box.disabled = !ctl;
    if (ctl) {
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
const ATTACHMENT_REF = /^!\[([^\]]*)\]\(wks-attachment:([^)\s]+)\)$/;

// Renders an image from a wks-attachment reference. src is filled in
// asynchronously from the resolver; on load error (e.g. the presigned URL
// expired) it re-resolves ONCE (refresh) before giving up — TTL caching means a
// repeated image still costs one resolve while the URL is valid.
class ImageWidget extends WidgetType {
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
    return img;
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
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
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
  constructor(readonly source: string) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source;
  }
  toDOM(view: EditorView) {
    const table = document.createElement("table");
    table.className = "cm-lp-table";
    // Non-vim: a click enters edit mode directly (#5); vim leaves it to reveal raw.
    table.addEventListener("mousedown", (e) => {
      if (tryEnterTableEdit(view, view.posAtDOM(table))) e.preventDefault();
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
        cell.textContent = c; // XSS-safe: text, not HTML
        tr.appendChild(cell);
      }
      (inBody ? tbody : thead).appendChild(tr);
    }
    if (thead.childNodes.length) table.appendChild(thead);
    if (tbody.childNodes.length) table.appendChild(tbody);
    return table;
  }
  ignoreEvent() {
    return false; // let clicks through so the cursor can enter (→ reveal raw)
  }
}

// If the table block at [from, to] is render-active (toggled into edit mode, ADR-022
// Part 11), emit the editable table widget (cell-merge UI) and return true so the caller
// skips its read render. Safe when the field is absent (read-only surface).
function tryTableEdit(ctx: RenderCtx, from: number, to: number): boolean {
  const active = ctx.state.field(macroRenderActiveField, false);
  if (!active || active.from > to || active.to < from) return false;
  const tb = tableBlockAt(ctx.state, from);
  if (!tb) return false;
  ctx.addAtomic(Decoration.replace({ widget: new TableEditWidget(tb.grid, tb.from, tb.to), block: true }), tb.from, tb.to);
  return true;
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
type RenderableMacro = { liveRender: (body: string, ctx: { theme: MacroTheme }) => HTMLElement; richEditUI?: import("../macros/registry").RichEditUI };
class MacroWidget extends WidgetType {
  constructor(readonly macro: RenderableMacro, readonly body: string, readonly foldable: boolean, readonly name: string) {
    super();
  }
  eq(other: MacroWidget) {
    return other.macro === this.macro && other.body === this.body && other.foldable === this.foldable && other.name === this.name;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-macro-wrap";
    // #3: an empty macro renders NOTHING from some liveRenders (e.g. mermaid) → it looks
    // like blank space even though a block widget occupies it (so vertical caret motion
    // "jumps" past invisible content). Render a common, visible placeholder for ALL macros
    // when the body is empty, so the block is obviously present and obviously editable.
    if (this.body.trim() === "") {
      const ph = document.createElement("div");
      ph.className = "cm-lp-macro cm-lp-macro-empty";
      ph.setAttribute("data-testid", "macro-empty");
      ph.textContent = `Empty ${this.name} — click to edit`;
      wrap.appendChild(ph);
    } else {
      wrap.appendChild(this.macro.liveRender(this.body, { theme: currentMacroTheme() }));
    }
    if (!view.state.readOnly) {
      // Click the rendered macro → put the caret at the block start, which reveals the
      // raw source for editing. (CM maps a click on an opaque block widget to the
      // position AFTER it, which wouldn't reveal; we place it explicitly.) The fold
      // button stops propagation so its clicks don't reveal. Offset-invariant.
      // Mode-based click launch (ADR-022 Part 11): clicking a rich-editable macro opens
      // its editor in BOTH modes — inline (table) enters cell-edit, modal (Excalidraw)
      // opens the modal. A macro without a richEditUI places the caret (reveal raw source).
      wrap.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const present = this.macro.richEditUI?.present;
        if (present === "modal") { openMacroModal(view, this.macro as FenceMacro, () => view.posAtDOM(wrap), currentMacroTheme()); return; }
        if (present === "inline" && tryEnterTableEdit(view, view.posAtDOM(wrap))) return;
        view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(wrap)) });
        view.focus();
      });
      if (this.foldable) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cm-lp-macro-fold";
      btn.title = "Collapse";
      btn.textContent = "⊟";
      btn.setAttribute("data-testid", "macro-fold");
      // mousedown + preventDefault: keep the selection where it is (don't place the
      // caret into the block, which would reveal raw) and fold the block's range. Use
      // the button's screen position → doc pos (robust for a block widget) → the fence.
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // posAtDOM maps the block widget's DOM to its start offset (posAtCoords would
        // map to the line after the block — wrong for a block replace widget).
        const fence = macroFenceAt(view.state, view.posAtDOM(wrap));
        if (fence) view.dispatch({ effects: foldEffect.of({ from: fence.from, to: fence.to }) });
      });
      wrap.appendChild(btn);
      }
    }
    return wrap;
  }
  ignoreEvent() {
    return false; // clicks pass through so the cursor can enter → reveal raw
  }
}

// A construct's syntax markers reveal (become editable raw text) when the main
// selection touches the range the marker sits on — matching Obsidian's per-line
// reveal. This only changes rendering, never offsets.
//
// Reveal exists so you can edit the raw markdown under your cursor. In a READ-ONLY
// surface (the default "view" mode) there is nothing to edit, so NOTHING is ever
// revealed — otherwise the view's default selection (position 0) would reveal any
// first-line construct (a leading image, heading, or table) as raw markdown.
function rangeRevealed(state: EditorState, from: number, to: number): boolean {
  if (state.readOnly) return false;
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}
function lineRevealed(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return rangeRevealed(state, line.from, line.to);
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
  // Style a range (mark decoration) or a whole line (line decoration at line.from
  // — pass only `from`). Cannot change document length.
  add(deco: Decoration, from: number, to?: number): void;
  // Hide a syntax marker unless the cursor is on its line; also feeds atomicRanges
  // so local cursor motion skips it cleanly. Display-only (never mutates the doc).
  hideMarker(from: number, to: number, deco?: Decoration): void;
  // Add a decoration AND mark its range atomic (fed to EditorView.atomicRanges). Used
  // for collapsed BLOCK widgets (table, image, future macros) so cursor motion snaps to
  // the block's boundary — which the reveal-on-cursor check treats as overlapping, so
  // arrowing/`j`/`k` into the block reveals its raw source instead of skipping it.
  addAtomic(deco: Decoration, from: number, to: number): void;
}

// Minimal structural view of a syntax-tree node — what renderers need. A real
// @lezer SyntaxNodeRef (what tree.iterate yields) satisfies this, so we avoid a
// direct @lezer/common dependency just for the type.
export interface RenderNode {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly node: { readonly parent: { readonly parent: { readonly name: string } | null } | null };
}

export interface BlockRenderer {
  match(name: string): boolean;
  enter(node: RenderNode, ctx: RenderCtx): void;
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
        // Folded → CM's fold placeholder owns the range. Caret inside → reveal raw
        // source (editable). Otherwise → the rendered macro (a collapsed block widget,
        // entered via blockEntry like table/image).
        if (isFolded(ctx.state, from, to)) return;
        // Reveal source on the caret only in vim; non-vim always renders the macro (#5).
        if (revealAllowed(ctx.state) && rangeRevealed(ctx.state, from, to)) return;
        ctx.addAtomic(Decoration.replace({ widget: new MacroWidget(macro, fenceBody(doc, node.from, node.to), true, lang!), block: true }), from, to);
        return;
      }
      const first = doc.lineAt(node.from).number;
      const last = doc.lineAt(Math.min(node.to, doc.length)).number;
      // Tint only the CODE lines, not the ``` / ~~~ fence lines (those would render
      // as empty tinted bars once their CodeMark hides — visually redundant).
      for (let n = first; n <= last; n++) {
        const line = doc.line(n);
        const t = line.text.trimStart();
        if (t.startsWith("```") || t.startsWith("~~~")) continue;
        ctx.add(codeBlockLine, line.from);
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
      const open = parseDirectiveOpen(doc.lineAt(node.from).text);
      const macro = open ? findDirectiveMacro(open.name) : undefined;
      if (!macro) return;
      const first = doc.lineAt(node.from);
      const lastLine = doc.lineAt(Math.max(node.from, Math.min(node.to, doc.length) - 1));
      if (macro.liveRender) {
        // BLOCK directive (table): render the body as a widget, reveal raw on cursor
        // like a fence macro (not foldable). Body = lines between the ::: fences.
        const from = first.from;
        const to = lastLine.to;
        if (tryTableEdit(ctx, from, to)) return; // render-active → cell-merge edit mode
        if (revealAllowed(ctx.state) && rangeRevealed(ctx.state, from, to)) return; // vim-only reveal (#5)
        const parts: string[] = [];
        for (let n = first.number + 1; n < lastLine.number; n++) parts.push(doc.line(n).text);
        ctx.addAtomic(Decoration.replace({ widget: new MacroWidget({ liveRender: macro.liveRender, richEditUI: macro.richEditUI }, parts.join("\n"), false, open!.name), block: true }), from, to);
        return;
      }
      if (macro.containerClass) {
        // CONTAINER directive (callout): a CSS box over every line; content stays markdown.
        const box = Decoration.line({ attributes: { class: macro.containerClass } });
        for (let n = first.number; n <= lastLine.number; n++) ctx.add(box, doc.line(n).from);
      }
    },
  },
  // The :::name / ::: fence lines: hide (reveal raw on the cursor's line, like every
  // other marker). hideMarker also makes the range atomic for clean cursor motion.
  { match: (n) => n === "DirectiveMark", enter: (node, ctx) => ctx.hideMarker(node.from, node.to) },
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
      // Replace "-"/"*" with a bullet glyph (space stays). OrderedList keeps "1.".
      if (list === "BulletList") ctx.hideMarker(node.from, node.to, bullet);
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
  { match: (n) => n === "LinkMark" || n === "URL", enter: (node, ctx) => ctx.hideMarker(node.from, node.to) },
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
      const to = doc.lineAt(Math.max(node.from, Math.min(node.to, doc.length) - 1)).to;
      // Reveal raw source while the cursor is anywhere in the block's range. The block
      // can't be ENTERED by vertical motion (it's a collapsed widget) — the blockEntry
      // transaction filter redirects motion that would skip it INTO it, then these lines
      // are real and j/k/arrows traverse them one at a time.
      if (tryTableEdit(ctx, from, to)) return; // render-active → cell-merge edit mode (promote)
      // GFM pipe table keeps reveal-on-cursor in BOTH modes (it's hand-typeable Markdown);
      // a click still enters the rich edit. (Only :::table/Excalidraw — non-typeable macros
      // — are non-vim-always-render, #5.)
      if (rangeRevealed(ctx.state, from, to)) return;
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

function buildDecorations(state: EditorState): {
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
    add: (deco, from, to = from) => all.push(deco.range(from, to)),
    hideMarker: (from, to, deco = hide) => {
      if (from >= to) return;
      if (lineRevealed(state, from)) return;
      all.push(deco.range(from, to));
      hidden.push(hide.range(from, to));
    },
    addAtomic: (deco, from, to) => {
      if (from >= to) return;
      all.push(deco.range(from, to));
      hidden.push(hide.range(from, to));
      blocks.push({ from, to });
    },
  };

  syntaxTree(state).iterate({
    enter: (node) => {
      // Mutually-exclusive matches by node name; descend by default (return void)
      // so child markers (HeaderMark, CodeMark, LinkMark/URL) are still visited.
      for (const r of RENDERERS) if (r.match(node.name)) r.enter(node, ctx);
    },
  });

  return {
    decorations: Decoration.set(all, true),
    atomic: Decoration.set(hidden, true),
    blocks,
  };
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
    // Toggling vim is a Compartment reconfigure — no doc/selection/effect change — but it
    // flips reveal-on-cursor gating (revealAllowed): vim→non-vim must re-render every
    // rich-editable macro that was revealed under the caret. Rebuild on the facet change.
    if (tr.startState.facet(vimEnabled) !== tr.state.facet(vimEnabled)) return buildDecorations(tr.state);
    // A fold toggle changes WHICH macro blocks render (folded → CM's placeholder owns
    // the range, so the macro widget must drop) but is neither a doc nor selection
    // change — rebuild so isFolded is re-evaluated and the stale widget is removed.
    for (const e of tr.effects) if (e.is(foldEffect) || e.is(unfoldEffect) || e.is(setMacroRenderActive)) return buildDecorations(tr.state);
    return value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
  ],
});

// Block entry: a collapsed block (table / image / hr) is a replace widget the caret
// cannot land INSIDE by vertical motion — it skips over (the bug: tables/hr were
// un-enterable, the caret overtook them). This filter watches caret-only moves: if the
// move would skip a still-collapsed block, it redirects the caret to the block's near
// edge instead. Landing there reveals the block (rangeRevealed), so its source lines
// become real and j/k/arrows then traverse them one at a time; moving out re-collapses
// it. Operates on the selection, so it covers BOTH arrow keys AND vim j/k uniformly
// the single principle for every block (and every future container macro), not a
// per-block hack. Display-only: never changes the document (ADR-008; presence intact).
// A block widget taller than one line can make CM's vertical motion (and vim j/k)
// OVERSHOOT from a line below it — moving up one line lands the caret inside/before the
// widget's atomic range and gets bumped past it, skipping the real adjacent line (the
// "tall block breaks vertical geometry" class of bug). blockEntry clamps that, but only
// for a genuine ONE-LINE key — a jump (gg/G/5G) or a wrapped-line step must be left
// alone. We record whether the last key was a single-line vertical motion here.
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

export const blockEntry: Extension = EditorState.transactionFilter.of((tr) => {
  if (tr.docChanged || !tr.selection) return tr;
  const blocks = tr.startState.field(livePreview, false)?.blocks;
  if (!blocks?.length) return tr;
  const oldSel = tr.startState.selection.main;
  const newSel = tr.newSelection.main;
  // Only a caret/block MOTION, not a selection expansion: an empty caret, or vim's
  // normal-mode block cursor (a 1-char selection that RELOCATES — its anchor moves with
  // its head). A shift/visual selection keeps its anchor fixed → leave it alone.
  if (!newSel.empty && newSel.anchor === oldSel.anchor) return tr;
  const doc = tr.startState.doc;
  const oldHead = oldSel.head;
  const newHead = newSel.head;
  if (newHead === oldHead) return tr;
  // Only handle a ONE-LINE step (j/k/arrow): the immediately-adjacent document line in
  // the motion's direction. A big jump (gg/G/}/click) whose adjacent line is NOT a
  // collapsed block is left alone — it lands at its target (which reveals the block if
  // the target is inside one). This is what keeps `gg` going to the top, not the table
  // edge, while a single k/j still steps INTO the block instead of skipping over it.
  const oldLine = doc.lineAt(oldHead).number;
  const newLine = doc.lineAt(newHead).number;
  const dir = newHead < oldHead ? -1 : 1;
  // Redirect ONLY a one-line step that skipped EXACTLY one block: the caret started on
  // the block's near edge and CM landed it on the block's FAR edge (it jumped over the
  // collapsed widget). Then put the caret on the block's near source line so it reveals
  // and j/k traverse it line-by-line. A multi-line jump (gg/G/}/click) does NOT match
  // its newHead isn't the block's far edge — so it lands at its real target (gg/G are no
  // longer hijacked when a macro happens to sit one line away). Entry from below lands on
  // the block's last line; from above, its first line.
  for (const b of blocks) {
    const first = doc.lineAt(b.from).number;
    const last = doc.lineAt(b.to).number;
    if (oldLine >= first && oldLine <= last) break; // caret was inside this block
    if (dir === 1 && oldLine === first - 1 && newLine === last + 1 && newLine !== first) {
      return { selection: EditorSelection.cursor(doc.line(first).from), scrollIntoView: true };
    }
    if (dir === -1 && oldLine === last + 1 && newLine === first - 1 && newLine !== last) {
      return { selection: EditorSelection.cursor(doc.line(last).from), scrollIntoView: true };
    }
  }
  // Overshoot clamp (#4): a single-line vertical KEY that skipped a tall block (a block
  // lies strictly between oldLine and newLine) must move exactly one line — clamp to the
  // adjacent line (revealing the block if that line IS the block). Gated on a real motion
  // key so jumps and wrapped-line steps are untouched.
  if (lastVerticalStep) {
    const adj = oldLine + dir;
    if (adj >= 1 && adj <= doc.lines && newLine !== adj) {
      const lo = Math.min(oldLine, newLine), hi = Math.max(oldLine, newLine);
      const skipped = blocks.some((b) => {
        const f = doc.lineAt(b.from).number, l = doc.lineAt(b.to).number;
        return f >= lo && l <= hi && !(oldLine >= f && oldLine <= l);
      });
      if (skipped) return { selection: EditorSelection.cursor(doc.line(adj).from), scrollIntoView: true };
    }
  }
  return tr;
});

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
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    background: "rgba(127,127,127,0.18)",
    borderRadius: "3px",
    padding: "0 3px",
  },
  ".cm-lp-link": { color: "#4ea1ff", textDecoration: "underline" },
  // In the read-only render links are click-to-open, so show the affordance there.
  ".cm-content[contenteditable=false] .cm-lp-link[data-href]": { cursor: "pointer" },
  ".cm-lp-h": { fontWeight: "700", lineHeight: "1.3" },
  ".cm-lp-h1": { fontSize: "1.8em" },
  ".cm-lp-h2": { fontSize: "1.5em" },
  ".cm-lp-h3": { fontSize: "1.3em" },
  ".cm-lp-h4": { fontSize: "1.15em" },
  ".cm-lp-h5": { fontSize: "1.05em" },
  ".cm-lp-h6": { fontSize: "1em", opacity: "0.85" },
  ".cm-lp-code-line": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    background: "rgba(127,127,127,0.12)",
  },
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
  // Task checkbox: replaces the raw `[ ]`/`[x]`. Sits inline with the list text; the
  // accent cursor signals it is clickable (disabled = read-only, no edit permission).
  ".cm-lp-checkbox": { verticalAlign: "middle", margin: "0 0.35em 0 0", cursor: "pointer", accentColor: "var(--accent)" },
  ".cm-lp-checkbox:disabled": { cursor: "default", opacity: "0.7" },
  ".cm-lp-table": { borderCollapse: "collapse", margin: "0.4em 0", fontSize: "0.95em" },
  ".cm-lp-table th, .cm-lp-table td": {
    border: "1px solid var(--border, #444)",
    padding: "3px 8px",
    textAlign: "left",
  },
  ".cm-lp-table th": { background: "rgba(127,127,127,0.12)", fontWeight: "700" },
  ".cm-lp-image": { maxWidth: "100%", height: "auto", borderRadius: "4px", verticalAlign: "bottom" },
  // Macro block (e.g. ```mermaid). The wrap is relative so the fold button can sit in
  // a corner; the rendered DOM is whatever the macro's liveRender returns.
  ".cm-lp-macro-wrap": { position: "relative", margin: "0.4em 0" },
  ".cm-lp-macro": { display: "block", overflowX: "auto" },
  // pointer-events:none on the SVG so a click on the diagram falls through to the macro
  // container (CM then places the caret → reveal-on-cursor shows the raw source). An
  // SVG-internal click can't be mapped to a doc position, so without this clicking a
  // diagram wouldn't reveal it. Scoped to the svg so the container stays hoverable
  // (the fold button shows on hover).
  ".cm-lp-mermaid svg": { maxWidth: "100%", height: "auto", pointerEvents: "none" },
  ".cm-lp-macro-error": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "var(--danger, #c00)",
    background: "rgba(127,127,127,0.12)",
    borderRadius: "4px",
    padding: "0.4em 0.6em",
  },
  ".cm-lp-macro-fold, .cm-lp-macro-edit": {
    position: "absolute",
    top: "4px",
    border: "1px solid var(--border, #888)",
    borderRadius: "4px",
    background: "var(--panel, #fff)",
    color: "var(--fg-dim, #888)",
    cursor: "pointer",
    fontSize: "0.8em",
    lineHeight: "1",
    padding: "2px 5px",
    opacity: "0",
    transition: "opacity 120ms",
  },
  ".cm-lp-macro-fold": { right: "4px" },
  ".cm-lp-macro-edit": { right: "30px" }, // sits left of the fold button
  ".cm-lp-macro-wrap:hover .cm-lp-macro-fold, .cm-lp-macro-wrap:hover .cm-lp-macro-edit": { opacity: "1" },
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
  // ::: callout directive: a tinted box with an accent left bar. Applied per line
  // (the fence lines are hidden → empty padding rows inside the box). The content
  // stays live-preview Markdown.
  ".cm-lp-callout": {
    borderLeft: "3px solid var(--accent, #4ea1ff)",
    background: "rgba(127,127,127,0.08)",
    paddingLeft: "0.8em",
  },
  // Table cell-merge edit mode (render-active): a toolbar + selectable cells.
  ".cm-lp-table-edit": { position: "relative", margin: "0.4em 0", border: "1px solid var(--accent, #4ea1ff)", borderRadius: "4px", padding: "4px" },
  // Floating contextual toolbar — positioned above the selected cell, over the table.
  ".cm-lp-table-edit-bar": {
    position: "absolute",
    zIndex: "5",
    display: "flex",
    alignItems: "center", // #4: swatches line up with the icon buttons
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
  ".cm-lp-table-grid th.cm-lp-table-handle:hover": { background: "var(--accent, #4ea1ff)", color: "#fff" },
  ".cm-lp-table-grid .cm-lp-table-colhandle": { minWidth: "16px", height: "16px" },
  ".cm-lp-table-grid .cm-lp-table-rowhandle": { width: "22px" },
  ".cm-lp-table-grid .cm-lp-table-corner": { width: "22px", height: "16px", borderTopLeftRadius: "5px" },
  // The trailing "+" add-column / add-row handles read as actions (dashed, accent hint).
  ".cm-lp-table-grid .cm-lp-table-addcol, .cm-lp-table-grid .cm-lp-table-addrow": {
    background: "transparent",
    border: "1px dashed var(--border, #888)",
    color: "var(--fg-dim, #777)",
    fontSize: "12px",
    fontWeight: "700",
  },
  ".cm-lp-table-grid .cm-lp-table-addcol:hover, .cm-lp-table-grid .cm-lp-table-addrow:hover": { background: "var(--accent, #4ea1ff)", color: "#fff", borderStyle: "solid" },
  // Structural-op group in the toolbar (insert/delete col/row) — visually separated.
  ".cm-lp-table-ops": { display: "inline-flex", gap: "2px", alignItems: "center", borderLeft: "1px solid var(--border, #888)", paddingLeft: "4px", marginLeft: "2px" },
  // Selection: a translucent THEME-accent fill on each cell (#1 — must read as selected,
  // in the active theme color, not a fixed blue); a thick accent border only on the OUTER
  // edges (per-side classes) — the spreadsheet look. Prefixed to beat the base cell rules.
  ".cm-lp-table-grid .cm-lp-cell-sel": { background: "color-mix(in srgb, var(--accent, #4ea1ff) 24%, transparent)" },
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
