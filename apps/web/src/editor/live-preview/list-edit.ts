import { Prec, type Extension, type Line } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { markdownKeymap } from "@codemirror/lang-markdown";
import { Vim, getCM } from "@replit/codemirror-vim";

// #202: standard list-editing ergonomics (Notion / Google Docs style) on the single Y.Text.
//  - Tab / Shift-Tab INSIDE a list item indent / outdent it (nesting), in vim AND non-vim. Tab was
//    being swallowed by browser focus movement (no editor Tab handler outside the slash palette).
//  - Enter continues the list marker (markdownKeymap's insertNewlineContinueMarkdown); Backspace at a
//    marker removes it (deleteMarkupBackward).
// All operate on plain markdown text (indentation = nesting), so the doc round-trips (Open formats) and
// stays offset-invariant. OUTSIDE a list, Tab/Shift-Tab return false → the previous behaviour is kept.

const LIST_RE = /^(\s*)(?:[-*+]|\d+[.)])\s/; // a bullet (-, *, +) or ordered (1. / 1)) marker
const INDENT = "  "; // two spaces per nesting level (the common markdown convention)

// The distinct lines touched by the selection (each once, in order).
function selectedLines(view: EditorView): Line[] {
  const seen = new Set<number>();
  const out: Line[] = [];
  for (const r of view.state.selection.ranges) {
    let pos = r.from;
    for (;;) {
      const line = view.state.doc.lineAt(pos);
      if (!seen.has(line.number)) { seen.add(line.number); out.push(line); }
      if (line.to >= r.to) break;
      pos = line.to + 1;
    }
  }
  return out;
}

const isListLine = (text: string): boolean => LIST_RE.test(text);

// Indent every list line in the selection by one level. false (→ default Tab) when none is a list.
export const indentList = (view: EditorView): boolean => {
  const lines = selectedLines(view).filter((l) => isListLine(l.text));
  if (!lines.length) return false;
  view.dispatch(view.state.update({
    changes: lines.map((l) => ({ from: l.from, insert: INDENT })),
    userEvent: "input.indent",
  }));
  return true;
};

// Outdent every list line in the selection by one level. false when none is an outdentable list line.
export const outdentList = (view: EditorView): boolean => {
  const changes: { from: number; to: number }[] = [];
  let sawList = false;
  for (const l of selectedLines(view)) {
    if (!isListLine(l.text)) continue;
    sawList = true;
    const lead = /^ {1,2}/.exec(l.text); // remove up to one indent level of leading spaces
    if (lead) changes.push({ from: l.from, to: l.from + lead[0].length });
  }
  if (!sawList) return false; // not in a list → let the default Shift-Tab run
  if (!changes.length) return true; // in a list but already at the top level → consume (no focus move)
  view.dispatch(view.state.update({ changes, userEvent: "delete.dedent" }));
  return true;
};

// The marker that CONTINUES the list from `text`: same indent + a fresh marker (a bullet repeats;
// an ordered marker increments the number). null when `text` is not a list line. Pure + testable.
const MARKER_RE = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)/;
export function continueMarker(text: string): string | null {
  const m = MARKER_RE.exec(text);
  if (!m) return null;
  const indent = m[1] ?? "";
  const sp = m[5] ?? " ";
  if (m[3]) return `${indent}${Number(m[3]) + 1}${m[4]}${sp}`; // ordered → next number
  return `${indent}${m[2]}${sp}`; // bullet → repeat
}

// #202 vim: `o` / `O` in NORMAL mode should CONTINUE the list marker (like Enter in insert mode does),
// not just open a blank line — Enter and o/O were inconsistent. A pre-vim keymap (Prec.highest, the
// same technique vim-atom uses) handles it ONLY in vim normal mode on a list line; otherwise it returns
// false so normal typing ("o" in insert mode) and vim's plain o/O off a list are untouched.
const openListAware = (below: boolean) => (view: EditorView): boolean => {
  const cm = getCM(view);
  if (!cm || cm.state.vim?.insertMode) return false; // only vim NORMAL mode (never while typing)
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const marker = continueMarker(line.text);
  if (marker === null) return false; // not on a list line → let vim's default o/O run
  const at = below ? line.to : line.from;
  const insert = below ? `\n${marker}` : `${marker}\n`;
  const caret = below ? at + 1 + marker.length : at + marker.length;
  view.dispatch(view.state.update({ changes: { from: at, insert }, selection: { anchor: caret }, userEvent: "input", scrollIntoView: true }));
  Vim.handleKey(cm, "i", "mapping"); // enter insert mode at the new marker (like o/O does)
  return true;
};

export const listEditing: Extension = [
  // #202 vim o/O list continuation — BEFORE vim (Prec.highest), guarded to fire only in vim normal
  // mode on a list line (so "o" typed in insert mode, and o/O off a list, are unaffected).
  Prec.highest(keymap.of([
    { key: "o", run: openListAware(true) },
    { key: "O", run: openListAware(false) },
  ])),
  // High precedence so Tab reaches the editor for list indent (it was captured by focus), but BELOW
  // the slash palette's Prec.highest Tab (palette navigation wins while the palette is open).
  Prec.high(keymap.of([
    { key: "Tab", run: indentList },
    { key: "Shift-Tab", run: outdentList },
  ])),
  // Enter continues the list marker / Backspace removes it. High prec so Enter continuation beats
  // minimalSetup's plain newline; falls back to a normal newline outside a list (by design).
  Prec.high(keymap.of(markdownKeymap)),
];
