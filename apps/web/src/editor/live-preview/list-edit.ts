import { Prec, type Extension, type Line } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { markdownKeymap } from "@codemirror/lang-markdown";
import { Vim } from "@replit/codemirror-vim";

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

// #202 vim `o`: in NORMAL mode `o` must CONTINUE the list marker (like Enter in insert mode does),
// not open a blank line — the previous attempt bound `o` via a CM keymap (Prec.highest), but that
// CANNOT intercept vim NORMAL-mode keys: @replit/codemirror-vim processes normal-mode commands in its
// own ViewPlugin `keydown` domEventHandler, so `o` never reaches the CM keymap facet (that is why the
// bounce reported "o still doesn't complete"). The correct seam is a vim REMAP. We remap `o` to
// `A<CR>` — append at end of line (enters insert mode, column-independent) then Enter — which reuses
// the ALREADY-WORKING insert-mode marker continuation (markdownKeymap's insertNewlineContinueMarkdown,
// Prec.high below). On a list line that continues the marker (bullet repeats, ordered increments); off
// a list line `A<CR>` is equivalent to plain `o` (end-of-line + newline). One global mapping (vim maps
// are global), applied once and guarded against HMR re-entry. `O` (open above) is left as vim default
// for now — the reported issue is `o`; above-continuation has no clean key-remap and is a follow-up.
let vimListMapped = false;
function ensureVimListMappings(): void {
  if (vimListMapped) return;
  vimListMapped = true;
  Vim.map("o", "A<CR>", "normal"); // continue the list marker via the working Enter path
}

export const listEditing: Extension = (() => {
  ensureVimListMappings();
  return [
    // #202 Tab/Shift-Tab indent/outdent a list item. Prec.highest (was Prec.high, which lost to another
    // highest-prec Tab handler and fell through to browser focus movement — the "Tab steals focus"
    // bounce). indentList/outdentList return false when NOT on a list line, so a co-registered
    // highest-prec Tab handler (e.g. the slash palette while open) still gets its turn.
    Prec.highest(keymap.of([
      { key: "Tab", run: indentList },
      { key: "Shift-Tab", run: outdentList },
    ])),
    // Enter continues the list marker / Backspace removes it. High prec so Enter continuation beats
    // minimalSetup's plain newline; falls back to a normal newline outside a list (by design). The vim
    // `o` remap above routes through this same handler.
    Prec.high(keymap.of(markdownKeymap)),
  ];
})();
