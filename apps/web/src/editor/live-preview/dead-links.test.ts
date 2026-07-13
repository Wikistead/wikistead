import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdownExtension } from "../markdown-config";
import { collectInternalLinks } from "./dead-links";

// #276 / ADR-117: the dead-link overlay collects its `/p/<id>` targets from the SAME Lezer Link nodes +
// linkHref sanitizer as the cm-lp-link mark, so overlay and link body never disagree. These pin the
// collection: internal `/p/<id>` links only — external URLs, attachment links, and non-links are excluded.
const mk = (doc: string) => EditorState.create({ doc, extensions: [markdownExtension()] });
const ids = (doc: string) => collectInternalLinks(mk(doc)).map((l) => l.id);

describe("collectInternalLinks (#276 / ADR-117)", () => {
  it("collects the id of an internal /p/<id> link", () => {
    const doc = "see [the target](/p/abc-123) here";
    const found = collectInternalLinks(mk(doc));
    expect(found.map((l) => l.id)).toEqual(["abc-123"]);
    // the range spans the whole Link node (so the dead mark layers over the same span as cm-lp-link)
    expect(doc.slice(found[0]!.from, found[0]!.to)).toBe("[the target](/p/abc-123)");
  });

  it("collects multiple internal links and strips any query/hash from the id", () => {
    expect(ids("[a](/p/one) and [b](/p/two?x=1) and [c](/p/three#frag)")).toEqual(["one", "two", "three"]);
  });

  it("excludes EXTERNAL links (http/https/mailto) — external liveness is out of scope", () => {
    expect(ids("[x](https://example.com/p/notapage) [y](mailto:a@b.c) [z](http://p/nope)")).toEqual([]);
  });

  it("excludes attachment links and other non-/p paths", () => {
    expect(ids("[file](wks-attachment:xyz) [home](/) [rel](/other/abc)")).toEqual([]);
  });

  it("ignores plain text that merely looks like a path (no Link node)", () => {
    expect(ids("just text /p/abc not a link")).toEqual([]);
  });
});
