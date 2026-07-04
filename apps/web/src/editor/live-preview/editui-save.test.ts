import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdownExtension } from "../markdown-config";
import { editUISaveChange } from "./decorations";
import type { MacroTier } from "../macros/registry";
import "../macros"; // register first-party macros (for the table tier used below)

// #174 / ADR-087: an editUI macro's `save(newBody)` becomes a single offset-invariant Y.Text change —
// the new body wrapped back into the block's fence, tier-demoted to the lowest representable level
// (Open formats), replacing the block range. editUISaveChange is that DOM-free core (immediate apply).
const apply = (doc: string, ch: { from: number; to: number; insert: string }) =>
  EditorState.create({ doc, extensions: [markdownExtension()] }).update({ changes: ch }).state.doc.toString();

describe("editUISaveChange (#174 inline editUI save)", () => {
  it("wraps the new body into the block fence and replaces the range (no tier)", () => {
    const doc = "before\n\n:::note\nold body\n:::\n\nafter";
    const from = doc.indexOf(":::note");
    const to = doc.indexOf(":::\n\nafter") + 3;
    const ch = editUISaveChange(from, to, (b) => `:::note\n${b}\n:::`, undefined, "new body");
    expect(ch.insert).toBe(":::note\nnew body\n:::");
    expect(apply(doc, ch)).toBe("before\n\n:::note\nnew body\n:::\n\nafter"); // surrounding prose untouched
  });

  it("is a SINGLE change over the block range (offset-invariant), not a per-line patch", () => {
    const doc = ":::note\na\n:::";
    const ch = editUISaveChange(0, doc.length, (b) => `:::note\n${b}\n:::`, undefined, "x\ny");
    expect(ch.from).toBe(0);
    expect(ch.to).toBe(doc.length);
    expect(apply(doc, ch)).toBe(":::note\nx\ny\n:::");
  });

  it("auto-demotes through a tier to the lowest representable level (Open formats)", () => {
    // a stub tier whose lowest level flattens to a marker — proves editUISaveChange runs autoDemote
    const tier: MacroTier = {
      levels: [{ id: "low", layer: "gfm" }, { id: "high", layer: "directive" }],
      canRepresentAt: () => true, // everything representable at the lowest level → demote to it
      toLevel: (src) => (`DEMOTED:${src}` as unknown as ReturnType<MacroTier["toLevel"]>),
    };
    const ch = editUISaveChange(0, 3, (b) => `body(${b})`, tier, "z");
    expect(ch.insert.startsWith("DEMOTED:")).toBe(true); // the tier's toLevel ran on the wrapped source
    expect(ch.insert).toContain("body(z)");
  });
});
