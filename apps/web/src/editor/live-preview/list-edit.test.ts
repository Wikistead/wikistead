// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { indentList, outdentList, continueMarker } from "./list-edit";

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

  it("Tab indents an ORDERED list item too", () => {
    const v = view("1. item", 4);
    expect(indentList(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("  1. item");
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

  // #202 vim o/O: the marker that continues a list line (same indent; bullet repeats, ordered
  // increments). This is the core of making o/O consistent with Enter — verified per marker kind.
  it("continueMarker repeats a bullet and increments an ordered marker (indent preserved)", () => {
    expect(continueMarker("- item")).toBe("- ");
    expect(continueMarker("* item")).toBe("* ");
    expect(continueMarker("  - nested")).toBe("  - "); // indent kept
    expect(continueMarker("1. item")).toBe("2. "); // ordered → next number
    expect(continueMarker("  3) item")).toBe("  4) "); // indent + paren style + increment
    expect(continueMarker("plain text")).toBeNull(); // not a list
    expect(continueMarker("")).toBeNull();
  });

  it("indents EVERY list line in a multi-line selection", () => {
    const v = view("- a\n- b\n- c", 0);
    v.dispatch({ selection: EditorSelection.range(0, 11) }); // whole doc
    expect(indentList(v)).toBe(true);
    expect(v.state.doc.toString()).toBe("  - a\n  - b\n  - c");
  });
});
