import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { StateField } from "@codemirror/state";
import i18n from "../../i18n";
import { vimKeyboardVisual } from "./palette";
import { INLINE_FORMATS } from "./commands";
import { formatButtonContent } from "./format-preview";

// The selection bubble is the layer-A decoration entry for mouse/any-selection users.
// Its buttons come from the SHARED INLINE_FORMATS (ADR-018 #3) so they never drift from
// the `\` / `/` palettes — same commands, rendered here as symbols. It is A-ONLY: block
// constructs (heading, list, table, …) and inserts (image, P) are NOT here — they live
// in the `/` insert palette. This makes the on-selection menu identical across vim (`\`
// palette) and non-vim (this bubble): decoration only. Chrome only.
function mkButton(content: string | HTMLElement, title: string, run: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "lp-toolbar-btn";
  // #612: a button may carry a styled PREVIEW element now, not only a text glyph
  if (typeof content === "string") button.textContent = content;
  else button.appendChild(content);
  button.dataset.tip = title; // #530
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
        for (const fmt of INLINE_FORMATS) dom.appendChild(mkButton(formatButtonContent(fmt), i18n.t(fmt.labelKey), () => fmt.run(view)));
        return { dom };
      },
    };
  }

  const bubbleField = StateField.define<readonly Tooltip[]>({
    create: () => [],
    update(value, tr) {
      if (!tr.docChanged && !tr.selection && !tr.effects.length) return value;
      const sel = tr.state.selection.main;
      // In a KEYBOARD-made vim visual selection the small "\" hint takes the ribbon spot instead of
      // this full bubble — suppress it there. #631: a selection dragged with the mouse puts vim in
      // visual mode too, and someone already holding a mouse is not looking for a keystroke, so the
      // bubble comes back for those. Both this and the hint read the SAME answer (`vimKeyboardVisual`);
      // asking the question twice is how you get both showing, or neither.
      if (sel.empty || vimKeyboardVisual(tr.state)) return [];
      return [bubble(sel.from, sel.to)];
    },
    provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
  });

  return [bubbleField];
}
