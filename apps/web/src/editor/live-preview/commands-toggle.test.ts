// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownExtension } from "../markdown-config";
import { toggleBold, toggleItalic, toggleStrikethrough, toggleHighlight, toggleInlineCode } from "./commands";

// #236: inline formats TOGGLE against the syntax tree — already formatted → remove; mixed → unify-apply
// (2nd press removes); sub-range of a formatted span → split. All paths are offset-invariant plain
// changes on the doc (single Y.Text) — these drive a real EditorView over the app's markdown language.

function viewOf(doc: string, from: number, to: number): EditorView {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.range(from, to),
    extensions: [markdownExtension()],
  });
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({ state, parent });
}
const runOn = (doc: string, sel: [number, number], cmd: (v: EditorView) => void): string => {
  const view = viewOf(doc, sel[0], sel[1]);
  cmd(view);
  const out = view.state.doc.toString();
  view.destroy();
  return out;
};

describe("#236 inline-format toggle (body, syntax-tree based)", () => {
  it("unformatted selection → applies (unchanged behaviour)", () => {
    expect(runOn("hello world", [0, 5], toggleBold)).toBe("**hello** world");
  });

  it("fully formatted selection (content) → removes the wrap", () => {
    // "**hello** world": content "hello" = [2,7]
    expect(runOn("**hello** world", [2, 7], toggleBold)).toBe("hello world");
  });

  it("selection INCLUDING the delimiters → removes the wrap", () => {
    expect(runOn("**hello** world", [0, 9], toggleBold)).toBe("hello world");
  });

  it("sub-range inside a span → splits (only the selected part loses the mark)", () => {
    // "**abcdef**": select "cd" = [4,6] → **ab**cd**ef**
    expect(runOn("**abcdef**", [4, 6], toggleBold)).toBe("**ab**cd**ef**");
  });

  it("sub-range at the content START → moves the opening delimiter (no empty pair)", () => {
    // select "ab" = [2,4] → ab**cdef**
    expect(runOn("**abcdef**", [2, 4], toggleBold)).toBe("ab**cdef**");
  });

  it("sub-range at the content END → moves the closing delimiter (no empty pair)", () => {
    // select "ef" = [6,8] → **abcd**ef
    expect(runOn("**abcdef**", [6, 8], toggleBold)).toBe("**abcd**ef");
  });

  it("MIXED selection (formatted + plain) → unify-applies once; second press removes (edge case)", () => {
    // "a **b** c": select all [0,9] → one span, no nested/broken fragments
    const once = runOn("a **b** c", [0, 9], toggleBold);
    expect(once).toBe("**a b c**");
    const twice = runOn(once, [2, 7], toggleBold); // content "a b c" = [2,7]
    expect(twice).toBe("a b c");
  });

  it("selection overlapping a span's edge → absorbs it into one span (no `**ab****cd**`)", () => {
    // "**abcd** ef": select from inside the bold to the end ("cd** ef" content-wise) = [6, 11]
    expect(runOn("**abcd** ef", [6, 11], toggleBold)).toBe("**abcd ef**");
  });

  it("italic toggles independently of bold (nested marks preserved)", () => {
    // bold containing the selection; italic applies INSIDE without touching **
    expect(runOn("**hello**", [2, 7], toggleItalic)).toBe("***hello***");
    // and removing italic from ***hello*** keeps the bold
    expect(runOn("***hello***", [3, 8], toggleItalic)).toBe("**hello**");
  });

  it("strikethrough toggles", () => {
    expect(runOn("~~gone~~", [2, 6], toggleStrikethrough)).toBe("gone");
    expect(runOn("keep", [0, 4], toggleStrikethrough)).toBe("~~keep~~");
  });

  it("highlight toggles (#334 / ADR-129: the selection-popup marker)", () => {
    expect(runOn("==lit==", [2, 5], toggleHighlight)).toBe("lit"); // unwrap
    expect(runOn("mark", [0, 4], toggleHighlight)).toBe("==mark=="); // wrap
  });

  it("inline code toggles", () => {
    expect(runOn("`x`", [1, 2], toggleInlineCode)).toBe("x");
    expect(runOn("x", [0, 1], toggleInlineCode)).toBe("`x`");
  });

  it("empty selection still inserts the pair with the caret between", () => {
    const view = viewOf("ab", 1, 1);
    toggleBold(view);
    expect(view.state.doc.toString()).toBe("a****b");
    expect(view.state.selection.main.head).toBe(3); // between the pair
    view.destroy();
  });
});
