import { StateField, StateEffect, Facet, Prec, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { contextHintTooltip } from "./hint";
import { isPaletteOpen } from "./palette";
import { openMacroModal } from "./macro-modal";
import { macroFenceAt, directiveMacroAt, tableBlockAt } from "../macros/fence";
import { currentMacroTheme } from "../macros/theme";
import type { FenceMacro, DirectiveMacro, RichEditUI } from "../macros/registry";
import { eventMatches, displayChord } from "../../app/keybindings";
import i18n from "../../i18n";

// The reveal↔render toggle + caret-context hint, common to EVERY macro that declares a
// `richEditUI` (ADR-022 Part 11). Behavior is derived from `richEditUI.present`:
//   - inline (e.g. :::table): the toggle key flips the block source↔render-edit;
//   - modal (e.g. Excalidraw): the toggle key opens the modal.
// A macro author declares `present` and gets the hint + key handling for free (the
// ADR-023 exemplar). State is transient: tied to the caret, never a persisted lock.

// The resolved chord for editor.toggleMacroEdit (ADR-021 / #4), injected from React.
export const macroEditKey = Facet.define<string, string>({
  combine: (v) => (v.length ? v[v.length - 1]! : "Mod-Enter"),
});

interface Block { readonly from: number; readonly to: number; readonly macro: { richEditUI?: RichEditUI } }

// A GFM pipe table is inline-editable (cell-merge promotes it to :::table) even though
// it isn't a registry macro — present it as one so the hint + toggle apply.
const PIPE_TABLE: { richEditUI: RichEditUI } = { richEditUI: { present: "inline" } };

// The thing WITH a richEditUI covering `pos`: a fence macro, a directive macro, or a
// GFM pipe table. null otherwise.
function macroRichEditAt(state: EditorState, pos: number): Block | null {
  const f = macroFenceAt(state, pos);
  if (f?.macro.richEditUI) return { from: f.from, to: f.to, macro: f.macro };
  const d = directiveMacroAt(state, pos);
  if (d?.macro.richEditUI) return { from: d.from, to: d.to, macro: d.macro };
  const t = tableBlockAt(state, pos);
  if (t && t.tier === "pipe") return { from: t.from, to: t.to, macro: PIPE_TABLE };
  return null;
}

// The block the user toggled into inline render-edit mode (null = none). Transient:
// mapped through edits, cleared when the caret leaves it. Used by the table renderer.
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

// The "<key> edit" hint when the caret sits on a richEditUI macro (palette closed, not
// already inline-editing). Registry-driven: macros without a richEditUI (callout,
// mermaid) get no hint. Same tooltip layer/style as the vim-`\` hint.
const macroEditHintField = StateField.define<readonly Tooltip[]>({
  create: () => [],
  update(_value, tr) {
    const sel = tr.state.selection.main;
    if (!sel.empty || tr.state.readOnly) return [];
    if (isPaletteOpen(tr.state) || tr.state.field(macroRenderActiveField)) return [];
    const m = macroRichEditAt(tr.state, sel.head);
    if (!m) return [];
    const key = tr.state.facet(macroEditKey);
    return [contextHintTooltip(m.from, i18n.t("palette.macroEditHint", { key: displayChord(key) }), "macro-edit-hint")];
  },
  provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
});

const macroEditKeymap = Prec.high(
  EditorView.domEventHandlers({
    keydown(e, view) {
      if (view.state.readOnly) return false;
      // Esc exits an inline edit session (render-active) — the explicit way out besides
      // the Done button (#2: you stay in edit mode until you exit).
      if (e.key === "Escape" && view.state.field(macroRenderActiveField)) {
        view.dispatch({ effects: setMacroRenderActive.of(null) });
        return true;
      }
      if (!eventMatches(e, view.state.facet(macroEditKey))) return false;
      const sel = view.state.selection.main;
      if (!sel.empty) return false;
      const m = macroRichEditAt(view.state, sel.head);
      if (!m?.macro.richEditUI) return false;
      e.preventDefault();
      if (m.macro.richEditUI.present === "modal") {
        // modal macros are fence macros (Excalidraw); openMacroModal re-derives the range.
        openMacroModal(view, m.macro as FenceMacro, () => view.state.selection.main.head, currentMacroTheme());
      } else {
        const active = view.state.field(macroRenderActiveField);
        view.dispatch({ effects: setMacroRenderActive.of(active ? null : { from: m.from, to: m.to }) });
      }
      return true;
    },
  }),
);

export function macroEdit(key: string): Extension {
  return [macroEditKey.of(key), macroRenderActiveField, macroEditHintField, macroEditKeymap];
}
