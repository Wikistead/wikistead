import { StateField, StateEffect, Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { currentMacroTheme } from "../macros/theme";
import type { InnerEditHost, MacroTier, MacroLevel } from "../macros/registry";

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

// ADR-025 step 3: auto-demote `source` to the LOWEST tier level that can represent it (open
// formats — persist the most portable form). `cap` is a pass-through SEAM: the highest level
// allowed. Today no caller sets it, so the true lowest representable level always wins; a
// later restriction ADR will supply a real cap (plan/policy) plus its UI and enforcement.
// If nothing at or below the cap can represent the source, we best-effort write at the cap.
export function applyTier(tier: MacroTier, source: string, cap?: MacroLevel): string {
  const levels = tier.levels;
  const capIdx = cap ? Math.max(0, levels.findIndex((l) => l.id === cap.id)) : levels.length - 1;
  for (let i = 0; i <= capIdx; i++) {
    if (tier.canRepresentAt(source, levels[i]!)) return tier.toLevel(source, levels[i]!);
  }
  return tier.toLevel(source, levels[capIdx]!);
}

// ADR-025 step 1: build the narrow InnerEditHost for an inline macro editor at [from, to].
// The editor commits via replaceSource (one offset-invariant range edit, per-op LWW) and
// leaves via exit() — it never touches the EditorView/Yjs directly. `to` is the block's
// range at mount; each commit re-points render-active to the rewritten range, and the widget
// (hence host) is recreated for the next op, so the captured range stays correct.
// ADR-025 step 3: when the macro declares a `tier`, the host AUTO-DEMOTES the committed source
// to the lowest representable level (the editor hands over a lossless form; the host owns the
// level decision — the editor no longer hardcodes pipe-vs-:::table). `levelCap` is the
// pass-through cap seam (see applyTier).
export function makeInnerEditHost(
  view: EditorView,
  from: number,
  to: number,
  tier?: MacroTier,
  levelCap?: MacroLevel,
): InnerEditHost {
  return {
    theme: currentMacroTheme(),
    getSource: () => view.state.doc.sliceString(from, Math.min(to, view.state.doc.length)),
    replaceSource: (next: string) => {
      const leveled = tier ? applyTier(tier, next, levelCap) : next;
      view.dispatch({ changes: { from, to, insert: leveled }, effects: setMacroRenderActive.of({ from, to: from + leveled.length }) });
      view.focus();
    },
    exit: () => {
      view.dispatch({ effects: setMacroRenderActive.of(null) });
      view.focus();
    },
  };
}
