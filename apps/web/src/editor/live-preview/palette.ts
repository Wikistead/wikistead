import { EditorView, showTooltip, keymap, type Tooltip, type TooltipView } from "@codemirror/view";
import { StateField, StateEffect, Prec, type Extension } from "@codemirror/state";
import i18n from "../../i18n";
import {
  setHeading,
  toggleBulletList,
  toggleNumberedList,
  toggleQuote,
  insertCodeBlock,
  insertTable,
  insertDivider,
} from "./commands";

// Slash command palette (Step I / M0-1 — see ADR-017). Triggered by `/` at the START
// of a line while editing (insert mode for vim users). Lists block insert/toggle
// commands (layer B/C); choosing one removes the typed "/query" token and runs the
// command, which inserts plain Markdown into the canonical Y.Text — so it is offset-
// invariant and presence-safe (ADR-008), never a special node. Built on CodeMirror's
// tooltip layer (NOT React, NOT cmdk): the editor surface owns no React (ADR-013), and
// CM reconciles away nodes injected into view.dom (see the floating toolbar), so the
// palette lives in the managed tooltip layer.

interface PaletteCommand {
  id: string;
  label: () => string;
  keywords: string; // lowercase, space-separated, for filtering
  run: (v: EditorView) => void;
}

// Layer B/C commands. (Inline decorations — layer A — are M0-2; image insert is M0-5.)
const COMMANDS: PaletteCommand[] = [
  { id: "h1", label: () => i18n.t("palette.h1"), keywords: "heading title h1 #", run: (v) => setHeading(v, 1) },
  { id: "h2", label: () => i18n.t("palette.h2"), keywords: "heading subtitle h2 ##", run: (v) => setHeading(v, 2) },
  { id: "h3", label: () => i18n.t("palette.h3"), keywords: "heading h3 ###", run: (v) => setHeading(v, 3) },
  { id: "ul", label: () => i18n.t("palette.bulletList"), keywords: "bullet list unordered ul dash", run: toggleBulletList },
  { id: "ol", label: () => i18n.t("palette.numberedList"), keywords: "numbered ordered list ol", run: toggleNumberedList },
  { id: "quote", label: () => i18n.t("palette.quote"), keywords: "quote blockquote citation", run: toggleQuote },
  { id: "code", label: () => i18n.t("palette.codeBlock"), keywords: "code block fenced pre", run: insertCodeBlock },
  { id: "table", label: () => i18n.t("palette.table"), keywords: "table grid", run: insertTable },
  { id: "divider", label: () => i18n.t("palette.divider"), keywords: "divider rule hr separator line", run: insertDivider },
];

function filterCommands(query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return COMMANDS;
  return COMMANDS.filter((c) => c.label().toLowerCase().includes(q) || c.keywords.includes(q));
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

// Is the cursor right after a line-leading "/query" token (no spaces, empty selection)?
function detect(state: { readOnly: boolean; doc: { lineAt: (n: number) => { from: number }; sliceString: (a: number, b: number) => string }; selection: { main: { empty: boolean; head: number } } }): { from: number; query: string } | null {
  if (state.readOnly) return null;
  const sel = state.selection.main;
  if (!sel.empty) return null; // decoration-on-selection is M0-2
  const line = state.doc.lineAt(sel.head);
  const before = state.doc.sliceString(line.from, sel.head);
  const m = /^\/([\p{L}\p{N}-]*)$/u.exec(before);
  if (!m) return null;
  return { from: line.from, query: m[1] ?? "" };
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
  // remove the "/query" token, collapse to its start, then run the command there
  view.dispatch({ changes: { from: v.from, to: head, insert: "" }, selection: { anchor: v.from } });
  cmd.run(view);
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
          row.textContent = cmd.label();
          row.setAttribute("data-testid", `slash-item-${cmd.id}`);
          if (i === v.index) row.setAttribute("data-selected", "true");
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
// the editor). Highest precedence so Enter/Arrows/Esc are captured before defaults.
const paletteKeymap = Prec.highest(
  keymap.of([
    { key: "ArrowDown", run: (v) => move(v, +1) },
    { key: "ArrowUp", run: (v) => move(v, -1) },
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
  const matches = filterCommands(v.query);
  const cmd = matches[v.index];
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
