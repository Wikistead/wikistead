import { codeFolding, foldService } from "@codemirror/language";
import { macroFenceAt } from "./fence";

// Fold for macro blocks (ADR-022 Part 5). A large macro fence collapses to a single
// landable summary line ("▶ Mermaid diagram"). Built on CodeMirror's native folding,
// so vim `za`/`zo` and the fold state come for free (the M2 acceptance check confirms
// `za`/`zo` map onto these). Fold is a display-only decoration — offset-invariant, so
// presence/collab are untouched (ADR-008).
//
// A folded macro collapses the WHOLE block (from the opening fence line) to the
// placeholder, not CM's usual "first line + …", so the summary reads as one line.

// foldService: any line inside a macro fence → the whole block range, so `za` (or the
// fold button) collapses the entire macro, not just its tail.
const macroFoldService = foldService.of((state, lineStart) => {
  const fence = macroFenceAt(state, lineStart);
  return fence ? { from: fence.from, to: fence.to } : null;
});

const macroCodeFolding = codeFolding({
  // Derive the per-macro summary label from the folded range.
  preparePlaceholder: (state, range) => {
    const fence = macroFenceAt(state, range.from);
    return fence ? fence.macro.summary(fence.body) : "Folded";
  },
  placeholderDOM: (_view, onclick, prepared: string) => {
    const span = document.createElement("span");
    span.className = "cm-lp-macro-folded";
    span.setAttribute("data-testid", "macro-folded");
    span.textContent = `▶ ${prepared}`;
    span.dataset.tip = "Expand"; // #530
    span.onclick = onclick; // CM's handler unfolds
    return span;
  },
});

export const macroFold = [macroCodeFolding, macroFoldService];

// NOTE: there is deliberately NO auto-fold-on-load. A macro is an atom and always
// renders (ADR-024 / Stage 1b) — a large Excalidraw/mermaid body must show its figure
// on open, never the "▶ summary" placeholder. Fold is COSMETIC and manual only (za /
// the fold button via `macroFold`). An earlier `autoFoldLargeFenceMacros` (ADR-022
// Part 5, "default-folded by size") was removed when macros became atoms.
