// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { taskStatePosAt } from "./decorations";

// #303: taskStatePosAt re-resolves a task ORDINAL to the state char (` `/`x` inside `[ ]`) in a GIVEN text.
// The view-surface checkbox reports an ordinal computed on the PUBLISHED snapshot; the host must re-resolve
// it against the LIVE DRAFT (which may have diverged by unrelated prose edits) before flipping — applying the
// published byte offset to a dirty draft was the #303 prose-corruption bug.
describe("#303: taskStatePosAt re-resolves a task ordinal in the target text", () => {
  it("returns the state-char offset for each ordinal (the char inside the brackets)", () => {
    const doc = "- [ ] a\n- [x] b";
    // "- [ ] a": '-'=0 ' '=1 '['=2 ' '=3 ']'=4 → state char at 3
    expect(taskStatePosAt(doc, 0)).toBe(3);
    expect(doc[taskStatePosAt(doc, 0)]).toBe(" ");
    // "- [x] b" starts at 8: '['=10, state at 11
    expect(taskStatePosAt(doc, 1)).toBe(11);
    expect(doc[taskStatePosAt(doc, 1)]).toBe("x");
  });

  it("returns -1 for an out-of-range ordinal (no index-th task)", () => {
    expect(taskStatePosAt("- [ ] a\n- [x] b", 2)).toBe(-1);
    expect(taskStatePosAt("no tasks here", 0)).toBe(-1);
  });

  it("ORDINAL is stable when prose (not a task) is inserted ahead — the core #303 invariant", () => {
    // A draft with 7 prose chars prepended: the byte offsets all shift by 7, but the task ORDINALS are
    // unchanged, so re-resolving by ordinal lands on the SAME task's state char (never on shifted prose).
    const published = "done\n- [ ] a\n- [ ] b";
    const draftDirty = "PREPEND" + published; // +7 chars of prose ahead of everything
    for (const index of [0, 1]) {
      const pubPos = taskStatePosAt(published, index);
      const draftPos = taskStatePosAt(draftDirty, index);
      expect(draftPos).toBe(pubPos + 7); // shifted by exactly the prepended prose length
      expect(draftDirty[draftPos]).toBe(" "); // still the task's bracket, NOT corrupted prose
    }
  });

  it("skips non-task '[ ]' that is not a list marker (matches the server TASK_MARKER)", () => {
    // A bracketed pair mid-prose is NOT a task marker (no list bullet), so it is not counted.
    const doc = "text [ ] not a task\n- [ ] real";
    expect(taskStatePosAt(doc, 0)).toBe(doc.indexOf("- [ ] real") + 3); // the first REAL task
    expect(doc[taskStatePosAt(doc, 0)]).toBe(" ");
    expect(taskStatePosAt(doc, 1)).toBe(-1);
  });
});
