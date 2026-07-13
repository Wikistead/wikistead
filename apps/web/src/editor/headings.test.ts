// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdownExtension } from "./markdown-config";
import { slugify, extractHeadings } from "./headings";
import { extractHeadingsFromMarkdown, sliceSectionBySlug, sliceBlockByAnchor } from "@wikistead/macro-render";

const stateOf = (doc: string) => EditorState.create({ doc, extensions: [markdownExtension()] });

describe("slugify (#192 TOC anchors)", () => {
  it("lowercases, hyphenates spaces, drops punctuation", () => {
    expect(slugify("Hello, World!", new Set())).toBe("hello-world");
  });
  it("dedupes repeats with a numeric suffix (distinct anchors)", () => {
    const seen = new Set<string>();
    expect(slugify("Intro", seen)).toBe("intro");
    expect(slugify("Intro", seen)).toBe("intro-2");
    expect(slugify("Intro", seen)).toBe("intro-3");
  });
  it("falls back to 'section' for empty/punctuation-only text", () => {
    expect(slugify("!!!", new Set())).toBe("section");
  });
  // #313: anchors must work for CJK headings — Unicode letters/numbers are kept (like
  // github-slugger), so Japanese headings get real slugs instead of colliding on "section".
  it("keeps Unicode (Japanese) heading text", () => {
    expect(slugify("日本語の見出し", new Set())).toBe("日本語の見出し");
    expect(slugify("導入 と 背景", new Set())).toBe("導入-と-背景");
  });
  it("drops punctuation but keeps mixed CJK/ASCII words", () => {
    expect(slugify("設計（案）: API v2!", new Set())).toBe("設計案-api-v2");
  });
  it("dedupes CJK repeats too", () => {
    const seen = new Set<string>();
    expect(slugify("概要", seen)).toBe("概要");
    expect(slugify("概要", seen)).toBe("概要-2");
  });
});

describe("extractHeadings (#192 TOC — from the syntax tree)", () => {
  it("returns ordered headings with level + text + unique slug", () => {
    const hs = extractHeadings(stateOf("# Title\n\nintro\n\n## Section A\n\n### Deep\n\n## Section A\n"));
    expect(hs.map((h) => [h.level, h.text])).toEqual([
      [1, "Title"], [2, "Section A"], [3, "Deep"], [2, "Section A"],
    ]);
    expect(hs.map((h) => h.slug)).toEqual(["title", "section-a", "deep", "section-a-2"]); // deduped
    expect(hs[0]!.from).toBe(0); // first heading at doc start (scroll target)
  });

  it("does NOT treat a '#' inside a fenced code block as a heading (tree-accurate, not regex)", () => {
    const hs = extractHeadings(stateOf("# Real\n\n```sh\n# not a heading\n```\n\n## Also real\n"));
    expect(hs.map((h) => h.text)).toEqual(["Real", "Also real"]); // the code-fence '#' is excluded
  });
});

// #325 / ADR-137: the editor extraction (extractHeadings, from the CM tree) and the shared server-side
// extraction (extractHeadingsFromMarkdown, from macro-render's mdParser) MUST agree on the same markdown
// they slug the TOC anchors AND the section-transclusion boundaries, so any drift would let a `#slug` link
// resolve a different section than the anchor it was copied from. Both run the SAME slugify + parse, so this
// pins them structurally (not a port).
describe("heading extraction parity: editor vs shared server extractor (#325 / ADR-137)", () => {
  const docs = [
    "# Title\n\nintro\n\n## Section A\n\n### Deep\n\n## Section A\n", // dedup
    "# 導入\n\n本文\n\n## 設計（案）: API v2\n\nx\n", // CJK + punctuation
    "# Real\n\n```sh\n# not a heading\n```\n\n## Also real\n", // fence guard
    ":::note\n# inside a directive body\n:::\n\n## top\n", // directive-body heading IS a section (matches client)
  ];
  for (const [i, md] of docs.entries()) {
    it(`agrees on level+text+slug for doc #${i}`, () => {
      const editor = extractHeadings(stateOf(md)).map((h) => [h.level, h.text, h.slug]);
      const shared = extractHeadingsFromMarkdown(md).map((h) => [h.level, h.text, h.slug]);
      expect(shared).toEqual(editor);
    });
  }
});

describe("sliceSectionBySlug (#325 / ADR-137 — section boundaries)", () => {
  const doc = "# Intro\n\nintro body\n\n## Details\n\ndetail body\n\n# Other\n\nother body\n";

  it("slices a subsection up to the next same-or-higher heading", () => {
    expect(sliceSectionBySlug(doc, "details")).toBe("## Details\n\ndetail body");
  });
  it("a top-level section keeps its nested subsections (stops at the next H1)", () => {
    expect(sliceSectionBySlug(doc, "intro")).toBe("# Intro\n\nintro body\n\n## Details\n\ndetail body");
  });
  it("the last section runs to end-of-document", () => {
    expect(sliceSectionBySlug(doc, "other")).toBe("# Other\n\nother body");
  });
  it("returns null for an unknown slug (caller renders the denied placeholder — no oracle)", () => {
    expect(sliceSectionBySlug(doc, "nope")).toBeNull();
  });
});

describe("sliceBlockByAnchor (#325 / ADR-137 slice 2 — block refs)", () => {
  const doc = "para one\n\nsecond para ^abc\n\n- item a\n- item b ^item2\n\n```js\ncode ^infence\n```\n";

  it("resolves a paragraph block by its ^id, with the marker stripped", () => {
    expect(sliceBlockByAnchor(doc, "abc")).toBe("second para");
  });
  it("resolves a LIST ITEM (keeps the `-`, not the whole list nor the inner paragraph)", () => {
    expect(sliceBlockByAnchor(doc, "item2")).toBe("- item b");
  });
  it("resolves a fenced code block including its fences", () => {
    expect(sliceBlockByAnchor(doc, "infence")).toBe("```js\ncode\n```");
  });
  it("returns null for an unknown id (denied placeholder — no oracle)", () => {
    expect(sliceBlockByAnchor(doc, "missing")).toBeNull();
  });
  it("returns null for an invalid id shape (too short / illegal chars) — treated as unknown", () => {
    expect(sliceBlockByAnchor(doc, "ab")).toBeNull();
    expect(sliceBlockByAnchor(doc, "Bad_Id")).toBeNull();
  });
  it("a duplicate id resolves to the FIRST match", () => {
    expect(sliceBlockByAnchor("first ^dup\n\nsecond ^dup\n", "dup")).toBe("first");
  });
});
