// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownExtension } from "../markdown-config";
import { moveBlockUp, moveBlockDown } from "./block-move";

// #84 / #174 (ADR-087): the keyboard alternative to the drag grip. moveBlockUp/Down reorder the block
// at the caret via the shared computeBlockMove math (one Y.Text edit). Verified on the real doc: the
// block moves, single blank separators are preserved, and edges no-op.
const view = (doc: string, caret: number): EditorView => {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(caret), extensions: [markdownExtension()] });
  return new EditorView({ state });
};

describe("keyboard block move (#84 / #174)", () => {
  it("moveBlockDown swaps the caret's block with the next (single blanks preserved)", () => {
    const v = view("A\n\nB\n\nC", 0); // caret in block A
    expect(moveBlockDown(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("B\n\nA\n\nC");
  });

  it("moveBlockUp swaps the caret's block with the previous", () => {
    const doc = "A\n\nB\n\nC";
    const v = view(doc, doc.indexOf("C")); // caret in block C
    expect(moveBlockUp(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("A\n\nC\n\nB");
  });

  it("moveBlockUp on the FIRST block is a no-op (returns false)", () => {
    const v = view("A\n\nB", 0);
    expect(moveBlockUp(v)).toBe(false);
    expect(v.state.doc.toString()).toBe("A\n\nB");
  });

  it("moveBlockDown on the LAST block is a no-op (returns false)", () => {
    const doc = "A\n\nB";
    const v = view(doc, doc.indexOf("B"));
    expect(moveBlockDown(v)).toBe(false);
    expect(v.state.doc.toString()).toBe("A\n\nB");
  });

  it("moves a whole atom (fenced macro) as one unit, never splitting it", () => {
    const doc = "intro\n\n```mermaid\ngraph TD; A-->B\n```\n\nafter";
    const v = view(doc, 0); // caret in "intro"
    expect(moveBlockDown(v)).toBe(true);
    // intro moves below the whole code fence (the fence stays intact)
    expect(v.state.doc.toString()).toBe("```mermaid\ngraph TD; A-->B\n```\n\nintro\n\nafter");
  });

  it("a blank-line caret is a no-op (nothing to move)", () => {
    const v = view("A\n\nB", 1); // the blank line between A and B (offset 1 = the first \n... use the blank line)
    // caret on the truly-blank line
    const blankV = view("A\n\n\nB", 2);
    expect(moveBlockDown(blankV)).toBe(false);
    void v;
  });
});
