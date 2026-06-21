// Unit tests for the comment-highlight state field — headless CodeMirror state, no
// browser. Proves it renders one mark per non-empty range and keeps marks aligned
// through document edits (offset-invariant, like the live-preview decorations).
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { commentHighlights, setCommentRanges } from "./comment-highlights";

const create = (doc: string) => EditorState.create({ doc, extensions: [commentHighlights] });
function ranges(state: EditorState) {
  const out: { from: number; to: number }[] = [];
  const cur = state.field(commentHighlights).iter();
  while (cur.value) { out.push({ from: cur.from, to: cur.to }); cur.next(); }
  return out;
}

describe("comment highlights", () => {
  it("renders a mark per non-empty range and drops collapsed (orphaned) ones", () => {
    let s = create("the quick brown fox");
    s = s.update({ effects: setCommentRanges.of([{ from: 4, to: 9, resolved: false }, { from: 2, to: 2, resolved: false }]) }).state;
    expect(ranges(s)).toEqual([{ from: 4, to: 9 }]);
  });

  it("maps highlights through edits (insert before shifts the mark)", () => {
    let s = create("the quick brown fox");
    s = s.update({ effects: setCommentRanges.of([{ from: 4, to: 9, resolved: false }]) }).state;
    s = s.update({ changes: { from: 0, insert: "well, " } }).state;
    expect(ranges(s)).toEqual([{ from: 10, to: 15 }]);
  });

  it("replaces the whole set on a fresh push", () => {
    let s = create("the quick brown fox");
    s = s.update({ effects: setCommentRanges.of([{ from: 4, to: 9, resolved: false }]) }).state;
    s = s.update({ effects: setCommentRanges.of([{ from: 10, to: 15, resolved: true }]) }).state;
    expect(ranges(s)).toEqual([{ from: 10, to: 15 }]);
  });
});
