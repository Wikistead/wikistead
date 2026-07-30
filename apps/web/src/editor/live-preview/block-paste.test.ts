import { describe, it, expect } from "vitest";
import { completeBlockChunk, blockPasteInsert } from "./block-paste";

// #558: the pure halves of the block-paste normalization. The gesture (atom select → Ctrl+C → arrow →
// Ctrl+V) is pinned in the real browser (block-paste-boundary-558.spec.ts); these pin the decision
// table — what COUNTS as a block chunk (nothing else may trigger, the over-application guard) and
// where the chunk lands for each caret situation.

const MERMAID = "```mermaid\ngraph TD; A-->B;\n```";
const NOTE = ":::note[Label]\ncallout body\n:::";
const TABS = "::::tabs\n:::tab[One]\none\n:::\n::::";

describe("#558 completeBlockChunk — only a complete fence/directive block triggers", () => {
  it("accepts a complete fence, directive, and container chunk (trailing newline stripped)", () => {
    expect(completeBlockChunk(MERMAID + "\n")).toBe(MERMAID);
    expect(completeBlockChunk(NOTE)).toBe(NOTE);
    expect(completeBlockChunk(TABS)).toBe(TABS);
    expect(completeBlockChunk("~~~js\nx\n~~~")).toBe("~~~js\nx\n~~~");
  });
  it("rejects everything else — prose, fragments, single lines (the default paste keeps those)", () => {
    expect(completeBlockChunk("plain text")).toBeNull();
    expect(completeBlockChunk("two\nlines of prose")).toBeNull();
    expect(completeBlockChunk("```mermaid\ngraph TD;")).toBeNull(); // open, no close
    expect(completeBlockChunk(":::note\nbody")).toBeNull();
    expect(completeBlockChunk("````x\ny\n```")).toBeNull(); // close shorter than the opener
    expect(completeBlockChunk("text before\n```js\nx\n```")).toBeNull(); // not the whole chunk
    expect(completeBlockChunk("")).toBeNull();
  });
});

describe("#558 blockPasteInsert — the chunk lands on a line boundary, never inside a block", () => {
  const line = { from: 20, to: 30 };
  it("caret riding a block: after it (the ArrowRight meaning), whole; the caret steps past the paste", () => {
    // the measured defect: caret at 18, inside the "```mermaid" marker line [17,27] of a block [17,45]
    const r = blockPasteInsert(MERMAID, 18, { from: 17, to: 27 }, { fromLineFrom: 17, toLineTo: 45 });
    expect(r).toEqual({ at: 45, insert: "\n" + MERMAID, cursor: 45 + MERMAID.length + 2 });
  });
  it("caret at the block's very start: before it, whole; the caret retreats off both blocks", () => {
    const r = blockPasteInsert(MERMAID, 17, { from: 17, to: 27 }, { fromLineFrom: 17, toLineTo: 45 });
    expect(r).toEqual({ at: 17, insert: MERMAID + "\n", cursor: 16 });
  });
  it("empty line: in place (an empty line IS a boundary)", () => {
    expect(blockPasteInsert(NOTE, 16, { from: 16, to: 16 }, null)).toEqual({ at: 16, insert: NOTE, cursor: 16 + NOTE.length + 1 });
  });
  it("start of a text line: block above, the line moves down whole", () => {
    expect(blockPasteInsert(NOTE, 20, line, null)).toEqual({ at: 20, insert: NOTE + "\n", cursor: 20 + NOTE.length + 1 });
  });
  it("middle/end of a text line: block below, the line stays whole", () => {
    expect(blockPasteInsert(NOTE, 25, line, null)).toEqual({ at: 30, insert: "\n" + NOTE, cursor: 30 + NOTE.length + 2 });
    expect(blockPasteInsert(NOTE, 30, line, null)).toEqual({ at: 30, insert: "\n" + NOTE, cursor: 30 + NOTE.length + 2 });
  });
});
