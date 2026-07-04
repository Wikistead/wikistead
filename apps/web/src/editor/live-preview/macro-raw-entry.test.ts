import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { macroEdit, macroRenderActiveField, setMacroRenderActive } from "./macro-edit";

// #174 / ADR-087 addendum: entering a ``` -notation macro carries a `raw` flag — Ctrl+Enter (raw=true)
// reveals the RAW source, the ✎ edit button (raw=false) opens the rich editUI. The flag lives on the
// render-active field and must survive doc edits (offset remap) so the fence renderer keeps routing to
// raw-source vs editUI correctly while the user types inside the block.
const mk = (doc: string) => EditorState.create({ doc, extensions: [macroEdit] });

describe("macroRenderActiveField raw flag (#174 addendum)", () => {
  it("stores raw=true from a Ctrl+Enter entry", () => {
    const s = mk("```mermaid\ngraph TD\n```").update({ effects: setMacroRenderActive.of({ from: 0, to: 22, raw: true }) }).state;
    expect(s.field(macroRenderActiveField)).toEqual({ from: 0, to: 22, raw: true });
  });

  it("stores raw=false (default editUI entry) from an ✎-button entry", () => {
    const s = mk("```mermaid\ngraph TD\n```").update({ effects: setMacroRenderActive.of({ from: 0, to: 22, raw: false }) }).state;
    expect(s.field(macroRenderActiveField)?.raw).toBe(false);
  });

  it("preserves raw across a doc edit inside the block (offset remap keeps the routing)", () => {
    const s0 = mk("```mermaid\ngraph TD\n```").update({ effects: setMacroRenderActive.of({ from: 0, to: 22, raw: true }) }).state;
    // insert a char inside the body (a keystroke while editing the raw source)
    const s1 = s0.update({ changes: { from: 18, insert: "X" }, selection: { anchor: 19 } }).state;
    const v = s1.field(macroRenderActiveField);
    expect(v?.raw).toBe(true); // still raw — the fence renderer must NOT flip to editUI mid-edit
    expect(v?.to).toBe(23); // right edge grew by the inserted char
  });

  it("clears when the caret leaves the block", () => {
    const s0 = mk("```mermaid\ngraph TD\n```\nafter").update({ effects: setMacroRenderActive.of({ from: 0, to: 22, raw: true }) }).state;
    const s1 = s0.update({ selection: { anchor: 27 } }).state; // caret in "after", outside [0,22]
    expect(s1.field(macroRenderActiveField)).toBeNull();
  });
});
