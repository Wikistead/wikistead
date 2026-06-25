import { StateField, StateEffect, Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

// Inline rich-edit state for macros (ADR-022 Part 11, mode-based). The editor is entered
// by a mouse CLICK on the macro (handled in decorations.ts) — there is no Ctrl+Enter
// toggle. This module owns the transient "which block is in inline edit mode" state and
// the Esc-to-exit key. `present` (inline/modal) still decides how a click edits, derived
// from the registry (ADR-023 exemplar).

// The block in inline render-edit mode (null = none). Transient: mapped through edits,
// cleared when the caret leaves it. Read by the table renderer (tryTableEdit).
export const setMacroRenderActive = StateEffect.define<{ from: number; to: number } | null>();
export const macroRenderActiveField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMacroRenderActive)) return e.value;
    if (!value) return null;
    let v = value;
    if (tr.docChanged) v = { from: tr.changes.mapPos(v.from, 1), to: tr.changes.mapPos(v.to, -1) };
    if (tr.selection) {
      const h = tr.newSelection.main.head;
      if (h < v.from || h > v.to) return null; // caret left → back to normal render
    }
    return v;
  },
});

// Esc exits an inline edit session (the explicit way out besides the Done button; edit
// mode otherwise persists across operations — ADR-022 review #2).
const escExit = Prec.high(
  EditorView.domEventHandlers({
    keydown(e, view) {
      if (e.key === "Escape" && !view.state.readOnly && view.state.field(macroRenderActiveField)) {
        view.dispatch({ effects: setMacroRenderActive.of(null) });
        return true;
      }
      return false;
    },
  }),
);

export const macroEdit: Extension = [macroRenderActiveField, escExit];
