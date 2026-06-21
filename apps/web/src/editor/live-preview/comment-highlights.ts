import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

// Display-only highlights for inline comment anchors. A SEPARATE state field (not
// the syntax-renderer registry): the ranges come from the comments data +
// RelativePosition resolution, NOT the markdown tree. Offset-invariant — these
// marks never change the document; they map through edits so a highlight tracks
// its text between refreshes, and a fresh resolve replaces the whole set.
export interface CommentRange {
  from: number;
  to: number;
  resolved: boolean;
}

// Host pushes the current resolved ranges (recomputed from RelativePosition when
// the comment set changes); the field maps them through subsequent local edits.
export const setCommentRanges = StateEffect.define<CommentRange[]>();

const openMark = Decoration.mark({ class: "cm-comment-anchor" });
const resolvedMark = Decoration.mark({ class: "cm-comment-anchor-resolved" });

export const commentHighlights = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes); // keep marks aligned through edits between refreshes
    for (const e of tr.effects) {
      if (e.is(setCommentRanges)) {
        deco = Decoration.set(
          e.value
            .filter((r) => r.to > r.from) // skip orphaned/collapsed anchors
            .sort((a, b) => a.from - b.from || a.to - b.to)
            .map((r) => (r.resolved ? resolvedMark : openMark).range(r.from, r.to)),
          true,
        );
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const commentHighlightTheme = EditorView.baseTheme({
  ".cm-comment-anchor": { borderBottom: "2px solid #4ea1ff", backgroundColor: "rgba(78,161,255,0.10)" },
  ".cm-comment-anchor-resolved": { borderBottom: "2px solid rgba(127,127,127,0.45)" },
});
