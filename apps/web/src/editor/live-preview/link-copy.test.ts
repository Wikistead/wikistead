// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdownExtension } from "../markdown-config";
import { linkCopyRange } from "./paste-linkify";

// #223 comment 895 (root cause A): CM's copy is a raw doc-slice, so copying a rendered `[hoge](url)` over a
// selection that maps through the hidden markers yields a fragment (`hoge](`). linkCopyRange expands the
// copied range to whole Link nodes so text/plain is the COMPLETE source. Pure — driven by a real state.
const stateOf = (doc: string) => EditorState.create({ doc, extensions: [markdownExtension()] });

describe("#223 linkCopyRange (copy-side fix)", () => {
  it("expands a selection that cuts through a link to the FULL link source (no fragment)", () => {
    const s = stateOf("x [hoge](https://ex.test/pq) y");
    // select "hoge" (offsets 3..7) — inside the link text, cutting through the hidden markers
    const r = linkCopyRange(s, 3, 7);
    expect(r).not.toBeNull();
    expect(r!.plain).toBe("[hoge](https://ex.test/pq)"); // whole link, not `hoge](`
  });

  it("selecting the whole line keeps the complete link", () => {
    const s = stateOf("x [hoge](https://ex.test/pq) y");
    const r = linkCopyRange(s, 0, s.doc.length);
    expect(r!.plain).toBe("x [hoge](https://ex.test/pq) y");
  });

  it("a single-link selection also emits safeHref-gated <a> HTML", () => {
    const s = stateOf("[docs](https://ex.test/d)");
    const r = linkCopyRange(s, 0, s.doc.length);
    expect(r!.html).toBe('<a href="https://ex.test/d">docs</a>');
  });

  it("a dangerous-scheme link emits NO html (safeHref is the only judge)", () => {
    const s = stateOf("[x](javascript:alert(1))");
    const r = linkCopyRange(s, 0, s.doc.length);
    expect(r).not.toBeNull(); // still expands the plain source
    expect(r!.html).toBeUndefined(); // but no <a> for a dangerous scheme
  });

  it("returns null when the selection touches no link (CM copies normally)", () => {
    const s = stateOf("just some plain text");
    expect(linkCopyRange(s, 0, 9)).toBeNull();
  });
});
