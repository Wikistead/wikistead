import { Vim, getCM } from "@replit/codemirror-vim";
import { EditorState, EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { livePreview, displayMode, nestedDeleteChange, enterMacroCommand, atomSelectableSelectedAt, isInlineAtom } from "./decorations";
import { nestedSelectionField, setNestedSelection, macroRenderActiveField } from "./macro-edit";

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
    // #278point 3: a NESTED editor (slot island / editUI source pane) lives INSIDE this
    // contentDOM, so its keys reach this capture listener too — while the OUTER caret is parked on
    // the container atom. An island `o` was then handled HERE (outer "open line after the atom"),
    // rewriting the outer doc and rebuilding the container widget → the island died mid-keystroke
    // (the reported "vim o on the island's bottom line can't add a line"). Keys that originate in a
    // nested editor belong to that editor's own vim — ignore them here.
    const src = e.target as HTMLElement | null;
    if (src && src !== view.contentDOM && src.closest(".cm-content") !== view.contentDOM) return;
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
    } else if (e.key === "j" || e.key === "k") {
      // #359symptom 1: ADJACENT atoms chain CM's atomicRanges skip — with three touching
      // mermaid blocks one `j` jumped across ALL of them (atom1's exit lands inside atom2 → skip →
      // atom3 → …). Gap-separated atoms are fine (the skip exits onto the landable line between), so
      // this intercepts ONLY the chained case: when a plain j/k would enter an atom that TOUCHES
      // another atom (an adjacency cluster), step ONE atom per press — land ON the entered atom's
      // near edge (ADR-024: caret rests on the atom = selected; from above its first line, from
      // below its last). Solitary/gapped atoms keep vim's default skip-over (the existing pins).
      const vim = cm?.state.vim;
      if (!vim || vim.insertMode) return;
      if (vim.visualBlock) return; // rectangle semantics — leave to vim
      const is = vim.inputState;
      if (is && (is.operator || is.registerName || (is.prefixRepeat && is.prefixRepeat.length))) return; // dj/3j/"aj → vim
      const lp = view.state.field(livePreview, false);
      const blocks = lp?.blocks;
      if (!blocks?.length) return;
      const doc = view.state.doc;
      const sel = view.state.selection.main;
      const dir = e.key === "j" ? 1 : -1;
      const blockAt = (pos: number) => blocks.find((b) => pos >= b.from && pos <= b.to) ?? null;
      const cur = blockAt(sel.head);
      // the line a plain j/k would step onto (from ON an atom: the line beyond the whole atom)
      const edgeLineNum = cur
        ? (dir > 0 ? doc.lineAt(cur.to).number + 1 : doc.lineAt(cur.from).number - 1)
        : doc.lineAt(sel.head).number + dir;
      if (edgeLineNum < 1 || edgeLineNum > doc.lines) return; // doc edge → vim
      const entered = blockAt(doc.line(edgeLineNum).from);
      if (!entered) return; // stepping onto a plain line → vim's default
      // adjacency cluster check: does the entered atom TOUCH another atom on either side?
      const touches = blocks.some((x) => {
        if (x === entered) return false;
        return doc.lineAt(entered.to).number + 1 === doc.lineAt(x.from).number
          || doc.lineAt(x.to).number + 1 === doc.lineAt(entered.from).number;
      });
      if (!touches && !cur) return; // solitary atom entered from a plain line → default skip-over (pinned)
      if (!touches && cur) return;  // leaving an atom onto a solitary atom is impossible here (no gap ⇒ touches)
      // land ON the entered atom (near edge in the motion direction); visual keeps its anchor.
      //`visualMode && !sel.empty` dropped the selection on the FIRST motion after `v`. Pressing
      // `v` puts vim in visual mode without touching CodeMirror's selection — the range only appears
      // once something moves — so the first j landed in the cursor() branch and collapsed the selection
      // that was about to grow. Every following j saw an empty selection too, so from a line above an
      // adjacent cluster the selection never grew at all: measured as "the selection cancels itself".
      // Visual mode alone decides the shape; when the range is still empty its anchor IS the caret vim
      // will grow from, so one expression serves both.
      const caretPos = dir > 0 ? entered.from : doc.lineAt(entered.to).from;
      view.dispatch({
        selection: vim.visualMode
          ? EditorSelection.range(sel.anchor, caretPos)
          : EditorSelection.cursor(caretPos),
        scrollIntoView: true,
      });
      e.preventDefault();
      e.stopImmediatePropagation(); // vim must NOT also run its own j/k (would chain-skip the cluster)
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
// #332when the caret rests on a SELECTED atomSelectable atom (embed-page), the vim fat cursor's pink
// BACKGROUND block (a 1-char bar from @replit/codemirror-vim) sits on the wide card, and its glyph blanking is
// timing-fragile (CM strips a classList-toggled class during the focus rebuild). Suppress the whole fat cursor
// there via `EditorView.editorAttributes` — CM MERGES editorAttributes into `view.dom` on every update INCLUDING
// the focus rebuild, so the class survives without a re-pin (thetiming bug). Gated to the empty-caret /
// vim-normal / non-source / on-a-block case before the (rare) full-doc directive scan. Plain block atoms (table
// cell, non-atomSelectable `:::`) keep their fat cursor — this only fires for a selected atomSelectable atom.
const atomSelHideFatCursor: Extension = EditorView.editorAttributes.of((view): Record<string, string> | null => {
  const vim = getCM(view)?.state.vim;
  if (!vim || vim.insertMode) return null;
  const s = view.state.selection.main;
  if (!s.empty) return null;
  if (view.state.facet(displayMode) === "source") return null;
  const lp = view.state.field(livePreview, false);
  if (!lp || !lp.blocks.some((b) => s.head >= b.from && s.head < b.to)) return null;
  return atomSelectableSelectedAt(view.state, s.head) ? { class: "cm-atomsel-hide-fatcursor" } : null;
});

// #543(vim × Live in a slot island): the blank class used to be classList.toggle'd from a
// ViewPlugin's update() — TWO timing holes the island exposed at once: (a) an island can mount, focus
// and PAINT without a single transaction, so update() never ran and the vim fat cursor painted the raw
// fence char under the mount caret (the user's lone "`"); (b) even after a sync-at-construction patch,
// CM REBUILDS view.dom's className on the focus update and wipes a manually-toggled class (the
// fragility this file already names). atomSelHideFatCursor solved the same two holes with
// EditorView.editorAttributes — evaluated at construction AND re-merged on every rebuild — so the
// blank guard now rides the same primitive. The predicate is unchanged (#238 block atoms + #278
// fence lines, never in Source); only the delivery mechanism moved.
function blankFatCursorAt(view: EditorView): boolean {
  const state = view.state;
  const mode = state.facet(displayMode);
  if (mode === "source") return false; // Source: the char under the cursor is real text
  const vim = getCM(view)?.state.vim;
  if (!vim || vim.insertMode) return false;
  const head = state.selection.main.head;
  const lp = state.field(livePreview, false);
  let onBlockAtom = false;
  if (lp) {
    // #506: only full-line/multi-line block atoms are caret rests; inline atoms fall through.
    for (const b of lp.blocks) if (head >= b.from && head < b.to && !isInlineAtom(state.doc, b)) { onBlockAtom = true; break; }
    // RichUI: Ctrl+Enter expands table-edit but the CM caret can remain on the atom's range.
    if (!onBlockAtom) {
      const active = state.field(macroRenderActiveField, false);
      if (active && head >= active.from && head <= active.to) onBlockAtom = true;
    }
  }
  // #278a fence line is macro syntax whether the widget is rendered or revealed — one rule,
  // "never paint a fence character" (Source exempt, handled above).
  const onFenceLine = /^\s*(?::{3,}|`{3,})/.test(state.doc.lineAt(head).text);
  return onBlockAtom || onFenceLine;
}
export const vimWysiwygCaretGuard: Extension = [atomSelHideFatCursor, EditorView.editorAttributes.of(
  (view): Record<string, string> | null => (blankFatCursorAt(view) ? { class: "cm-wys-blank-fatcursor" } : null),
)];
