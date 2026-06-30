import { Vim, getCM } from "@replit/codemirror-vim";
import { EditorState, EditorSelection, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import { livePreview } from "./decorations";

// ADR-024 1b (Mode A): dd treats a macro ATOM as one unit — the WHOLE macro source is the
// delete payload, and the unnamed register gets the whole macro so `p` pastes it back. The
// native d operator (d{motion}) is untouched (the user chose Mode A, not "round every
// operator"). vim's default dd (operatorMotion) can't be overridden by Vim.mapCommand
// (verified — the custom action never fires), so instead a transactionFilter EXPANDS the
// linewise delete vim produces at a macro atom's first line to the whole macro, and
// overwrites the register (vim had yanked only the first line). Only a single pure deletion
// beginning exactly at a block start and not extending past it is touched — dG and edits
// elsewhere pass through; normal-line dd / registers are intact.
//
// yy COUNTERPART (#91): yank has no transaction to hook (the doc doesn't change) and
// mapCommand can't override yy either, so the whole-atom yank is done with a PRE-VIM chord
// intercept (atomChords, below) instead of the transactionFilter dd uses.

export const atomDelete: Extension = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  let del: { fromA: number; toA: number } | null = null;
  let other = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (inserted.length === 0 && !del) del = { fromA, toA };
    else other = true;
  });
  if (!del || other) return tr;
  const d = del as { fromA: number; toA: number };
  const blocks = tr.startState.field(livePreview, false)?.blocks;
  if (!blocks?.length) return tr;
  const doc = tr.startState.doc;
  for (const b of blocks) {
    const firstLine = doc.lineAt(b.from);
    if (d.fromA === b.from && d.toA >= firstLine.to && d.toA <= b.to + 1) {
      const end = Math.min(b.to + 1, doc.length);
      // The register is also corrected to the WHOLE macro — but vim sets the unnamed register
      // AFTER this filter runs (it yanked only its 1-line range), overwriting this setText. So
      // the authoritative register fix is deferred to a microtask in `atomChords` ("d" branch);
      // this setText is a harmless best-effort. (See #91: dd→p was pasting an EMPTY macro.)
      try { Vim.getRegisterController().getRegister().setText(doc.sliceString(b.from, end), true); } catch { /* register unavailable */ }
      return { changes: { from: b.from, to: end }, selection: EditorSelection.cursor(Math.min(b.from, end)) };
    }
  }
  return tr;
});

// `yy` on a macro/table atom → yank the WHOLE atom (linewise), the read counterpart of
// atomDelete's `dd`. yy changes no doc, so the transactionFilter can't see it, and
// Vim.mapCommand can't override yy.
//
// A CM `keymap` does NOT work here: codemirror-vim handles keys in a ViewPlugin keydown
// eventHandler that CONSUMES `y` (preventDefault) before any keymap binding runs — so a
// Prec.highest keymap "y" never fires (verified: it silently lost to vim, and yy yanked only
// the atom's first line → pasting an EMPTY macro, #91). Keys vim does NOT consume (Ctrl-Enter)
// still reach keymaps, which is why those work and this didn't.
//
// Fix: intercept the SECOND `y` of the chord with a CAPTURE-phase keydown listener on the
// content DOM — capture runs before vim's (bubble) handler, so we win deterministically. The
// FIRST `y` is left for vim (operator becomes 'yank'); on the next `y`, if the caret is on an
// atom's first line and it's a plain, uncounted, default-register yy, overwrite the unnamed
// register with the whole atom source (linewise), cancel vim's pending operator via the PUBLIC
// Vim.handleKey(cm,'<Esc>'), and swallow the key so vim's 1-line yank never runs. Everything
// else (yw/y$/yj, 3yy, "ayy, yy on a normal line, insert/visual, vim off) is left to vim.
// Which atom block (if any) the caret sits INSIDE, by source RANGE — not "first line only" (#91
// atom-direction bug). Entering an atom from below lands the caret on its LAST line (`:::` end),
// not its first; the old `lineAt(b.from) === caretLine` check missed that, so yy/dd silently fell
// back to vim's 1-line version when the atom was entered upward. A caret anywhere in [from, to]
// (any line of the atom) resolves to the whole atom, making yy/dd entry-direction-independent.
// Pure (no view/vim) so it is unit-tested directly. Returns the first containing block.
export function atomBlockAtCaret(
  blocks: ReadonlyArray<{ from: number; to: number }> | undefined,
  caret: number,
): { from: number; to: number } | null {
  return blocks?.find((bl) => caret >= bl.from && caret <= bl.to) ?? null;
}

// The atom block the caret sits inside, if this is a plain (uncounted, default-register) chord
// whose first key already set vim's `operator`. Returns the block + its full source range.
function atomChordTarget(view: EditorView, operator: "yank" | "delete"): { from: number; to: number } | null {
  const cm = getCM(view);
  const vim = cm?.state.vim;
  if (!vim || vim.insertMode || vim.visualMode) return null;
  const is = vim.inputState;
  if (!is || is.operator !== operator) return null; // not the 2nd key of a bare yy/dd
  if (is.registerName) return null; // "ayy / "add → named register, let vim handle
  if (is.prefixRepeat && is.prefixRepeat.length) return null; // 3yy / 3dd → counted, let vim handle
  const doc = view.state.doc;
  const blocks = view.state.field(livePreview, false)?.blocks;
  const b = atomBlockAtCaret(blocks, view.state.selection.main.head);
  if (!b) return null; // caret not inside any atom → normal yy/dd
  return { from: b.from, to: Math.min(b.to + 1, doc.length) };
}

// CAPTURE-phase keydown for the second key of `yy` / `dd` on a macro atom (#91). codemirror-vim
// handles keys in a ViewPlugin keydown that CONSUMES y/d before any CM keymap runs, so a keymap
// can't intercept them; a capture-phase listener on contentDOM runs BEFORE vim's (bubble)
// handler and wins deterministically.
//   yy: do the whole-atom yank ourselves and SWALLOW the key so vim's 1-line yank never runs.
//   dd: let vim + the atomDelete transactionFilter perform the (correct, whole-block) delete, but
//       CORRECT the unnamed register AFTER vim sets it — vim's register set runs synchronously
//       inside this keydown, so a microtask (after the event) is the authoritative last write.
// Without this, both pasted an EMPTY macro (vim's register held only the atom's first ::: line).
export const atomYank: Extension = ViewPlugin.define((view) => {
  const onKeydown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const cm = getCM(view);
    if (e.key === "y") {
      const t = atomChordTarget(view, "yank");
      if (!t) return; // first y, or not an atom → let vim handle
      const src = view.state.doc.sliceString(t.from, t.to);
      try { Vim.getRegisterController().getRegister().setText(src, true); } catch { /* register unavailable */ }
      Vim.handleKey(cm!, "<Esc>", "mapping"); // cancel the pending yank operator
      e.preventDefault();
      e.stopImmediatePropagation(); // vim must NOT also see this 2nd y (it would yank 1 line)
    } else if (e.key === "d") {
      const t = atomChordTarget(view, "delete");
      if (!t) return; // first d, or not an atom → let vim do a normal dd
      const src = view.state.doc.sliceString(t.from, t.to);
      const newLen = view.state.doc.length - (t.to - t.from);
      // Do the whole-block delete ourselves and SWALLOW the key: if we let vim run, it sets the
      // unnamed register to its 1-line range AFTER any filter/microtask, so p pasted an empty
      // macro. (atomDelete still re-normalizes this dispatch harmlessly if it ever fires.)
      view.dispatch({ changes: { from: t.from, to: t.to }, selection: EditorSelection.cursor(Math.min(t.from, newLen)) });
      try { Vim.getRegisterController().getRegister().setText(src, true); } catch { /* register unavailable */ }
      Vim.handleKey(cm!, "<Esc>", "mapping"); // back to normal (cancel the pending delete operator)
      e.preventDefault();
      e.stopImmediatePropagation(); // vim must NOT also see this 2nd d
    }
  };
  view.contentDOM.addEventListener("keydown", onKeydown, true); // capture: before vim's handler
  return { destroy() { view.contentDOM.removeEventListener("keydown", onKeydown, true); } };
});
