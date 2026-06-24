import { EditorView, showTooltip, keymap, type Tooltip, type TooltipView } from "@codemirror/view";
import { StateField, StateEffect, EditorSelection, Prec, type Extension } from "@codemirror/state";
import i18n from "../../i18n";

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
}

// Layer B/C commands. Each template places the caret where you'd type the content next.
// (Inline decorations — layer A — are M0-2; image insert is M0-5.)
const COMMANDS: PaletteCommand[] = [
  { id: "h1", label: () => i18n.t("palette.h1"), alias: "h1", keywords: "heading title #", insert: "# ", caret: 2 },
  { id: "h2", label: () => i18n.t("palette.h2"), alias: "h2", keywords: "heading subtitle ##", insert: "## ", caret: 3 },
  { id: "h3", label: () => i18n.t("palette.h3"), alias: "h3", keywords: "heading ###", insert: "### ", caret: 4 },
  { id: "ul", label: () => i18n.t("palette.bulletList"), alias: "list", keywords: "bullet unordered dash", insert: "- ", caret: 2 },
  { id: "ol", label: () => i18n.t("palette.numberedList"), alias: "1. list", keywords: "numbered ordered", insert: "1. ", caret: 3 },
  { id: "quote", label: () => i18n.t("palette.quote"), alias: "quote", keywords: "blockquote citation", insert: "> ", caret: 2 },
  { id: "code", label: () => i18n.t("palette.codeBlock"), alias: "code", keywords: "code block fenced pre", insert: "```\n\n```", caret: 4 },
  { id: "table", label: () => i18n.t("palette.table"), alias: "table", keywords: "grid", insert: "| Column | Column |\n| --- | --- |\n| Cell | Cell |", caret: [2, 8] },
  { id: "divider", label: () => i18n.t("palette.divider"), alias: "divider", keywords: "rule hr separator line", insert: "---\n", caret: 4 },
];

function filterCommands(query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return COMMANDS;
  return COMMANDS.filter(
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
    const matches = filterCommands(d.query);
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
        const matches = filterCommands(v.query);
        dom.replaceChildren();
        matches.forEach((cmd, i) => {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "lp-palette-row" + (i === v.index ? " is-selected" : "");
          row.setAttribute("data-testid", `slash-item-${cmd.id}`);
          if (i === v.index) row.setAttribute("data-selected", "true");
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
// browser-reserved shortcuts that the page cannot intercept (Ctrl+N opened a new window
// — preventDefault can't stop it). Ctrl+J/Ctrl+K reach the page and ARE cancellable, and
// j/k match vim's down/up. Arrow/Tab remain as always-safe fallbacks.
const paletteKeymap = Prec.highest(
  keymap.of([
    { key: "ArrowDown", run: (v) => move(v, +1) },
    { key: "ArrowUp", run: (v) => move(v, -1) },
    { key: "Ctrl-j", run: (v) => move(v, +1), preventDefault: true },
    { key: "Ctrl-k", run: (v) => move(v, -1), preventDefault: true },
    { key: "Tab", run: (v) => move(v, +1) },
    { key: "Shift-Tab", run: (v) => move(v, -1) },
    { key: "Enter", run: chooseSelected },
    { key: "Escape", run: dismiss },
  ]),
);

function isOpen(view: EditorView): boolean {
  return view.state.field(paletteField, false) != null;
}
function move(view: EditorView, delta: number): boolean {
  if (!isOpen(view)) return false;
  view.dispatch({ effects: moveSelection.of(delta) });
  return true;
}
function chooseSelected(view: EditorView): boolean {
  const v = view.state.field(paletteField, false);
  if (!v) return false;
  const cmd = filterCommands(v.query)[v.index];
  if (cmd) applyAt(view, cmd);
  return true;
}
function dismiss(view: EditorView): boolean {
  if (!isOpen(view)) return false;
  view.dispatch({ effects: dismissPalette.of(null) });
  return true;
}

export function slashPalette(): Extension {
  return [dismissedField, paletteField, paletteKeymap];
}
