// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { selectionTouched, selectionEverTouched } from "./decorations";

// #543: the mount-default selection (an empty caret at 0 nobody chose) must not count as the writer's
// caret — a slot island mounts exactly like that and used to open with its leading macro's raw markers
// revealed. Anything that actually SETS a selection (create-time placement, a dispatched selection, any
// doc change) counts.
describe("#543 selectionTouched: the mount default is nobody's caret", () => {
  it("a fresh state with the default selection is untouched", () => {
    const s = EditorState.create({ doc: "```mermaid\nx\n```", extensions: [selectionTouched] });
    expect(selectionEverTouched(s)).toBe(false);
  });

  it("a CREATE-time explicit caret counts as chosen", () => {
    const s = EditorState.create({ doc: "hello world", selection: { anchor: 3 }, extensions: [selectionTouched] });
    expect(selectionEverTouched(s)).toBe(true);
  });

  it("a dispatched selection touches it — and it stays touched", () => {
    const s0 = EditorState.create({ doc: "hello", extensions: [selectionTouched] });
    const s1 = s0.update({ selection: { anchor: 2 } }).state;
    expect(selectionEverTouched(s1)).toBe(true);
    const s2 = s1.update({}).state; // an empty transaction does not reset it
    expect(selectionEverTouched(s2)).toBe(true);
  });

  it("a doc change touches it (content arriving by dispatch = the top-level editor's life)", () => {
    const s0 = EditorState.create({ doc: "", extensions: [selectionTouched] });
    const s1 = s0.update({ changes: { from: 0, insert: "```mermaid\nx\n```" } }).state;
    expect(selectionEverTouched(s1)).toBe(true);
  });

  it("a state WITHOUT the field fails open (treated as touched = pre-#543 behaviour)", () => {
    const s = EditorState.create({ doc: "x" });
    expect(selectionEverTouched(s)).toBe(true);
  });
});
