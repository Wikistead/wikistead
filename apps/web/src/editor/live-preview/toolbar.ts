import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { StateField } from "@codemirror/state";
import i18n from "../../i18n";
import { vimVisualField } from "./palette";
import { INLINE_FORMATS } from "./commands";

// The selection bubble is the layer-A decoration entry for mouse/any-selection users.
// Its buttons come from the SHARED INLINE_FORMATS (ADR-018 #3) so they never drift from
// the `\` / `/` palettes — same commands, rendered here as symbols. It is A-ONLY: block
// constructs (heading, list, table, …) and inserts (image, P) are NOT here — they live
// in the `/` insert palette. This makes the on-selection menu identical across vim (`\`
// palette) and non-vim (this bubble): decoration only. Chrome only.
function mkButton(label: string, title: string, run: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "lp-toolbar-btn";
  button.textContent = label;
  button.title = title;
  // mousedown + preventDefault keeps the editor selection/focus intact so the command
  // applies to the user's current selection (and the selection bubble stays up).
  button.addEventListener("mousedown", (e) => { e.preventDefault(); run(); });
  return button;
}

// Notion/Medium-style FLOATING selection toolbar: a small bubble shown above the
// current text selection (and hidden when there is none) — no always-on ribbon.
//
// Implemented as a CodeMirror TOOLTIP, not a DOM node we inject into the editor:
// CM owns/positions its tooltip layer (scroll-safe, reconciled across updates),
// whereas an element appended into view.dom is removed by CM on the next update.
// Purely presentational — it reads the LOCAL selection and dispatches the same
// command functions, never touching transactions/awareness, so collab + presence
// are untouched.
export function floatingToolbar() {
  function bubble(from: number, to: number): Tooltip {
    return {
      pos: from,
      end: to,
      above: true,
      strictSide: false,
      arrow: false,
      create: (view) => {
        const dom = document.createElement("div");
        dom.className = "lp-toolbar";
        dom.setAttribute("data-testid", "format-bubble");
        for (const fmt of INLINE_FORMATS) dom.appendChild(mkButton(fmt.symbol, i18n.t(fmt.labelKey), () => fmt.run(view)));
        return { dom };
      },
    };
  }

  const bubbleField = StateField.define<readonly Tooltip[]>({
    create: () => [],
    update(value, tr) {
      if (!tr.docChanged && !tr.selection && !tr.effects.length) return value;
      const sel = tr.state.selection.main;
      // In vim VISUAL mode the small "\" hint takes the ribbon spot instead of this full
      // bubble (the bubble is the mouse/non-vim entry) — suppress it there.
      if (sel.empty || tr.state.field(vimVisualField, false)) return [];
      return [bubble(sel.from, sel.to)];
    },
    provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
  });

  return [bubbleField];
}
