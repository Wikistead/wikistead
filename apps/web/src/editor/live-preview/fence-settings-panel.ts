import { EditorView, showTooltip, keymap, type Tooltip } from "@codemirror/view";
import { StateField, StateEffect, Prec, type EditorState, type Extension } from "@codemirror/state";
import { renderMacroSettings } from "./macro-settings-controls";
import { codeFenceSettings, fenceInfoOf, withFenceInfo } from "../macros/fence-settings";
import { codeFenceOpeningAt } from "./context-menu";
import i18n from "../../i18n";

// #456 S4 (second half): the mounting path for a code fence's declared settings. The panel lives in
// CodeMirror's TOOLTIP layer, not as a child of the block — CM reconciles its own DOM away, so
// persistent floating UI parented to a widget disappears on the next update (the lesson from the
// floating format bubble). The tooltip layer is CM's own place for exactly this.
//
// What is rendered comes from the macro's declaration (fence-settings.ts) via the shared renderer;
// this file only decides WHERE and WHEN. Opening is a state effect, so it survives document changes
// the same way the slash palette does, and every write goes back through the macro's own `write`.

export const openFenceSettings = StateEffect.define<number>(); // the opening fence line's offset
export const closeFenceSettings = StateEffect.define<null>();

function fenceLineAt(state: EditorState, pos: number): { from: number; to: number; text: string } | null {
  const line = state.doc.lineAt(Math.min(Math.max(pos, 0), state.doc.length));
  return /^(\s*)([`~]{3,})/.test(line.text) ? { from: line.from, to: line.to, text: line.text } : null;
}

function settingsTooltip(pos: number): Tooltip {
  return {
    pos,
    above: false,
    arrow: true,
    // #456 rev (review ②): the panel's own surface replaces CM's default `.cm-tooltip` chrome, which is
    // stripped via `.cm-tooltip:has(.cm-lp-fence-settings)` in callout-icons.css (no "second box" double-frame).
    create(view) {
      const dom = document.createElement("div");
      dom.className = "cm-lp-fence-settings";
      dom.setAttribute("data-testid", "fence-settings-panel");
      // Keep clicks inside the panel from reaching the editor: a mousedown on the surface would move
      // the selection and close the panel out from under the control being used.
      dom.addEventListener("mousedown", (e) => e.stopPropagation());
      const dismiss = () => { view.dispatch({ effects: closeFenceSettings.of(null) }); view.focus(); };
      // #456 item 3: an explicit way OUT. The panel deliberately does not close itself when you use
      // a control (its writes ARE document changes), so it needs a close affordance the user drives — a ✕
      // in the header, and Escape while focus is inside the panel. Escape bubbles here from any control.
      dom.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dismiss(); }
      });

      const header = document.createElement("div");
      header.className = "cm-lp-fence-settings-head";
      const title = document.createElement("span");
      title.className = "cm-lp-fence-settings-title";
      title.textContent = i18n.t("contextMenu.codeSettings");
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "cm-lp-fence-settings-close";
      closeBtn.setAttribute("data-testid", "fence-settings-close");
      closeBtn.setAttribute("aria-label", i18n.t("common.close"));
      closeBtn.textContent = "×"; // ×
      closeBtn.addEventListener("click", (e) => { e.preventDefault(); dismiss(); });
      header.append(title, closeBtn);
      dom.append(header);

      const line = fenceLineAt(view.state, pos);
      const panel = renderMacroSettings(codeFenceSettings, fenceInfoOf(line?.text ?? ""), (next) => {
        const now = fenceLineAt(view.state, pos); // re-read: the doc may have moved since mount
        if (!now) return;
        const rewritten = withFenceInfo(now.text, next);
        if (rewritten === now.text) return;
        // One offset-invariant replacement of the opening line — the body is never touched.
        view.dispatch({ changes: { from: now.from, to: now.to, insert: rewritten }, userEvent: "input" });
      });
      dom.append(panel.dom);
      // Opened from the keyboard, focus lands inside the panel so it can be Tab-navigated and Escape-closed
      // without a mouse. Opened by mouse, focusing the first control is harmless (the click intent WAS to edit).
      queueMicrotask(() => (dom.querySelector("select, input, button:not(.cm-lp-fence-settings-close)") as HTMLElement | null)?.focus());
      return { dom, destroy: () => panel.destroy() };
    },
  };
}

// Open while the effect says so; close on an explicit close, or when the fence it belongs to is gone.
export const fenceSettingsField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(openFenceSettings)) return e.value;
      if (e.is(closeFenceSettings)) return null;
    }
    if (value == null) return null;
    const moved = tr.changes.mapPos(value, -1);
    return fenceLineAt(tr.state, moved) ? moved : null;
  },
  provide: (f) =>
    showTooltip.compute([f], (state) => {
      const at = state.field(f);
      return at == null ? null : settingsTooltip(at);
    }),
});

export function toggleFenceSettings(view: EditorView, pos: number): boolean {
  if (!fenceLineAt(view.state, pos)) return false;
  const open = view.state.field(fenceSettingsField, false);
  view.dispatch({ effects: open == null ? openFenceSettings.of(pos) : closeFenceSettings.of(null) });
  return true;
}

// #456 item 2: a KEYBOARD path to the settings. Right-click was the only way in; this opens the panel
// for the code fence the caret sits in (anywhere in the block, opening line or body). Returns false when the
// caret is not in a code fence, so the key falls through to whatever else wants it.
function openFenceSettingsAtCaret(view: EditorView): boolean {
  const at = codeFenceOpeningAt(view.state, view.state.selection.main.head);
  if (at == null) return false;
  if (view.state.field(fenceSettingsField, false) != null) return false; // already open — don't toggle it shut
  view.dispatch({ effects: openFenceSettings.of(at) });
  return true;
}

// #456 rev: the discoverable ✎ affordance moved from a floating hoverTooltip into the code HEADER chrome
// (buildFenceHeader, next to the copy button — see decorations.ts FenceHeaderWidget). It is now always
// visible when the block renders (caret/keyboard users, not only mouse hover — review ④), so the old
// `fenceBlockRange` + `fenceSettingsHint` hoverTooltip are retired.

// The whole code-fence settings feature as one extension: the panel field + the keyboard opener. The ✎ hint
// now lives in the header chrome (decorations.ts). Registered in edit mode only (see editor-livepreview).
export function codeFenceSettingsPanel(): Extension {
  return [
    fenceSettingsField,
    Prec.high(keymap.of([{ key: "Mod-Alt-Enter", run: openFenceSettingsAtCaret }])),
    // #456 rev (review ①): the ✎ affordance moved OUT of a floating hoverTooltip and INTO the code
    // header chrome (buildFenceHeader, next to the copy button — decorations.ts FenceHeaderWidget), so it sits
    // in the same top-right corner group and is visible to caret/keyboard users, not only on mouse hover (④).
    // The former `fenceSettingsHint()` hoverTooltip is retired.
  ];
}
