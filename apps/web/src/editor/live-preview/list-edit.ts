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
// #202 (comment 773): a nested list must be indented PAST its parent's marker to parse as a child list —
// CommonMark requires the child indent to clear the parent's content column. A bullet `- ` clears at 2,
// but an ordered `1. ` clears at 3, so a fixed 2-space indent left ordered items in the PARENT list
// (flat 1,2,3,4,5 — the reported bug). Indent by the item's own marker width so ordered nests correctly.
const MARKER_W = /^\s*((?:[-*+]|\d+[.)]))(\s+)/;
const markerIndentWidth = (text: string): number => { const m = MARKER_W.exec(text); return m ? m[1].length + m[2].length : 2; };

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
    // #202: one nesting level = the item's marker width (ordered `1. ` → 3 spaces so it parses as a child
    // ordered list; bullet `- ` → 2), so a nested ordered list restarts + gets its own ordinal style.
    changes: lines.map((l) => ({ from: l.from, insert: " ".repeat(markerIndentWidth(l.text)) })),
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
    // #202: remove up to one nesting level (the item's marker width) of leading spaces — symmetric with indent.
    const lead = new RegExp(`^ {1,${markerIndentWidth(l.text)}}`).exec(l.text);
    if (lead) changes.push({ from: l.from, to: l.from + lead[0].length });
  }
  if (!sawList) return false; // not in a list → let the default Shift-Tab run
  if (!changes.length) return true; // in a list but already at the top level → consume (no focus move)
  view.dispatch(view.state.update({ changes, userEvent: "delete.dedent" }));
  return true;
};

// #202 vim `o`/`O`: in NORMAL mode these must CONTINUE the list marker (like Enter in insert mode),
// not open a blank line. Two earlier attempts failed and were measured in a real browser:
//   - a CM keymap (Prec.highest) can't intercept vim NORMAL keys (vim handles them in its own keydown).
//   - remapping `o`→`A<CR>` produced an UNMARKED new line: vim's remap `<CR>` doesn't dispatch the CM
//     Enter that markdownKeymap's continuation listens for (measured: `o` then type → "new", no "- ").
// The correct seam is a vim ACTION that does the continuation DIRECTLY. `Vim.defineAction` adds the fn
// to vim's actions object, so a plain `function` (not arrow) binds `this` to that object and can call
// `this.enterInsertMode` exactly like the built-in `newLineAndEnterInsertMode`. We compute the current
// line's marker (bullet repeats; ordered increments), insert `\n<marker>` (o) / `<marker>\n` (O), place
// the caret after the marker, and enter insert mode. Off a list line it falls back to a plain open.
// One global registration (vim maps/actions are global), guarded against HMR re-entry.
const MARKER_RE = /^(\s*)([-*+]|\d+)([.)]?)(\s+)/; // indent, bullet-or-number, ordered-delim, trailing ws
function continuedMarker(lineText: string, forward: boolean): string | null {
  const m = MARKER_RE.exec(lineText);
  if (!m) return null;
  const [, indent, token, delim, ws] = m;
  // #301: a GFM task item (`- [ ]` / `1. [x]`) continues with an UNCHECKED `[ ] ` box — the same rule the
  // Enter path (insertNewlineContinueMarkdown) uses; never clone a checked box. Non-task lists are unchanged.
  const task = /^\[[ xX]\]\s/.test(lineText.slice(m[0].length)) ? "[ ] " : "";
  if (/^\d+$/.test(token!)) {
    const n = parseInt(token!, 10);
    return `${indent}${forward ? n + 1 : Math.max(1, n)}${delim}${ws}${task}`; // ordered: next number (o) / same (O)
  }
  return `${indent}${token}${delim}${ws}${task}`; // bullet: repeat
}
let vimListMapped = false;
function ensureVimListMappings(): void {
  if (vimListMapped) return;
  vimListMapped = true;
  const openList = function (this: { enterInsertMode: (cm: unknown, a: unknown, v: unknown) => void }, cm: any, actionArgs: { after?: boolean }, vim: unknown): void {
    const forward = actionArgs?.after !== false; // `o` (after=true) below, `O` (after=false) above
    const cur = cm.getCursor();
    const lineText: string = cm.getLine(cur.line) ?? "";
    const marker = continuedMarker(lineText, forward);
    if (marker == null) {
      // not a list line → plain open (mirror the built-in newLineAndEnterInsertMode minimally)
      const at = forward ? { line: cur.line, ch: lineText.length } : { line: cur.line, ch: 0 };
      cm.replaceRange(forward ? "\n" : "\n", at);
      cm.setCursor(forward ? { line: cur.line + 1, ch: 0 } : { line: cur.line, ch: 0 });
      this.enterInsertMode(cm, { repeat: 1 }, vim);
      return;
    }
    if (forward) {
      cm.replaceRange("\n" + marker, { line: cur.line, ch: lineText.length });
      cm.setCursor({ line: cur.line + 1, ch: marker.length });
    } else {
      cm.replaceRange(marker + "\n", { line: cur.line, ch: 0 });
      cm.setCursor({ line: cur.line, ch: marker.length });
    }
    this.enterInsertMode(cm, { repeat: 1 }, vim);
  };
  Vim.defineAction("continueListBelow", function (this: any, cm: any, a: any, v: any) { openList.call(this, cm, { after: true }, v); });
  Vim.defineAction("continueListAbove", function (this: any, cm: any, a: any, v: any) { openList.call(this, cm, { after: false }, v); });
  Vim.mapCommand("o", "action", "continueListBelow", {}, { context: "normal" });
  Vim.mapCommand("O", "action", "continueListAbove", {}, { context: "normal" });
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
