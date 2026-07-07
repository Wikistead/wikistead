import { Vim, getCM } from "@replit/codemirror-vim";
import { EditorState, EditorSelection, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { livePreview, displayMode, nestedDeleteChange, enterMacroCommand } from "./decorations";
import { nestedSelectionField, setNestedSelection } from "./macro-edit";

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

// Where a plain vim `o`/`O` on an atom must open the new line (#183 symptom B / o-O): `o` opens AFTER
// the WHOLE atom, `O` BEFORE it — never INSIDE (which would split a multi-line macro and leave the
// caret at the atom's visual edge, "on its right"). Returns the doc offset to insert "\n" at, and the
// caret offset for the new empty line. Pure (offsets only) → unit-tested. `lineAt` is doc.lineAt.
export function atomOpenLineTarget(
  atom: { from: number; to: number },
  open: "o" | "O",
  lineAt: (pos: number) => { from: number; to: number },
): { insertAt: number; caret: number } {
  if (open === "o") {
    const at = lineAt(atom.to).to; // end of the atom's LAST line → newline opens the line below it
    return { insertAt: at, caret: at + 1 }; // caret on the new empty line (after the inserted \n)
  }
  const at = lineAt(atom.from).from; // start of the atom's FIRST line → newline opens the line above it
  return { insertAt: at, caret: at }; // caret on the new empty line (the atom shifts down)
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
  const doc = view.state.doc;
  const blocks = view.state.field(livePreview, false)?.blocks;
  const b = atomBlockAtCaret(blocks, view.state.selection.main.head);
  if (!b) return null; // caret not inside any atom → normal yy/dd (counts on normal lines untouched)
  // #183 symptom A: a COUNT (3dd/3yy) used to fall through to vim, which tore the macro source mid-atom
  // (broken `:::table` remnant). An atom is one indivisible unit (ADR-024 1b), so on an atom we take the
  // WHOLE atom regardless of count — never split it. (Counting the atom as 1 of N blocks — 3dd = this
  // atom + 2 more — is a v2 follow-up; v1 guarantees no syntax corruption, which was the bug.)
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
    // #216 comment 802: in vim mode, Enter (incl. Ctrl+Enter) is consumed by codemirror-vim's keydown
    // BEFORE the CM Ctrl-Enter keymap runs, so a vim user has NO way to reach a macro/table RichUI (the
    // editUI edit button is #174-gated). Intercept Ctrl/Cmd+Enter in CAPTURE phase (before vim) and route
    // it to enterMacroCommand — the same "enter the macro at the caret" the non-vim keymap gives. Only when
    // vim is ON (vim off → the normal keymap already works) and it actually entered a macro.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && getCM(view)?.state.vim && !view.state.readOnly) {
      if (enterMacroCommand(view)) { e.preventDefault(); e.stopImmediatePropagation(); }
      return;
    }
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
      // #215 / ADR-100 (Consumer 4): with a nested macro selected, `dd` removes ONLY that macro's range
      // (the caret sits on the CONTAINER atom, so the normal atomChordTarget would take the whole
      // container). Same range as Backspace/Delete (nestedDeleteChange). Guarded to a bare 2nd `d`.
      const vimD = cm?.state.vim;
      const isD = vimD?.inputState;
      const nsel = view.state.field(nestedSelectionField, false);
      if (nsel && vimD && !vimD.insertMode && !vimD.visualMode && isD?.operator === "delete" && !isD.registerName) {
        const ch = nestedDeleteChange(view.state, nsel.anchor);
        if (ch) {
          const src = view.state.doc.sliceString(ch.from, ch.to);
          const newLen = view.state.doc.length - (ch.to - ch.from);
          view.dispatch({ changes: ch, effects: setNestedSelection.of(null), selection: EditorSelection.cursor(Math.min(ch.from, newLen)) });
          try { Vim.getRegisterController().getRegister().setText(src, true); } catch { /* register unavailable */ }
          Vim.handleKey(cm!, "<Esc>", "mapping");
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
      }
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
    } else if (e.key === "o" || e.key === "O") {
      // #183 symptom B / o-O: plain o/O with the caret ON an atom must open a line AFTER (o) / BEFORE
      // (O) the WHOLE atom — vim's own o/O would open INSIDE it (splitting a multi-line macro) or leave
      // the caret at the atom's edge ("on its right"). Only plain o/O in NORMAL mode on an atom; a
      // count / operator-pending / insert/visual / not-on-atom falls through to vim unchanged.
      const vim = cm?.state.vim;
      if (!vim || vim.insertMode || vim.visualMode) return;
      const is = vim.inputState;
      if (is && (is.operator || is.registerName || (is.prefixRepeat && is.prefixRepeat.length))) return;
      const b = atomBlockAtCaret(view.state.field(livePreview, false)?.blocks, view.state.selection.main.head);
      if (!b) return; // not on an atom → let vim do a normal o/O
      const doc = view.state.doc;
      const { insertAt, caret } = atomOpenLineTarget({ from: b.from, to: b.to }, e.key as "o" | "O", (p) => doc.lineAt(p));
      view.dispatch({ changes: { from: insertAt, insert: "\n" }, selection: EditorSelection.cursor(caret) });
      Vim.handleKey(cm!, "i", "mapping"); // enter insert mode ON the new empty line (below/above the atom)
      e.preventDefault();
      e.stopImmediatePropagation(); // vim must NOT run its own o/O (would open inside the atom)
    }
  };
  view.contentDOM.addEventListener("keydown", onKeydown, true); // capture: before vim's handler
  return { destroy() { view.contentDOM.removeEventListener("keydown", onKeydown, true); } };
});

// #240: in WYSIWYG the vim NORMAL/VISUAL block ("fat") cursor paints the RAW doc char at head — so when
// the vim caret rests on a HIDDEN inline syntax offset (a link's `[` `](url)`, a `**`/`` ` `` mark), the
// glyph we hid shows up AS the cursor, and horizontal h/l stops on every hidden char (the "phantom press"
// + "raw fragment on the cursor"). Live never shows it (reveal-on-cursor); Source is raw. The wysiwyg
// caret-motion filter (wysiwygInlineSkip) can't fix this — it's a state transactionFilter and can't read
// vim mode, whose semantics differ (vim rests ON a char, the insert caret rests BETWEEN chars). This
// VIEW plugin (which CAN read vim via getCM) nudges the vim normal/visual caret OFF an inline hidden run
// onto the nearest VISIBLE char in the motion direction, so the fat cursor never paints a hidden glyph and
// h/l step by visible character. Block atoms (a table / `:::` fence the caret sits ON per ADR-024) are
// LEFT ALONE (that fat-cursor case shares its root with #238). Offset-invariant: only the caret rest moves.
export const vimWysiwygCaretGuard: Extension = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      const blank = (on: boolean) => this.view.dom.classList.toggle("cm-wys-blank-fatcursor", on);
      // #238 (review follow-up): the blank-class (and the inline nudge) must react to transitions
      // that set NEITHER selectionSet NOR docChanged — a displayMode Compartment switch (Live→WYSIWYG),
      // vim on/off, insert↔normal, and focus return all reconfigure/refocus without a selection change.
      // The earlier `if (!u.selectionSet && !u.docChanged) return` short-circuited those, so putting the
      // caret on a table then switching to WYSIWYG left the fat cursor painting `|`/`:` (class never
      // applied), and leaving WYSIWYG/vim left the class stuck. Fix: recompute the blank class on EVERY
      // update (it is cheap — facet + vim + one block scan); gate only the nudge DISPATCH below to the
      // transitions that can actually move the caret onto/off a hidden run.
      if (u.state.facet(displayMode) !== "wysiwyg") { blank(false); return; }
      const vim = getCM(u.view)?.state.vim;
      if (!vim || vim.insertMode) { blank(false); return; } // insert caret keeps between-char semantics (wysiwygInlineSkip)
      const sel = u.state.selection.main;
      const head = sel.head;
      const lp = u.state.field(livePreview, false);
      if (!lp) { blank(false); return; }
      // #238: on a BLOCK atom (a table / `:::` fence) the caret legitimately sits ON the atom (ADR-024) —
      // we must NOT move it (that would break atom motion), but the vim fat cursor would then paint the
      // atom's hidden `|` / `:`. Blank the fat-cursor GLYPH (a class → `.cm-fat-cursor { color: transparent }`)
      // while the caret is on an atom, so the block cursor stays visible but the leaked syntax char does not.
      let onBlockAtom = false;
      for (const b of lp.blocks) if (head >= b.from && head < b.to) { onBlockAtom = true; break; }
      blank(onBlockAtom);
      if (onBlockAtom) return; // don't nudge — the caret stays on the atom (ADR-024)
      // Nudge (a dispatch) only on transitions that can move the caret onto/off a hidden inline run:
      // a selection/doc change, or a mode/focus transition that brings the caret into WYSIWYG-vim on a
      // hidden run (the #240 inline case, shared per comment 943 item 3). Unrelated updates (viewport,
      // measure) don't dispatch.
      const modeChanged = u.startState.facet(displayMode) !== u.state.facet(displayMode);
      if (!u.selectionSet && !u.docChanged && !modeChanged && !u.focusChanged) return;
      // Is char[head] inside an INLINE hidden run (single-line)? If so, char[head] is a hidden glyph the
      // fat cursor would paint — move to the nearest visible char in the last motion direction.
      let run: { from: number; to: number } | null = null;
      lp.atomic.between(head, head, (from, to) => {
        if (from <= head && head < to && u.state.doc.lineAt(from).number === u.state.doc.lineAt(to).number) {
          run = { from, to };
          return false;
        }
      });
      if (!run) return;
      const r = run as { from: number; to: number };
      const prevHead = u.startState.selection.main.head;
      const dir = head >= prevHead ? 1 : -1; // forward → exit right of the run; backward → left of it
      const line = u.state.doc.lineAt(head);
      // Forward: the position AFTER the run (char[to] is the first visible char). Backward: the last
      // visible char BEFORE the run (from-1). Clamp to the line so we never jump across a line.
      const target = dir > 0 ? Math.min(r.to, line.to) : Math.max(r.from - 1, line.from);
      if (target === head) return;
      // Defer the dispatch out of the update cycle (a plugin update must not dispatch synchronously).
      queueMicrotask(() => {
        const cur = this.view.state.selection.main;
        if (cur.head !== head) return; // the caret already moved again — don't fight a newer motion
        this.view.dispatch({ selection: sel.empty ? EditorSelection.cursor(target) : EditorSelection.range(sel.anchor, target) });
      });
    }
  },
);
