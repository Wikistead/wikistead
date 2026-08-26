// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdownExtension } from "../markdown-config";
import { displayMode } from "./decorations";
import { linkCopyRange } from "./paste-linkify";

// #223 comment 895 (root cause A): CM's copy is a raw doc-slice, so copying a rendered `[hoge](url)` over a
// selection that maps through the hidden markers yields a fragment (`hoge](`). linkCopyRange expands the
// copied range to whole Link nodes so text/plain is the COMPLETE source. Pure — driven by a real state.
//
// #909: that expansion is only CORRECT when the link's markers are actually hidden. `pasteLinkify()` (the
// only caller in the shipped editor, editor-livepreview.ts:226) is installed EDITABLE-only — Reading never
// runs this code at all — so the two modes this function actually sees are "live" (the default: raw syntax
// reveals the instant selection/caret touches it, per decorations.ts's `syntaxRevealsAt`) and "wysiwyg"
// (raw syntax NEVER shows, by design — text is edited via the toolbar instead). Because "live" reveals on
// ANY touch, a selection that reaches `linkCopyRange` having touched a link in live mode has, by that same
// rule, ALREADY caused the view to show its raw source — so the plain doc-slice CM would copy by default is
// already exactly right, and expanding it would be the #909 bug (widening a correct, exposed-line selection
// to the whole link). wysiwyg never reveals, so there the link is always effectively "hidden" and the
// original #223 expansion remains necessary — that is what these fixtures set `displayMode.of("wysiwyg")`
// to represent, standing in for "this link's raw form is not what's on screen."
const stateOf = (doc: string, extra: readonly (ReturnType<typeof displayMode.of>)[] = []) =>
  EditorState.create({ doc, extensions: [markdownExtension(), ...extra] });
const wysiwyg = (doc: string) => stateOf(doc, [displayMode.of("wysiwyg")]);

describe("#223 linkCopyRange — link never reveals (wysiwyg), copy still expands to full source", () => {
  it("expands a selection that cuts through a link to the FULL link source (no fragment)", () => {
    const s = wysiwyg("x [hoge](https://ex.test/pq) y");
    // select "hoge" (offsets 3..7) — inside the link text, cutting through the hidden markers
    const r = linkCopyRange(s, 3, 7);
    expect(r).not.toBeNull();
    expect(r!.plain).toBe("[hoge](https://ex.test/pq)"); // whole link, not `hoge](`
  });

  it("selecting the whole line keeps the complete link", () => {
    const s = wysiwyg("x [hoge](https://ex.test/pq) y");
    const r = linkCopyRange(s, 0, s.doc.length);
    expect(r!.plain).toBe("x [hoge](https://ex.test/pq) y");
  });

  it("a single-link selection also emits safeHref-gated <a> HTML", () => {
    const s = wysiwyg("[docs](https://ex.test/d)");
    const r = linkCopyRange(s, 0, s.doc.length);
    expect(r!.html).toBe('<a href="https://ex.test/d">docs</a>');
  });

  it("a dangerous-scheme link emits NO html (safeHref is the only judge)", () => {
    const s = wysiwyg("[x](javascript:alert(1))");
    const r = linkCopyRange(s, 0, s.doc.length);
    expect(r).not.toBeNull(); // still expands the plain source
    expect(r!.html).toBeUndefined(); // but no <a> for a dangerous scheme
  });

  it("returns null when the selection touches no link (CM copies normally)", () => {
    const s = wysiwyg("just some plain text");
    expect(linkCopyRange(s, 0, 9)).toBeNull();
  });
});

// #909: live mode (the default) reveals a link's raw source the moment a selection touches it — the
// literal bug report ("select just part of the URL on an exposed line, the whole link gets copied
// anyway"). linkCopyRange must NOT expand here: null tells the caller to let CM's default copy through,
// which is already an exact slice of the (now-raw, on-screen) source.
describe("#909 linkCopyRange — live mode reveals on touch, an exact selection is left alone", () => {
  it("a selection inside a live-mode link's URL is NOT widened (returns null)", () => {
    const s = stateOf("x [hoge](https://ex.test/pq) y");
    // "ex.test" inside the URL — offsets 17..24
    expect(s.sliceDoc(17, 24)).toBe("ex.test");
    expect(linkCopyRange(s, 17, 24)).toBeNull();
  });

  it("a selection of just the link LABEL in live mode is also left alone", () => {
    const s = stateOf("x [hoge](https://ex.test/pq) y");
    expect(s.sliceDoc(3, 7)).toBe("hoge");
    expect(linkCopyRange(s, 3, 7)).toBeNull();
  });

  it("selecting the whole live-mode link still returns null (default copy already has it all)", () => {
    const s = stateOf("[docs](https://ex.test/d)");
    expect(linkCopyRange(s, 0, s.doc.length)).toBeNull();
  });

  it("still returns null when the selection touches no link (nothing to reconsider)", () => {
    const s = stateOf("just some plain text");
    expect(linkCopyRange(s, 0, 9)).toBeNull();
  });
});
