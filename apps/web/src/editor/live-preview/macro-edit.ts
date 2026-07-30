import { StateField, StateEffect, Prec, EditorSelection, type EditorState, type Extension } from "@codemirror/state";
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
      // #278point 3: clear only when the head actually MOVED. A same-position selection
      // re-assert (consumeReAnchor's stale-caret redraw, #340 — fired by the shared block
      // ResizeObserver when the ISLAND's own growth resizes the container) is not the user
      // leaving; with the outer caret parked outside the container (a slot click never moves
      // it), that re-assert used to clear this field and kill the island mid-keystroke. A real
      // leave moves the head (click / motion), and the island blur-commit path also closes it.
      const h = tr.newSelection.main.head;
      if (h !== tr.startState.selection.main.head && (h < v.container.from || h > v.container.to)) return null;
    }
    return v;
  },
});

// #278 §2a / ADR-122: which layout slot (a column / tab BODY, not a nested macro) is being edited inline by a
// CM6 island. `container` = the columns/tabs atom's [from,to] (clears when the caret leaves it); `index` = the
// 0-based child index. Display state only (drives which cell swaps its render for the island); the actual edit
// is a single offset-invariant Y.Text replace of the slot's body range on commit (single Y.Text untouched —
// no 2nd CRDT, the island commits via its onCommit only). Cleared on Esc / caret-leave, mapped on doc change.
// #556: `caretAnchor` (optional) = the absolute doc position of the nested macro the OPENING CLICK landed
// on (resolved from its `[data-mac-pos]` tag, shifted to click time). The island mount maps it into the
// island's own doc so the block the user clicked is the block that comes up selected — without it the
// island opened with its caret at the top and the FIRST macro in the slot lit up regardless of the target.
export type SlotEdit = { container: { from: number; to: number }; index: number; caretAnchor?: number | null };
export const setSlotEditActive = StateEffect.define<SlotEdit | null>();
export const slotEditField = StateField.define<SlotEdit | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSlotEditActive)) return e.value;
    if (!value) return null;
    let v = value;
    if (tr.docChanged) v = { ...v, container: { from: tr.changes.mapPos(v.container.from, 1), to: tr.changes.mapPos(v.container.to, -1) }, caretAnchor: v.caretAnchor != null ? tr.changes.mapPos(v.caretAnchor) : v.caretAnchor };
    if (tr.selection) {
      // #278point 3: clear only when the head actually MOVED. A same-position selection
      // re-assert (consumeReAnchor's stale-caret redraw, #340 — fired by the shared block
      // ResizeObserver when the ISLAND's own growth resizes the container) is not the user
      // leaving; with the outer caret parked outside the container (a slot click never moves
      // it), that re-assert used to clear this field and kill the island mid-keystroke. A real
      // leave moves the head (click / motion), and the island blur-commit path also closes it.
      const h = tr.newSelection.main.head;
      if (h !== tr.startState.selection.main.head && (h < v.container.from || h > v.container.to)) return null;
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
        if (view.state.field(slotEditField)) { // #278 §2a: back out of an inline slot-edit island first
          view.dispatch({ effects: setSlotEditActive.of(null) });
          view.focus();
          return true;
        }
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
          // #283: a FENCE macro's active-raw exit moved the caret to its opening line. #243 (ADR-111 C1/C4):
          // mermaid/plantuml raw is now the CARET-IN reveal (no `active`), and Ctrl+Enter/✎ open the editUI
          // (which handles its own Escape) — so this active-based fence path is no longer reached for them; it
          // stays as the table exit + a safety net for any active fence. A callout keeps its caret (raw-on-exit).
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

export const macroEdit: Extension = [macroRenderActiveField, nestedSelectionField, nestedEditActiveField, slotEditField, escExit];

// #502 / ADR-184 slice 1: the anchor of the text-body EDIT ISLAND the local user currently has open —
// a layout slot (slotEditField), a nested editUI island (nestedEditActiveField), or a revealed top-level
// macro body (macroRenderActiveField) — or null when none is open. It is published on page awareness (the
// additive `macroEdit` field, via macroPresencePublisher) so peers render the #453 occupancy chip for
// INLINE islands too, not only the Excalidraw MODAL (which publishes the same field from macro-modal.ts).
// This is also the co-occupancy signal ADR-184's later ephemeral-shared-doc slices build on.
//
// The value is an absolute doc offset INSIDE the occupied block (the same absolute-offset form the modal
// uses — `String(start.from)`); resolvePresenceBlocks maps it back to a block. It inherits the modal's
// known containing-block drift under concurrent outer edits (ADR-184 open point 4) — no worse than the
// modal chip, and deliberately not improved here. Order matters: the innermost open island wins (a slot /
// nested island sits INSIDE a container whose macroRenderActiveField may also be set), so the more specific
// fields are checked first.
//
// Scope note (honest framing): `macroRenderActiveField` is also set for a revealed TABLE (openTableEditing)
// and a fence CODE block, so the occupancy CHIP appears for those too — which is fine and additive (it just
// means "a peer is editing in here", the #453 signal). ADR-184 §4's "table follows separately" concerns the
// CARET / ephemeral-shared-doc (which needs table cell-position vocabulary), a LATER slice — not this chip.
export function islandEditAnchor(state: EditorState): string | null {
  const slot = state.field(slotEditField, false);
  if (slot) return String(slot.container.from);
  const nested = state.field(nestedEditActiveField, false);
  if (nested) return String(nested.anchor);
  const active = state.field(macroRenderActiveField, false);
  if (active) return String(active.from);
  return null;
}

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

// #502 Option B (ADR-184 addendum 2): the SMALLEST offset-invariant edit that turns `old` into `next`,
// found by trimming their common prefix and common suffix. A RichUI (the table grid) hands over its WHOLE
// re-serialised source on every op; dispatching that as a whole-block replace CLOBBERS a peer who is
// concurrently editing ELSEWHERE in the same block (last-writer-wins on the canonical Y.Text). Writing
// only the changed middle instead lets the peer's disjoint edit survive the yCollab merge — the
// mixed-modality co-edit convergence, with canonical as the single source of truth (no second CRDT). The
// prefix/suffix are compared by UTF-16 code unit (CM offsets are code-unit based, so the returned range is
// a valid document range). A no-op (old === next) returns an empty change at the block end.
export function minimalChange(old: string, next: string, base: number): { from: number; to: number; insert: string } {
  const oldLen = old.length, nextLen = next.length;
  let p = 0;
  const maxP = Math.min(oldLen, nextLen);
  while (p < maxP && old.charCodeAt(p) === next.charCodeAt(p)) p++;
  let s = 0;
  const maxS = Math.min(oldLen - p, nextLen - p); // never let the suffix overlap the matched prefix
  while (s < maxS && old.charCodeAt(oldLen - 1 - s) === next.charCodeAt(nextLen - 1 - s)) s++;
  return { from: base + p, to: base + oldLen - s, insert: next.slice(p, nextLen - s) };
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
      // #502 Option B: write the MINIMAL diff against the block's current text, not a whole-block replace,
      // so a peer editing another cell of the same table isn't clobbered (their disjoint edit survives the
      // yCollab merge). render-active still re-points at the whole block's new range [from, from+len].
      const clampedTo = Math.min(to, view.state.doc.length);
      const cur = view.state.doc.sliceString(from, clampedTo);
      const ch = minimalChange(cur, leveled, from);
      view.dispatch({ changes: ch, effects: setMacroRenderActive.of({ from, to: from + leveled.length }) });
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
