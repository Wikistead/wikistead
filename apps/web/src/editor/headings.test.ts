// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdownExtension } from "./markdown-config";
import { slugify, extractHeadings } from "./headings";

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
