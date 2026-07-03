import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdownExtension } from "../markdown-config";
import { embedRetargetChange } from "./decorations";
import "../macros"; // side-effect: register embed-page / embed-external so directiveMacroAt resolves them

// #210: an already-inserted embed block must be re-targetable from the ADR-087 block menu — the write
// goes through a single canonical Y.Text edit whose offset comes from the atom's directive range (NOT
// a display-only mutation). embedRetargetChange is that DOM-free core (state → change); these verify
// it on the real render path (directiveMacroAt over the markdown tree).
const mk = (doc: string) => EditorState.create({ doc, extensions: [markdownExtension()] });
const apply = (doc: string, ch: { from: number; to: number; insert: string }) =>
  mk(doc).update({ changes: ch }).state.doc.toString();

describe("embedRetargetChange (#210)", () => {
  it("rewrites an :::embed-page target id in place (single canonical change)", () => {
    const doc = "before\n\n:::embed-page\nold-id\n:::\n\nafter";
    const state = mk(doc);
    const pos = doc.indexOf(":::embed-page");
    const ch = embedRetargetChange(state, pos, "embed-page", "new-id")!;
    expect(ch).not.toBeNull();
    // the change spans exactly the directive block (offset from the atom range), and the applied doc
    // carries the new id with the surrounding prose untouched.
    expect(apply(doc, ch)).toBe("before\n\n:::embed-page\nnew-id\n:::\n\nafter");
    // it is ONE change over the block range, not a per-line patch
    expect(ch.insert).toBe(":::embed-page\nnew-id\n:::");
  });

  it("resolves the block from a caret anywhere inside it (atom range, not a single line)", () => {
    const doc = ":::embed-page\nold-id\n:::";
    const state = mk(doc);
    const inside = doc.indexOf("old-id") + 2; // caret on the body line
    const ch = embedRetargetChange(state, inside, "embed-page", "fresh")!;
    expect(apply(doc, ch)).toBe(":::embed-page\nfresh\n:::");
  });

  it("re-targets an :::embed-external URL the same way", () => {
    const doc = ":::embed-external\nhttps://old.example/v\n:::";
    const ch = embedRetargetChange(mk(doc), 0, "embed-external", "https://new.example/w")!;
    expect(apply(doc, ch)).toBe(":::embed-external\nhttps://new.example/w\n:::");
  });

  it("returns null when the position is NOT the named directive (cross-macro / stale-offset guard)", () => {
    const doc = ":::embed-external\nhttps://x.example\n:::";
    // asking to retarget as embed-PAGE over an embed-EXTERNAL block must refuse (no wrong-block write)
    expect(embedRetargetChange(mk(doc), 0, "embed-page", "id")).toBeNull();
  });

  it("returns null on a plain-prose position (no directive to retarget)", () => {
    const doc = "just a paragraph, no embed here";
    expect(embedRetargetChange(mk(doc), 5, "embed-page", "id")).toBeNull();
  });

  it("preserves the block's leading/trailing blank-line context (no separator churn)", () => {
    const doc = "# Title\n\n:::embed-page\na\n:::\n\n- list\n- items";
    const ch = embedRetargetChange(mk(doc), doc.indexOf(":::embed-page"), "embed-page", "b")!;
    expect(apply(doc, ch)).toBe("# Title\n\n:::embed-page\nb\n:::\n\n- list\n- items");
  });
});
