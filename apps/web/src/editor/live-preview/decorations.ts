import { syntaxTree, foldedRanges, foldEffect, unfoldEffect } from "@codemirror/language";
import { Facet, StateField, EditorState, EditorSelection, type Range, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { findFenceMacro, findDirectiveMacro, type FenceMacro, type MacroTheme } from "../macros/registry";
import { fenceLang, fenceBody, macroFenceAt } from "../macros/fence";
import { parseDirectiveOpen } from "../macros/directive-parser";
import { openMacroModal } from "./macro-modal";

// Force a full reload on HMR: this module's decorations/state are baked into the
// EditorView at creation (built once, not re-run on hot-swap), so a hot update would
// leave a STALE editor running old behaviour (a fix wouldn't take effect until a manual
// reload). Self-accept + reload so the running editor always reflects the latest code.
// Dev-only (stripped from prod builds).
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());

// Obsidian-style live preview: hide/style markdown syntax via CodeMirror
// decorations.
//
// INVARIANT (ADR-008 — the one non-obvious interaction in this surface):
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
// depends on the surface, supplied via this facet:
//   - { mode: "edit" }            editable draft surface → flip the char in the doc
//                                 directly (a normal offset-invariant Y.Text edit).
//   - { mode: "view", onToggle }  read-only published surface → the host persists it
//                                 (flip the live draft over its collab connection +
//                                 the no-revision endpoint). See Editor.tsx.
//   - null                        no edit permission → rendered DISABLED (display only;
//                                 the server is the bastion regardless — D3).
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

// Image attachments are referenced in the canonical Y.Text by a STABLE id —
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

// Renders a GFM table block as an HTML <table>. Cells are set via textContent —
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
  toDOM() {
    const table = document.createElement("table");
    table.className = "cm-lp-table";
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

// Resolve the active theme for a macro's render. Read from <html data-theme> (set by
// ThemeProvider); "system" (or unset) falls back to the OS preference.
function currentMacroTheme(): MacroTheme {
  const t = document.documentElement.dataset.theme;
  if (t === "dark") return "dark";
  if (t === "light") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
class MacroWidget extends WidgetType {
  constructor(readonly macro: FenceMacro, readonly body: string) {
    super();
  }
  eq(other: MacroWidget) {
    return other.macro === this.macro && other.body === this.body;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-macro-wrap";
    wrap.appendChild(this.macro.liveRender(this.body, { theme: currentMacroTheme() }));
    if (!view.state.readOnly) {
      // Click the rendered macro → put the caret at the block start, which reveals the
      // raw source for editing. (CM maps a click on an opaque block widget to the
      // position AFTER it, which wouldn't reveal; we place it explicitly.) The fold
      // button stops propagation so its clicks don't reveal. Offset-invariant.
      wrap.addEventListener("mousedown", (e) => {
        e.preventDefault();
        view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(wrap)) });
        view.focus();
      });
      // Rich-edit (modal) button — only for macros that declare one (e.g. Excalidraw).
      if (this.macro.richEditUI?.present === "modal") {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "cm-lp-macro-edit";
        edit.title = "Edit";
        edit.textContent = "✎";
        edit.setAttribute("data-testid", "macro-edit");
        edit.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openMacroModal(view, this.macro, () => view.posAtDOM(wrap), currentMacroTheme());
        });
        wrap.appendChild(edit);
      }
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
        if (rangeRevealed(ctx.state, from, to)) return;
        ctx.addAtomic(Decoration.replace({ widget: new MacroWidget(macro, fenceBody(doc, node.from, node.to)), block: true }), from, to);
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
      const box = Decoration.line({ attributes: { class: macro.containerClass } });
      const first = doc.lineAt(node.from).number;
      const last = doc.lineAt(Math.max(node.from, Math.min(node.to, doc.length) - 1)).number;
      for (let n = first; n <= last; n++) ctx.add(box, doc.line(n).from);
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

// A StateField (NOT a ViewPlugin): block decorations — the table render uses one —
// may only be provided by a state field, not a plugin. Rebuilds on any doc change
// (covers local edits AND remote Yjs updates applied by yCollab) and any selection
// change (reveal-on-cursor). Provides the decoration set, the atomicRanges (so local
// cursor motion skips hidden markers), and the collapsed-block ranges (for blockEntry).
export const livePreview = StateField.define<{ decorations: DecorationSet; atomic: DecorationSet; blocks: { from: number; to: number }[] }>({
  create: (state) => buildDecorations(state),
  update: (value, tr) => {
    if (tr.docChanged || tr.selection) return buildDecorations(tr.state);
    // A fold toggle changes WHICH macro blocks render (folded → CM's placeholder owns
    // the range, so the macro widget must drop) but is neither a doc nor selection
    // change — rebuild so isFolded() is re-evaluated and the stale widget is removed.
    for (const e of tr.effects) if (e.is(foldEffect) || e.is(unfoldEffect)) return buildDecorations(tr.state);
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
// it. Operates on the selection, so it covers BOTH arrow keys AND vim j/k uniformly —
// the single principle for every block (and every future container macro), not a
// per-block hack. Display-only: never changes the document (ADR-008; presence intact).
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
  const dir = newHead < oldHead ? -1 : 1;
  const adj = oldLine + dir;
  if (adj < 1 || adj > doc.lines) return tr;
  for (const b of blocks) {
    const first = doc.lineAt(b.from).number;
    const last = doc.lineAt(b.to).number;
    if (oldLine >= first && oldLine <= last) break; // caret was inside this block
    if (adj >= first && adj <= last) {
      // a one-line step lands on this collapsed block's near edge → put the caret on
      // that source line (revealing it) instead of letting CM skip the whole block
      if (doc.lineAt(newHead).number !== adj) {
        return { selection: EditorSelection.cursor(doc.line(adj).from), scrollIntoView: true };
      }
      return tr;
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
  ".cm-lp-macro-empty": { color: "var(--fg-dim, #888)", fontStyle: "italic", padding: "0.6em" },
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
});
