import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdownExtension } from "../markdown-config";
import { caretInNestedMacro } from "./decorations";
import "../macros"; // register columns / callouts so directiveChainAt resolves the nesting chain

// #196 / ADR-092 innermost-wins reveal: the decision that drives whether a layout container reveals
// the WHOLE block raw (caret editing its own :::column/:::tab structure) or renders a frame + descends
// so ONLY the innermost nested macro reveals (caret editing a nested callout). caretInNestedMacro is
// that decision — verified on the real directive tree. The container uses MORE colons than the child
// so the parser nests them (outer > inner), same rule as directiveChainAt's own tests.
const at = (doc: string, needle: string, sel: number) =>
  EditorState.create({ doc, selection: EditorSelection.cursor(doc.indexOf(needle) + sel), extensions: [markdownExtension()] });

// a columns container (5 colons) with a nested warning callout (3 colons) inside it
const NESTED = ":::::columns\n:::warning\ndeep body\n:::\n:::::";

describe("caretInNestedMacro (#196 innermost-wins reveal decision)", () => {
  it("is TRUE when the caret is inside a macro nested within the container (→ frame + descend)", () => {
    const s = at(NESTED, "deep body", 2);
    expect(caretInNestedMacro(s, 0, s.doc.length)).toBe(true);
  });

  it("is FALSE when the caret is directly in the container's own structure (→ whole raw)", () => {
    // caret on the `:::::columns` opening line: the innermost registered macro IS the container
    const s = at(NESTED, ":::::columns", 3);
    expect(caretInNestedMacro(s, 0, s.doc.length)).toBe(false);
  });

  it("is FALSE when the caret is entirely outside the container (→ container renders normally)", () => {
    const doc = NESTED + "\n\nafter the block";
    const s = at(doc, "after the block", 3);
    // container range is just the block (lines before the trailing prose)
    const blockTo = doc.indexOf("\n\nafter");
    expect(caretInNestedMacro(s, 0, blockTo)).toBe(false);
  });

  it("is FALSE for a lone callout with no container nesting (the common non-nested case is inert)", () => {
    const doc = ":::warning\njust a note\n:::";
    const s = at(doc, "just a note", 2);
    // the innermost macro at the caret is the callout itself, and it starts AT `from` (not nested
    // deeper) → the decision stays false, so a top-level callout keeps its existing reveal behaviour.
    expect(caretInNestedMacro(s, 0, s.doc.length)).toBe(false);
  });
});
