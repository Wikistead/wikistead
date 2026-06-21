// Unit tests for inline-comment anchoring — the hardest part of P4. Pure Yjs (no
// DOM/CodeMirror), so we drive real Y.Doc edits and assert the anchor follows them
// and orphans gracefully. This is the load-bearing proof that anchors track the
// canonical Y.Text rather than a brittle char offset.
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { createAnchor, resolveAnchor } from "./comment-anchors";

function docWith(text: string): { doc: Y.Doc; ytext: Y.Text } {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  ytext.insert(0, text);
  return { doc, ytext };
}

describe("comment anchors", () => {
  it("resolves to the originally anchored range", () => {
    const { doc, ytext } = docWith("the quick brown fox");
    const anchor = createAnchor(ytext, 4, 9); // "quick"
    expect(resolveAnchor(doc, anchor)).toEqual({ from: 4, to: 9 });
  });

  it("FOLLOWS an insertion before the range (the offset would have drifted)", () => {
    const { doc, ytext } = docWith("the quick brown fox");
    const anchor = createAnchor(ytext, 4, 9); // "quick"
    ytext.insert(0, "well, "); // 6 chars before the range
    // a stored offset of 4..9 would now point at the wrong text; the anchor shifts.
    const r = resolveAnchor(doc, anchor)!;
    expect(r).toEqual({ from: 10, to: 15 });
    expect(ytext.toString().slice(r.from, r.to)).toBe("quick");
  });

  it("is unaffected by an insertion AFTER the range", () => {
    const { doc, ytext } = docWith("the quick brown fox");
    const anchor = createAnchor(ytext, 4, 9);
    ytext.insert(ytext.length, " jumps");
    expect(resolveAnchor(doc, anchor)).toEqual({ from: 4, to: 9 });
  });

  it("ORPHANS gracefully when the anchored text is deleted (resolves to null, not a wrong range)", () => {
    const { doc, ytext } = docWith("the quick brown fox");
    const anchor = createAnchor(ytext, 4, 9); // "quick"
    ytext.delete(4, 5); // remove "quick" (+ keep it simple)
    expect(resolveAnchor(doc, anchor)).toBeNull();
  });

  it("survives an edit INSIDE the range, keeping it non-empty", () => {
    const { doc, ytext } = docWith("the quick brown fox");
    const anchor = createAnchor(ytext, 4, 9); // "quick"
    ytext.insert(6, "XX"); // inside "quick" → "quXXick"
    const r = resolveAnchor(doc, anchor)!;
    expect(r.from).toBe(4);
    expect(r.to).toBe(11); // range grew to include the insertion
  });

  it("round-trips encode/decode across a fresh Y.Doc that merged the same updates", () => {
    const a = new Y.Doc();
    const at = a.getText("content");
    at.insert(0, "shared document text");
    const anchor = createAnchor(at, 7, 15); // "document"
    // Simulate another client: a separate doc synced via the update protocol.
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(resolveAnchor(b, anchor)).toEqual({ from: 7, to: 15 });
  });
});
