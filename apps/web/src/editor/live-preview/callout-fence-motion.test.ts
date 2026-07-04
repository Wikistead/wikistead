// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdownExtension } from "../markdown-config";
import { livePreview } from "./decorations";
import "../macros"; // register the callout (info/note/…) directive macros so :::info resolves

// #141 bounce: on device, j/k warped over a revealed :::info callout because its `:::` fence lines were
// ATOMIC (via hideMarker → livePreview.atomic → EditorView.atomicRanges), an un-landable whole-line
// range — a path motionAtomsForCaret (which filters livePreview.blocks) never touched. The fix makes a
// whole-line DirectiveMark fence hidden-but-NOT-atomic, so the caret can step onto the fence line. These
// verify on the REAL :::info range (not a synthetic block) that the fence lines are not atomic when the
// callout is revealed.
const atomicCoversOffset = (doc: string, caret: number, offset: number): boolean => {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(caret), extensions: [markdownExtension(), livePreview] });
  const atomic = state.field(livePreview).atomic;
  let covered = false;
  atomic.between(0, doc.length, (from, to) => { if (from <= offset && to > offset) covered = true; });
  return covered;
};

describe("revealed callout fence lines are not atomic (#141)", () => {
  const DOC = ":::info\nx\n:::"; // line1 open fence, line2 body, line3 close fence

  it("the closing ::: fence line is not atomic when the caret is in the body (landable → j/k steps onto it)", () => {
    const bodyCaret = DOC.indexOf("x");
    const closeFence = DOC.lastIndexOf(":::");
    expect(atomicCoversOffset(DOC, bodyCaret, closeFence)).toBe(false);
  });

  it("the opening :::info fence line is not atomic when the caret is in the body", () => {
    const bodyCaret = DOC.indexOf("x");
    const openFence = DOC.indexOf(":::info") + 1; // inside the open fence marker
    expect(atomicCoversOffset(DOC, bodyCaret, openFence)).toBe(false);
  });

  it("an inline marker (bold **) STAYS atomic — the fix is scoped to whole-line directive fences", () => {
    // the bold is on line 2; the caret is on line 1, so line 2's ** markers are hidden (not revealed)
    // and must stay ATOMIC (horizontal-skip behaviour preserved — the fix only affects whole-line fences).
    const doc = "top line\n**b** here";
    const boldMark = doc.indexOf("**") + 1; // inside the opening ** on line 2
    expect(atomicCoversOffset(doc, 0, boldMark)).toBe(true);
  });
});
