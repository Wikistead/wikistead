import { StateField, StateEffect, Prec, EditorSelection, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { currentMacroTheme } from "../macros/theme";
import type { InnerEditHost, MacroTier, MacroLevel, MacroSource } from "../macros/registry";
import { asMacroSource } from "../macros/registry";
import { tableBlockAt, macroFenceAt } from "../macros/fence";
import { Vim, getCM } from "@replit/codemirror-vim";

// Inline rich-edit state for macros (ADR-022 Part 11, mode-based). The editor is entered
// by a mouse CLICK on the macro (handled in decorations.ts) — there is no Ctrl+Enter
// toggle. This module owns the transient "which block is in inline edit mode" state and
// the Esc-to-exit key. `present` (inline/modal) still decides how a click edits, derived
// from the registry (ADR-023 exemplar).

// The block in inline render-edit mode (null = none). Transient: mapped through edits,
// cleared when the caret leaves it. Read by the table renderer (tryTableEdit).
// #174 / ADR-087 addendum: `raw` distinguishes HOW a ``` -notation macro (mermaid/plantuml/code) is
// entered — Ctrl+Enter reveals the RAW source (vim-editable), the ✎ edit button opens the rich editUI.
// Absent/false → the existing behaviour (editUI for an editUI macro, raw for a legacy source macro).
export const setMacroRenderActive = StateEffect.define<{ from: number; to: number; raw?: boolean } | null>();
export const macroRenderActiveField = StateField.define<{ from: number; to: number; raw?: boolean } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMacroRenderActive)) return e.value;
    if (!value) return null;
    let v = value;
    if (tr.docChanged) v = { from: tr.changes.mapPos(v.from, 1), to: tr.changes.mapPos(v.to, -1), raw: value.raw };
    if (tr.selection) {
      const h = tr.newSelection.main.head;
      if (h < v.from || h > v.to) return null; // caret left → back to normal render
    }
    return v;
  },
});

// #215 / ADR-100: nested-macro parity inside an ATOMIC container widget (columns/tabs). The
// container's interior is NOT caret-addressable (Option B(i), #196), so a nested macro can't be
// selected via the caret → ring path. Instead a display-only field tracks the selected nested
// macro: `nested` = the innermost macro's [from,to] (drives which subtree draws the ring), `anchor`
// = one absolute doc offset guaranteed INSIDE that macro (consumers re-resolve the live range from
// it — drift-tolerant, mirrors changeEmbedTarget), `container` = the atomic widget's [from,to]
// (clears the selection when the caret leaves the container). Single Y.Text untouched: this is pure
// display state; edit/delete are plain offset-invariant range edits located by the #185 resolver.
export type NestedSelection = { nested: { from: number; to: number }; anchor: number; container: { from: number; to: number } };
const mapNested = (v: NestedSelection, tr: { changes: import("@codemirror/state").ChangeDesc }): NestedSelection => ({
  nested: { from: tr.changes.mapPos(v.nested.from, 1), to: tr.changes.mapPos(v.nested.to, -1) },
  anchor: tr.changes.mapPos(v.anchor, 1),
  container: { from: tr.changes.mapPos(v.container.from, 1), to: tr.changes.mapPos(v.container.to, -1) },
});
export const setNestedSelection = StateEffect.define<NestedSelection | null>();
export const nestedSelectionField = StateField.define<NestedSelection | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setNestedSelection)) return e.value;
    if (!value) return null;
    let v = value;
    if (tr.docChanged) v = mapNested(v, tr);
    if (tr.selection) {
      const h = tr.newSelection.main.head;
      if (h < v.container.from || h > v.container.to) return null; // caret left the container → clear
    }
    return v;
  },
});

// #215 / ADR-100 (Consumer 2): which nested subtree is swapped for its editUI island (null = none).
// Same shape as nestedSelectionField; separate from macroRenderActiveField so nested edit does not
// cross-talk with the top-level render-active branch. Cleared on Esc (below) and when the caret
// leaves the container.
export const setNestedEditActive = StateEffect.define<NestedSelection | null>();
export const nestedEditActiveField = StateField.define<NestedSelection | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setNestedEditActive)) return e.value;
    if (!value) return null;
    let v = value;
    if (tr.docChanged) v = mapNested(v, tr);
    if (tr.selection) {
      const h = tr.newSelection.main.head;
      if (h < v.container.from || h > v.container.to) return null;
    }
    return v;
  },
});

// Esc exits an inline edit session (the explicit way out besides the Done button; edit
// mode otherwise persists across operations — ADR-022 review #2).
const escExit = Prec.high(
  EditorView.domEventHandlers({
    keydown(e, view) {
      if (e.key === "Escape" && !view.state.readOnly) {
        if (view.state.field(nestedEditActiveField)) { // #215: back out of a nested editUI island first
          view.dispatch({ effects: setNestedEditActive.of(null) });
          return true;
        }
        const active = view.state.field(macroRenderActiveField);
        if (active) {
          // #283: in vim, this Esc was SWALLOWED (return true), so codemirror-vim never saw it and the raw
          // edit session left vim stuck in INSERT mode (a second Esc was needed). Forward the Esc to vim
          // first so one press both exits raw AND returns to normal. No-op in normal mode / non-vim.
          const cm = getCM(view);
          if (cm?.state.vim) { try { Vim.handleKey(cm, "<Esc>", "mapping"); } catch { /* vim unavailable */ } }
          // #216 comment 820: exiting a TABLE's RichUI returns to the RENDERED widget. A pipe table shows
          // raw while the caret is inside it, so move the caret PAST the table so it re-renders as a widget.
          // #283: a FENCE macro (mermaid/plantuml) must also normalize the caret — otherwise it lingers on a
          // hidden body line INSIDE the re-rendered atom (the #271 trapped-caret state, via Esc). Move it to
          // the atom's near edge (its opening line). A callout keeps its caret (raw-on-exit is its behaviour).
          const isTable = !!tableBlockAt(view.state, active.from);
          const exitTo = isTable
            ? Math.min(active.to + 1, view.state.doc.length)
            : macroFenceAt(view.state, active.from)
              ? active.from
              : null;
          view.dispatch({
            effects: setMacroRenderActive.of(null),
            ...(exitTo != null ? { selection: EditorSelection.cursor(exitTo) } : {}),
          });
          return true;
        }
      }
      return false;
    },
  }),
);

export const macroEdit: Extension = [macroRenderActiveField, nestedSelectionField, nestedEditActiveField, escExit];

// ADR-025 step 3: auto-demote `source` to the LOWEST tier level that can represent it (open
// formats — persist the most portable form). `cap` is a pass-through SEAM: the highest level
// allowed. Today no caller sets it, so the true lowest representable level always wins; a
// later restriction ADR will supply a real cap (plan/policy) plus its UI and enforcement.
// If nothing at or below the cap can represent the source, we best-effort write at the cap.
export function applyTier(tier: MacroTier, source: MacroSource, cap?: MacroLevel): MacroSource {
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
    getSource: () => asMacroSource(view.state.doc.sliceString(from, Math.min(to, view.state.doc.length))),
    replaceSource: (next: MacroSource) => {
      const leveled = tier ? applyTier(tier, next, levelCap) : next;
      view.dispatch({ changes: { from, to, insert: leveled }, effects: setMacroRenderActive.of({ from, to: from + leveled.length }) });
      view.focus();
    },
    exit: () => {
      view.dispatch({ effects: setMacroRenderActive.of(null) });
      view.focus();
    },
    // #153 / ADR-054: focus delegation for in-editor WYSIWYG cell editing. Focus/selection ONLY —
    // no dispatch/state/Yjs here. The M1 spike proved CM does NOT reclaim focus from a nested
    // contenteditable island inside an atomic widget (root contenteditable=false + ignoreEvent),
    // so this is thin: hand focus to `target`; end() returns focus to the editor. The inner
    // editor commits its text via replaceSource (one Y.Text edit); it never writes Yjs itself.
    beginTextEdit: (target: HTMLElement) => {
      target.focus();
      return { end: () => view.focus() };
    },
  };
}
