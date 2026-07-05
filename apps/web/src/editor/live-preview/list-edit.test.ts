// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { indentList, outdentList } from "./list-edit";

// #202: Tab/Shift-Tab indent/outdent a list ITEM (nesting) but no-op outside a list. Verified on the
// real doc text (indentation = markdown nesting), with distinct list vs non-list inputs.
function view(doc: string, caret: number): EditorView {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(caret) });
  return new EditorView({ state });
}

describe("list indent/outdent (#202)", () => {
  it("Tab indents a bullet list item by one level (2 spaces)", () => {
    const v = view("- item", 3); // caret inside the item
    expect(indentList(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("  - item");
  });

  it("Tab indents an ORDERED list item by its marker width (3) so it parses as a nested list (#202)", () => {
    const v = view("1. item", 4);
    expect(indentList(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("   1. item"); // 3 spaces (marker `1. ` width) — clears the parent's content column
  });

  it("Tab does NOTHING (returns false) outside a list — default behaviour preserved", () => {
    const v = view("just a paragraph", 5);
    expect(indentList(v)).toBe(false);
    expect(v.state.doc.toString()).toBe("just a paragraph"); // unchanged
  });

  it("Shift-Tab outdents an indented list item by one level", () => {
    const v = view("  - nested", 5);
    expect(outdentList(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("- nested");
  });

  it("Shift-Tab on a TOP-LEVEL list item consumes the key but leaves the text unchanged", () => {
    const v = view("- top", 3);
    expect(outdentList(v)).toBe(true); // handled (no focus move) …
    expect(v.state.doc.toString()).toBe("- top"); // … but nothing to outdent
  });

  it("Shift-Tab returns false outside a list (default Shift-Tab runs)", () => {
    const v = view("paragraph", 3);
    expect(outdentList(v)).toBe(false);
  });

  // #202 vim `o` list continuation is delivered by a vim REMAP (`o` → `A<CR>`) that reuses the
  // insert-mode marker continuation (markdownKeymap), NOT by a pure function here — a CM keymap cannot
  // intercept vim normal-mode keys (vim's own keydown handler owns them). That path needs the vim
  // runtime + real keystrokes, so it is covered by review rather than a unit test (the earlier
  // pure `continueMarker` helper was removed as it was off the real path — dead confidence).

  it("indents EVERY list line in a multi-line selection", () => {
    const v = view("- a\n- b\n- c", 0);
    v.dispatch({ selection: EditorSelection.range(0, 11) }); // whole doc
    expect(indentList(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("  - a\n  - b\n  - c");
  });
});
