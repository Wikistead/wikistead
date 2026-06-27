import { Vim, getCM } from "@replit/codemirror-vim";
import { EditorState, EditorSelection, Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
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
// intercept (atomYank, below) instead of the transactionFilter dd uses.

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
      // p must paste the WHOLE macro: vim yanked only the first line, so overwrite the
      // unnamed register with the full macro source (linewise). Deterministic side effect.
      try { Vim.getRegisterController().getRegister().setText(doc.sliceString(b.from, end), true); } catch { /* register unavailable */ }
      return { changes: { from: b.from, to: end }, selection: EditorSelection.cursor(Math.min(b.from, end)) };
    }
  }
  return tr;
});

// `yy` on a macro/table atom → yank the WHOLE atom (linewise), the read counterpart of
// atomDelete's `dd`. yy changes no doc, so the transactionFilter can't see it, and
// Vim.mapCommand can't override yy. So we intercept the SECOND `y` of the chord with a
// pre-vim keymap (Prec.highest beats vim's keymap): after the first `y` vim sets
// inputState.operator='yank'; on the next `y`, if the caret is on an atom's first line and
// it's a plain, uncounted, default-register yy, we overwrite the unnamed register with the
// whole atom source (linewise) and cancel vim's pending operator with the PUBLIC
// Vim.handleKey(cm,'<Esc>') — no internal mutation. Everything else (yw/y$/yj, 3yy, "ayy,
// yy on a normal line, insert/visual mode, vim off) returns false and passes through to vim.
export const atomYank: Extension = Prec.highest(
  keymap.of([
    {
      key: "y",
      run: (view) => {
        const cm = getCM(view);
        const vim = cm?.state.vim;
        if (!vim || vim.insertMode || vim.visualMode) return false;
        const is = vim.inputState;
        if (!is || is.operator !== "yank") return false; // not the second y of a bare yy
        if (is.registerName) return false; // "ayy → let vim handle the named register
        if (is.prefixRepeat && is.prefixRepeat.length) return false; // 3yy → let vim handle the count
        const doc = view.state.doc;
        const caretLine = doc.lineAt(view.state.selection.main.head);
        const blocks = view.state.field(livePreview, false)?.blocks;
        const b = blocks?.find((bl) => doc.lineAt(bl.from).from === caretLine.from);
        if (!b) return false; // not on an atom's first line → normal yy
        const end = Math.min(b.to + 1, doc.length);
        try { Vim.getRegisterController().getRegister().setText(doc.sliceString(b.from, end), true); } catch { /* register unavailable */ }
        if (cm) Vim.handleKey(cm, "<Esc>", "mapping"); // cancel the pending yank operator
        return true;
      },
    },
  ]),
);
