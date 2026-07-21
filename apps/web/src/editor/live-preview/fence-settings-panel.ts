import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { StateField, StateEffect, type EditorState } from "@codemirror/state";
import { renderMacroSettings } from "./macro-settings-controls";
import { codeFenceSettings, fenceInfoOf, withFenceInfo } from "../macros/fence-settings";

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
    create(view) {
      const dom = document.createElement("div");
      dom.className = "cm-lp-fence-settings";
      dom.setAttribute("data-testid", "fence-settings-panel");
      // Keep clicks inside the panel from reaching the editor: a mousedown on the surface would move
      // the selection and close the panel out from under the control being used.
      dom.addEventListener("mousedown", (e) => e.stopPropagation());

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
