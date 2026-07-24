// @vitest-environment happy-dom
// #502 Option B (ADR-184 addendum 2): a RichUI (the table grid) commits via InnerEditHost.replaceSource.
// It must write the MINIMAL offset-invariant diff to the canonical Y.Text, not a whole-block replace — a
// whole-block replace clobbers a peer editing another cell of the same table (LWW). These pins fail on the
// old whole-block dispatch and pass on the minimal-diff one.
import { describe, it, expect } from "vitest";
import type { EditorView } from "@codemirror/view";
import { minimalChange, makeInnerEditHost } from "./macro-edit";
import { asMacroSource } from "../macros/registry";

describe("#502 minimalChange (pure prefix/suffix trim)", () => {
  it("touches only the changed middle", () => {
    expect(minimalChange("| a | b |", "| a | X |", 0)).toEqual({ from: 6, to: 7, insert: "X" });
  });
  it("a pure append is a zero-width insert at the end", () => {
    expect(minimalChange("ab", "abc", 0)).toEqual({ from: 2, to: 2, insert: "c" });
  });
  it("a pure prepend is a zero-width insert at the start", () => {
    expect(minimalChange("bc", "abc", 0)).toEqual({ from: 0, to: 0, insert: "a" });
  });
  it("a full rewrite (no common affix) replaces the whole range", () => {
    expect(minimalChange("abc", "xyz", 0)).toEqual({ from: 0, to: 3, insert: "xyz" });
  });
  it("a no-op (old === next) is an empty change at the end", () => {
    expect(minimalChange("abc", "abc", 0)).toEqual({ from: 3, to: 3, insert: "" });
  });
  it("offsets are relative to base", () => {
    expect(minimalChange("aXc", "aYc", 5)).toEqual({ from: 6, to: 7, insert: "Y" });
  });
  it("prefix and suffix never overlap (deletion shrinking a repeat)", () => {
    // "aaa" → "aa": common prefix "aa" (2), the suffix match must not double-count → delete one 'a'.
    expect(minimalChange("aaa", "aa", 0)).toEqual({ from: 2, to: 3, insert: "" });
  });
});

// A minimal fake EditorView: replaceSource only reads doc.sliceString / doc.length and calls dispatch/focus.
function fakeView(doc: string) {
  const box: { changes?: { from: number; to: number; insert: string } } = {};
  const view = {
    state: { doc: { sliceString: (a: number, b: number) => doc.slice(a, b), length: doc.length } },
    dispatch: (spec: { changes?: { from: number; to: number; insert: string } }) => { box.changes = spec.changes; },
    focus: () => {},
  } as unknown as EditorView;
  return { view, box };
}

describe("#502 replaceSource writes a minimal range, not the whole block", () => {
  const block = "| a | b |\n| - | - |\n| 1 | 2 |";
  const doc = "hello\n" + block; // block starts at offset 6
  const from = 6, to = 6 + block.length;

  it("a single-cell edit dispatches only that cell's range (clobber-free)", () => {
    const { view, box } = fakeView(doc);
    const host = makeInnerEditHost(view, from, to);
    host.replaceSource(asMacroSource(block.replace("| 1 | 2 |", "| 1 | 9 |")));
    const ch = box.changes!;
    // the changed span is ONE character (the '2'→'9'), NOT the whole block (the old whole-block bug)
    expect(ch.insert).toBe("9");
    expect(ch.to - ch.from).toBe(1);
    expect(ch.to - ch.from).toBeLessThan(block.length);
    // and it targets the '2' inside the block, offset-correct
    expect(doc.slice(ch.from, ch.to)).toBe("2");
  });

  it("an unchanged commit is a no-op empty change (no churn)", () => {
    const { view, box } = fakeView(doc);
    const host = makeInnerEditHost(view, from, to);
    host.replaceSource(asMacroSource(block));
    const ch = box.changes!;
    expect(ch.insert).toBe("");
    expect(ch.from).toBe(ch.to);
  });
});
