import { EditorView, ViewPlugin, showTooltip, keymap, type Tooltip, type TooltipView } from "@codemirror/view";
import { StateField, StateEffect, EditorSelection, Facet, Prec, type EditorState, type Extension } from "@codemirror/state";
import { getCM } from "@replit/codemirror-vim";
import i18n from "../../i18n";
import { INLINE_FORMATS, insertImage, type InlineFormat, type ImageUploader } from "./commands";

// Slash command palette (Step I / M0-1 — see ADR-017). Triggered by `/` at a line
// start OR after whitespace while editing. Lists block insert/toggle commands (layer
// B/C); choosing one removes the typed "/query" token and inserts a plain-Markdown
// TEMPLATE into the canonical Y.Text, placing the caret at the template's content
// position. Offset-invariant and presence-safe (ADR-008), never a special node. Built
// on CodeMirror's tooltip layer (NOT React, NOT cmdk): the editor owns no React
// (ADR-013), and CM reconciles away nodes injected into view.dom (see the floating
// toolbar), so the palette lives in the managed tooltip layer.

interface PaletteCommand {
  id: string;
  label: () => string; // JP display name
  alias: string; // short English name shown small AND used for filtering (no IME switch)
  keywords: string; // extra English filter terms (lowercase)
  insert: string; // the Markdown template inserted in place of the "/query" token
  caret: number | [number, number]; // caret offset (or selection range) within `insert`
  action?: (view: EditorView) => void; // custom action instead of a template insert (e.g. image picker)
}

// Holds the image-insert trigger (opening the host's file picker), supplied by
// slashPalette when an uploader is available. The `/image` command reads it, and its
// presence GATES the command's visibility — guests / uploader-less surfaces never see
// it. Image is layer P (insert, selection-independent), so it lives ONLY here, never in
// the on-selection menus (ADR-018: selection menu = decoration A only).
const imageUploader = Facet.define<(() => void) | null, (() => void) | null>({
  combine: (vals) => vals.find((v) => v != null) ?? null,
});

// Layer B/C/P commands. Template commands place the caret where you'd type the content
// next; the image command (P) runs an action (open the file picker) instead. (Inline
// decorations — layer A — are the decorate palette below.)
const COMMANDS: PaletteCommand[] = [
  { id: "h1", label: () => i18n.t("palette.h1"), alias: "h1", keywords: "heading title #", insert: "# ", caret: 2 },
  { id: "h2", label: () => i18n.t("palette.h2"), alias: "h2", keywords: "heading subtitle ##", insert: "## ", caret: 3 },
  { id: "h3", label: () => i18n.t("palette.h3"), alias: "h3", keywords: "heading ###", insert: "### ", caret: 4 },
  { id: "ul", label: () => i18n.t("palette.bulletList"), alias: "list", keywords: "bullet unordered dash", insert: "- ", caret: 2 },
  { id: "ol", label: () => i18n.t("palette.numberedList"), alias: "1. list", keywords: "numbered ordered", insert: "1. ", caret: 3 },
  { id: "quote", label: () => i18n.t("palette.quote"), alias: "quote", keywords: "blockquote citation", insert: "> ", caret: 2 },
  { id: "code", label: () => i18n.t("palette.codeBlock"), alias: "code", keywords: "code block fenced pre", insert: "```\n\n```", caret: 4 },
  { id: "table", label: () => i18n.t("palette.table"), alias: "table", keywords: "grid", insert: "| Column | Column |\n| --- | --- |\n| Cell | Cell |", caret: [2, 8] },
  // `***` (not `---`): `---` under a line of text is a setext H2 underline, so it would
  // turn the line above into a heading. `***` is always a thematic break (hr).
  { id: "divider", label: () => i18n.t("palette.divider"), alias: "divider", keywords: "rule hr separator line", insert: "***\n", caret: 4 },
];

// Image insert (layer P). Moved here from the selection bubble (was M0-5, pulled forward)
// so the on-selection menu is decoration-only and identical across vim/non-vim. The token
// is removed, then the action opens the host's file picker; the upload → ![alt](ref) lands
// at the caret (see imageInsert).
const IMAGE_COMMAND: PaletteCommand = {
  id: "image",
  label: () => i18n.t("palette.image"),
  alias: "image",
  keywords: "img picture photo attachment upload",
  insert: "",
  caret: 0,
  action: (view) => view.state.facet(imageUploader)?.(),
};

// The effective command list for a state: the image command is appended only when an
// uploader is wired (the facet is set), so it never appears for uploader-less surfaces.
function commandList(state: EditorState): PaletteCommand[] {
  return state.facet(imageUploader) ? [...COMMANDS, IMAGE_COMMAND] : COMMANDS;
}

function filterCommands(state: EditorState, query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  const list = commandList(state);
  if (!q) return list;
  return list.filter(
    (c) => c.label().toLowerCase().includes(q) || c.alias.toLowerCase().includes(q) || c.keywords.includes(q),
  );
}

interface PaletteState { from: number; query: string; index: number }

const moveSelection = StateEffect.define<number>(); // +1 / -1
const dismissPalette = StateEffect.define<null>();

// Esc dismissal: held in a tiny companion field so the palette can be hidden without
// removing the typed text. Any further typing (docChanged) re-arms it.
const dismissedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    if (tr.effects.some((e) => e.is(dismissPalette))) return true;
    if (tr.docChanged) return false;
    return value;
  },
});

// Is the cursor right after a "/query" token whose `/` is at line start OR preceded by
// whitespace (so prose like "and/or" never fires, but "# heading /" and line-start do)?
function detect(state: EditorView["state"]): { from: number; query: string } | null {
  if (state.readOnly) return null;
  const sel = state.selection.main;
  if (!sel.empty) return null; // decoration-on-selection is M0-2
  const line = state.doc.lineAt(sel.head);
  const before = state.doc.sliceString(line.from, sel.head);
  const m = /(?:^|\s)\/([\p{L}\p{N}-]*)$/u.exec(before);
  if (!m) return null;
  const query = m[1] ?? "";
  return { from: sel.head - query.length - 1, query }; // position of the "/"
}

const paletteField = StateField.define<PaletteState | null>({
  create: () => null,
  update(value, tr) {
    if (tr.state.field(dismissedField)) return null;
    const d = detect(tr.state);
    if (!d) return null;
    const matches = filterCommands(tr.state, d.query);
    if (matches.length === 0) return null; // no command → behave as plain text
    let index = value && value.query === d.query ? value.index : 0;
    for (const e of tr.effects) if (e.is(moveSelection)) index += e.value;
    index = ((index % matches.length) + matches.length) % matches.length; // wrap
    return { from: d.from, query: d.query, index };
  },
  provide: (f) =>
    showTooltip.computeN([f, dismissedField], (state) => {
      const v = state.field(f);
      return v ? [paletteTooltip(f, v.from)] : [];
    }),
});

function applyAt(view: EditorView, cmd: PaletteCommand): void {
  const v = view.state.field(paletteField);
  if (!v) return;
  const head = view.state.selection.main.head;
  if (cmd.action) {
    // Action command (e.g. image): remove the "/query" token, place the caret where it
    // was, then run the action — its async result (the upload) inserts at that caret.
    view.dispatch({ changes: { from: v.from, to: head, insert: "" }, selection: EditorSelection.cursor(v.from) });
    view.focus();
    cmd.action(view);
    return;
  }
  const at = v.from; // template is inserted starting here (replacing "/query")
  const selection = Array.isArray(cmd.caret)
    ? EditorSelection.range(at + cmd.caret[0], at + cmd.caret[1])
    : EditorSelection.cursor(at + cmd.caret);
  view.dispatch({ changes: { from: v.from, to: head, insert: cmd.insert }, selection, scrollIntoView: true });
  view.focus();
}

function paletteTooltip(field: StateField<PaletteState | null>, from: number): Tooltip {
  return {
    pos: from,
    above: false,
    strictSide: false,
    arrow: false,
    create: (view): TooltipView => {
      const dom = document.createElement("div");
      dom.className = "lp-palette";
      dom.setAttribute("data-testid", "slash-palette");
      const render = () => {
        const v = view.state.field(field);
        if (!v) return;
        const matches = filterCommands(view.state, v.query);
        dom.replaceChildren();
        let selectedRow: HTMLElement | null = null;
        matches.forEach((cmd, i) => {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "lp-palette-row" + (i === v.index ? " is-selected" : "");
          row.setAttribute("data-testid", `slash-item-${cmd.id}`);
          if (i === v.index) { row.setAttribute("data-selected", "true"); selectedRow = row; }
          const name = document.createElement("span");
          name.className = "lp-palette-name";
          name.textContent = cmd.label();
          const alias = document.createElement("span");
          alias.className = "lp-palette-alias";
          alias.textContent = cmd.alias;
          row.append(name, alias);
          // mousedown (not click) + preventDefault keeps editor focus/selection intact
          row.addEventListener("mousedown", (e) => { e.preventDefault(); applyAt(view, cmd); });
          dom.appendChild(row);
        });
        // Keep the selected row visible when the capped list scrolls (e.g. nav to image,
        // the last item). block:"nearest" only scrolls the palette, never the page.
        (selectedRow as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
      };
      render();
      return {
        dom,
        update: (u) => { if (u.docChanged || u.state.field(field) !== u.startState.field(field)) render(); },
      };
    },
  };
}

// Keymap active only while the palette is open (else the keys pass through to vim /
// the editor). Highest precedence so the nav keys are captured before defaults.
//
// vim-style nav uses Ctrl-j/Ctrl-k, NOT Ctrl-n/Ctrl-p: Ctrl+N (and Ctrl+T/Ctrl+W) are
// browser-reserved shortcuts the page cannot intercept (Ctrl+N opened a new window).
// Ctrl+J/Ctrl+K reach the page and ARE cancellable, and j/k match vim's down/up.
// IMPORTANT: NO preventDefault flag — the handlers only consume the key (via returning
// true → CM preventDefaults) WHEN the palette is open. When closed they return false,
// so Ctrl-k stays the global page-search shortcut (SearchBox bails on defaultPrevented).
// Arrow/Tab remain as always-safe fallbacks.
const paletteKeymap = Prec.highest(
  keymap.of([
    // `/` with a SELECTION opens the decorate palette (ADR-018 #4: `/` is insert-primary
    // but also offers decoration on a selection); with no selection it types normally →
    // the insert palette. Gated off in vim normal/visual (there `/` is vim search).
    { key: "/", run: openDecorateOnSlash },
    { key: "ArrowDown", run: (v) => move(v, +1) },
    { key: "ArrowUp", run: (v) => move(v, -1) },
    { key: "Ctrl-j", run: (v) => move(v, +1) },
    { key: "Ctrl-k", run: (v) => move(v, -1) },
    { key: "Tab", run: (v) => move(v, +1) },
    { key: "Shift-Tab", run: (v) => move(v, -1) },
    { key: "Enter", run: chooseSelected },
    { key: "Escape", run: dismiss },
    // (The decorate palette's nav / mnemonic / Enter / Escape are handled by the
    // decorateKeys dom handler, not here — it must beat vim's keymap. See below.)
  ]),
);

function isOpen(view: EditorView): boolean {
  return view.state.field(paletteField, false) != null;
}
function move(view: EditorView, delta: number): boolean {
  if (isOpen(view)) { view.dispatch({ effects: moveSelection.of(delta) }); return true; }
  if (isDecorateOpen(view)) { view.dispatch({ effects: moveDecorate.of(delta) }); return true; }
  return false;
}
function chooseSelected(view: EditorView): boolean {
  const v = view.state.field(paletteField, false);
  if (v) { const cmd = filterCommands(view.state, v.query)[v.index]; if (cmd) applyAt(view, cmd); return true; }
  return chooseDecorate(view);
}
function dismiss(view: EditorView): boolean {
  if (isOpen(view)) { view.dispatch({ effects: dismissPalette.of(null) }); return true; }
  if (isDecorateOpen(view)) { view.dispatch({ effects: closeDecorate.of(null) }); return true; }
  return false;
}

// ── Selection (decorate) palette ───────────────────────────────────────────
// Layer-A formats applied to the selection. Opened by vim visual `\`, selection-`/`
// (non-vim / vim-insert), and (later) the bubble's "⋯". Items come from the SHARED
// INLINE_FORMATS (ADR-018 #3) so they match the toolbar exactly. Navigated by Arrow /
// Ctrl-j/k / Enter / click, OR a one-key mnemonic (ADR-018 #2): the running command
// wraps the still-intact selection (a normal edit → presence-safe).
const DECORATE = INLINE_FORMATS;

const openDecorate = StateEffect.define<{ from: number }>();
const moveDecorate = StateEffect.define<number>();
const closeDecorate = StateEffect.define<null>();

const decorateField = StateField.define<{ from: number; index: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(openDecorate)) return { from: e.value.from, index: 0 };
      if (e.is(closeDecorate)) return null;
    }
    if (!value) return null;
    // Close once the selection collapses (command applied / caret moved) or doc changes.
    if (tr.docChanged || tr.newSelection.main.empty) return null;
    let index = value.index;
    for (const e of tr.effects) if (e.is(moveDecorate)) index += e.value;
    index = ((index % DECORATE.length) + DECORATE.length) % DECORATE.length;
    return { from: value.from, index };
  },
  provide: (f) =>
    showTooltip.computeN([f], (state) => {
      const v = state.field(f);
      return v ? [decorateTooltip(f, v.from)] : [];
    }),
});

function isDecorateOpen(view: EditorView): boolean {
  return view.state.field(decorateField, false) != null;
}
function applyDecorate(view: EditorView, cmd: InlineFormat): void {
  if (!isDecorateOpen(view)) return;
  cmd.run(view); // wraps the (still-intact) selection; the doc change closes the field
}

function decorateTooltip(field: StateField<{ from: number; index: number } | null>, from: number): Tooltip {
  return {
    pos: from,
    above: true,
    strictSide: false,
    arrow: false,
    create: (view): TooltipView => {
      const dom = document.createElement("div");
      dom.className = "lp-palette";
      dom.setAttribute("data-testid", "decorate-palette");
      const render = () => {
        const v = view.state.field(field);
        if (!v) return;
        dom.replaceChildren();
        let selectedRow: HTMLElement | null = null;
        DECORATE.forEach((cmd, i) => {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "lp-palette-row" + (i === v.index ? " is-selected" : "");
          row.setAttribute("data-testid", `decorate-item-${cmd.id}`);
          if (i === v.index) { row.setAttribute("data-selected", "true"); selectedRow = row; }
          const name = document.createElement("span");
          name.className = "lp-palette-name";
          name.textContent = i18n.t(cmd.labelKey);
          const alias = document.createElement("span");
          alias.className = "lp-palette-alias";
          alias.textContent = cmd.mnemonic;
          row.append(name, alias);
          row.addEventListener("mousedown", (e) => { e.preventDefault(); applyDecorate(view, cmd); });
          dom.appendChild(row);
        });
        // Keep the selected row visible when the list scrolls (parity with the insert
        // palette). block:"nearest" scrolls only the palette, never the page.
        (selectedRow as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
      };
      render();
      return {
        dom,
        update: (u) => { if (u.state.field(field) !== u.startState.field(field)) render(); },
      };
    },
  };
}

// The decorate (selection) palette is opened by vim visual `\` (M0-3), selection-`/`
// (ADR-018 #4), the bubble's "⋯ more", and right-click (M0-4).
function chooseDecorate(view: EditorView): boolean {
  const v = view.state.field(decorateField, false);
  if (!v) return false;
  const cmd = DECORATE[v.index];
  if (cmd) applyDecorate(view, cmd);
  return true;
}

const isVimVisual = (view: EditorView): boolean => !!getCM(view)?.state.vim?.visualMode;

// `/` with a selection opens the decorate palette (ADR-018 #4). Gated off in vim
// normal/visual mode, where `/` is vim search (vim's selection-decoration door is `\`).
// With no selection this returns false → `/` types normally → the insert palette.
function openDecorateOnSlash(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const sel = view.state.selection.main;
  if (sel.empty) return false;
  const cm = getCM(view);
  if (cm && !cm.state.vim?.insertMode) return false; // vim normal/visual → `/` is search
  view.dispatch({ effects: openDecorate.of({ from: sel.from }) });
  return true;
}

// Key handling WHILE the decorate palette is open. A domEventHandlers (NOT a keymap)
// at highest precedence — same reason as backslashDecorate: in vim VISUAL mode the vim
// keymap consumes plain keys (`b` = back-word, `j/k` = motion, Enter, Escape) before any
// CM keymap runs, so the mnemonic fast-path (#2) and nav must intercept at the dom layer
// to beat vim. Only fires when the decorate palette is open (else passes through, so the
// insert palette's keymap and normal typing/vim are untouched).
const decorateKeys = Prec.highest(
  EditorView.domEventHandlers({
    keydown(e, view) {
      if (!isDecorateOpen(view)) return false;
      if (e.altKey || e.metaKey) return false;
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j")) { view.dispatch({ effects: moveDecorate.of(+1) }); e.preventDefault(); return true; }
      if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k")) { view.dispatch({ effects: moveDecorate.of(-1) }); e.preventDefault(); return true; }
      if (e.ctrlKey) return false;
      if (e.key === "Enter") { chooseDecorate(view); e.preventDefault(); return true; }
      if (e.key === "Escape") { view.dispatch({ effects: closeDecorate.of(null) }); e.preventDefault(); return true; }
      const fmt = INLINE_FORMATS.find((f) => f.mnemonic === e.key);
      if (fmt) { applyDecorate(view, fmt); e.preventDefault(); return true; }
      return false;
    },
  }),
);

// M0-3: vim VISUAL-mode `\` opens the selection palette. Matched by physical KEY CODE
// (Backslash on US; IntlRo / IntlYen on JIS), NOT by character — codemirror-vim's
// char-based key handling mangles `¥` on JIS, so a keycode intercept is the only robust
// way (ADR-017/018). Highest precedence + preventDefault so vim never sees it; only
// fires in vim visual mode with a selection, so normal/visual `/`-search and everything
// else are untouched.
const backslashDecorate = Prec.highest(
  EditorView.domEventHandlers({
    keydown(e, view) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
      if (e.code !== "Backslash" && e.code !== "IntlRo" && e.code !== "IntlYen") return false;
      if (!isVimVisual(view)) return false;
      const sel = view.state.selection.main;
      if (sel.empty) return false;
      view.dispatch({ effects: openDecorate.of({ from: sel.from }) });
      e.preventDefault();
      return true;
    },
  }),
);

// Shared "vim visual mode with a selection" flag. vim's mode isn't in EditorState
// (only reachable via getCM(view)), so an updateListener syncs it into a StateField
// that StateField-level consumers (the hint tooltip here, the bubble in toolbar.ts) can
// read. Exported so the floating toolbar can suppress itself in vim visual (the hint
// takes the ribbon spot instead).
const setVimVisual = StateEffect.define<boolean>();
export const vimVisualField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setVimVisual)) return e.value;
    return value;
  },
});
const vimVisualSync = EditorView.updateListener.of((u) => {
  const want = isVimVisual(u.view) && !u.view.state.selection.main.empty;
  if (u.view.state.field(vimVisualField) !== want) u.view.dispatch({ effects: setVimVisual.of(want) });
});

// A small, unobtrusive hint shown ONLY during a vim VISUAL selection, at the format
// toolbar's spot (a tooltip above the selection): tells the user `\` opens the format/
// macro palette (matching backslashDecorate). Display-only — a CM tooltip (NOT a node in
// view.dom, #8), no text/decoration, so document offsets / presence are untouched.
// Hidden in normal/insert/non-vim and while the palette is already open (and the full
// toolbar bubble is suppressed in vim visual, so the hint replaces it — no overlap).
function vimHintTooltip(from: number): Tooltip {
  return {
    pos: from,
    above: true,
    strictSide: false,
    arrow: false,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "lp-vim-hint";
      dom.setAttribute("data-testid", "vim-decorate-hint");
      dom.textContent = i18n.t("palette.vimHint");
      return { dom };
    },
  };
}
const vimHintField = StateField.define<readonly Tooltip[]>({
  create: () => [],
  update(_value, tr) {
    const show = tr.state.field(vimVisualField) && tr.state.field(decorateField, false) == null;
    return show ? [vimHintTooltip(tr.state.selection.main.from)] : [];
  },
  provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
});

// Wires the host's uploader into the `/image` command: a hidden file input (kept in the
// React-owned host container, which CM never reconciles, so it survives edits) plus the
// trigger exposed via the imageUploader facet. On a chosen file it uploads and inserts
// ![alt](ref) at the CURRENT caret — so it works whether opened via the `/image` command
// or driven directly (e.g. tests setting the input). Same path as the old toolbar button.
function imageInsert(upload: ImageUploader, container?: HTMLElement): Extension {
  let view: EditorView | null = null;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.style.display = "none";
  input.setAttribute("data-testid", "lp-image-input");
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = ""; // allow re-picking the same file
    if (!file || !view) return;
    const v = view;
    void upload(file).then((res) => { if (res) insertImage(v, res.alt, res.ref); });
  });
  (container ?? document.body).appendChild(input);
  // Capture the view (for insertImage) + clean up the input when the editor is destroyed.
  const lifecycle = ViewPlugin.define((v) => { view = v; return { destroy() { input.remove(); view = null; } }; });
  return [imageUploader.of(() => input.click()), lifecycle];
}

export function slashPalette(opts: { uploadImage?: ImageUploader; container?: HTMLElement } = {}): Extension {
  // Order matters: vimVisualField before vimHintField (the field reads it); both before
  // the floating toolbar's bubble (added after slashPalette) so the bubble can read it.
  const core = [dismissedField, paletteField, decorateField, vimVisualField, vimHintField, paletteKeymap, decorateKeys, backslashDecorate, vimVisualSync];
  return opts.uploadImage ? [...core, imageInsert(opts.uploadImage, opts.container)] : core;
}
