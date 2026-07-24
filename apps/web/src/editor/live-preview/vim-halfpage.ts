import { Vim } from "@replit/codemirror-vim";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

// #526: @replit/codemirror-vim's own <C-d>/<C-u> WRAP at the document ends — with the caret on the last
// line, Ctrl-D sends it back to offset 0 (measured: head 11115 → 0, scrollTop max → 0), so holding Ctrl-D
// cycles to the top instead of stopping at the bottom. Real vim clamps: at the end, C-d is a no-op.
//
// Rather than patch the vendored keys, map <C-d>/<C-u> onto our own half-page motion, which is a plain
// clamped line jump: move the caret half a viewport of lines and let CodeMirror scroll it into view. This
// is display-adjacent only — it moves the SELECTION (no doc change), so the single-Y.Text/collab paths are
// untouched, and the #306 scrolloff listener still runs on the resulting selection change.
function halfPageLines(view: EditorView): number {
  // Half a viewport, in lines — mirrors vim's `scroll` option (half the window height). defaultLineHeight
  // is the block height CM itself uses for estimates, so this tracks the current font/zoom.
  const lines = Math.floor(view.dom.clientHeight / view.defaultLineHeight / 2);
  return Math.max(1, lines);
}

function moveHalfPage(view: EditorView, dir: 1 | -1): void {
  const state = view.state;
  const head = state.selection.main.head;
  const cur = state.doc.lineAt(head);
  // Clamp to the real document bounds — this is the whole point of the override.
  const target = Math.min(state.doc.lines, Math.max(1, cur.number + dir * halfPageLines(view)));
  const line = state.doc.line(target);
  // Keep the caret's column where it can be kept (vim keeps the goal column; the simple, predictable
  // rule is "same offset into the line, clamped to its length").
  const col = Math.min(head - cur.from, line.length);
  const pos = line.from + col;
  if (pos === head) return; // already at the end (or start): a no-op, exactly like vim
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    scrollIntoView: true,
    // not a pointer/jump event: the #306 scrolloff correction is welcome here (it keeps the caret off the
    // very edge of the viewport, which is what a half-page jump wants).
    userEvent: "select",
  });
}

// Idempotent: the Vim singleton is global, so registering once is enough (HMR self-accepts + reloads,
// so there is no double-registration in dev) — same contract as registerVimFold.
let registered = false;
export function registerVimHalfPage(): void {
  if (registered) return;
  registered = true;
  Vim.defineAction("wksHalfPageDown", (cm: { cm6: EditorView }) => { moveHalfPage(cm.cm6, 1); });
  Vim.defineAction("wksHalfPageUp", (cm: { cm6: EditorView }) => { moveHalfPage(cm.cm6, -1); });
  Vim.mapCommand("<C-d>", "action", "wksHalfPageDown", {}, { context: "normal" });
  Vim.mapCommand("<C-u>", "action", "wksHalfPageUp", {}, { context: "normal" });
  Vim.mapCommand("<C-d>", "action", "wksHalfPageDown", {}, { context: "visual" });
  Vim.mapCommand("<C-u>", "action", "wksHalfPageUp", {}, { context: "visual" });
}
