import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

// #325 / ADR-137 slice 2: an explicit block-reference anchor is a trailing ` ^<id>` marker on a block's last
// line (id: [a-z0-9-]{3,24}) — ordinary text in the single Y.Text (Open formats; it round-trips and other tools
// keep it). The live preview HIDES the trailing marker with a display-only, offset-invariant `Decoration.replace`
// so a `^id` doesn't clutter the rendered text — but REVEALS it raw when the caret is on that line (so the author
// can see/edit it), the same reveal-on-cursor discipline the `:::` / heading markers use. On a read-only surface
// (Reading / public / template preview) it is ALWAYS hidden (nothing is edited there). The marker is never
// rewritten — the decoration is display-only, so remote carets / offsets are unaffected.

const BLOCK_ANCHOR_RE = /[ \t]\^[a-z0-9-]{3,24}$/; // ` ^<id>` at the very end of a line

class BlockAnchorPlugin {
  decorations: DecorationSet;
  constructor(readonly view: EditorView) { this.decorations = this.build(); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build();
  }
  build(): DecorationSet {
    const b = new RangeSetBuilder<Decoration>();
    const readOnly = this.view.state.readOnly;
    const sel = this.view.state.selection.main;
    for (const { from, to } of this.view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = this.view.state.doc.lineAt(pos);
        const m = BLOCK_ANCHOR_RE.exec(line.text);
        if (m) {
          const markFrom = line.from + m.index; // the whitespace before `^`
          const caretOnLine = !readOnly && sel.from <= line.to && sel.to >= line.from;
          if (!caretOnLine) b.add(markFrom, line.to, Decoration.replace({})); // hide the ` ^id` (0-width, atomic)
        }
        pos = line.to + 1;
      }
    }
    return b.finish();
  }
}

// One plugin for BOTH the Live edit surface (reveal on the caret line) and the read-only Reading/published view
// (always hidden). Display-only (Decoration.replace never touches the doc → single Y.Text unaffected).
export const blockAnchors = ViewPlugin.fromClass(BlockAnchorPlugin, { decorations: (v) => v.decorations });
