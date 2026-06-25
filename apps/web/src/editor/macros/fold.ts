import { codeFolding, foldService, foldEffect, ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { macroFenceAt, fenceLang } from "./fence";
import { findFenceMacro } from "./registry";

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
    span.title = "Expand";
    span.onclick = onclick; // CM's handler unfolds
    return span;
  },
});

export const macroFold = [macroCodeFolding, macroFoldService];

// Default a LARGE fence-macro block (e.g. a big Excalidraw JSON) to folded so a long
// document stays skimmable (ADR-022 Part 5, "default-folded by size"). Run ONCE at
// mount: a block the user then unfolds stays unfolded, and a block typed during the
// session isn't folded out from under the editing cursor. Fence macros only (the
// motivating case is large data bodies; directives stay open).
const DEFAULT_FOLD_LINES = 10;
export function autoFoldLargeFenceMacros(view: EditorView, threshold = DEFAULT_FOLD_LINES): void {
  const state = view.state;
  const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
  const effects: ReturnType<typeof foldEffect.of>[] = [];
  tree.iterate({
    enter: (n) => {
      if (n.name !== "FencedCode") return;
      const doc = state.doc;
      const firstLine = doc.lineAt(n.from);
      const lang = fenceLang(firstLine.text);
      if (!lang || !findFenceMacro(lang)) return;
      const lastLine = doc.lineAt(Math.max(n.from, Math.min(n.to, doc.length) - 1));
      if (lastLine.number - firstLine.number + 1 > threshold) {
        effects.push(foldEffect.of({ from: firstLine.from, to: lastLine.to }));
      }
    },
  });
  if (effects.length) view.dispatch({ effects });
}
