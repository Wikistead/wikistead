import { describe, it, expect } from "vitest";
import { parseFrontmatterRange, parseFmTags, setTagsInFrontmatter } from "./frontmatter";

// #370 / ADR-145 §2: the frontmatter helpers — position-0-only fence detection, the minimal YAML-subset
// `tags:` parse (mirrors the server's extractFrontmatterTags), and the ONE-line rewrite the chip editor
// dispatches (all other frontmatter lines preserved verbatim — Open formats).
describe("parseFrontmatterRange (#370)", () => {
  it("captures the leading fence and its inner text", () => {
    const r = parseFrontmatterRange("---\ntags: [a]\ntitle: x\n---\nbody");
    expect(r).not.toBeNull();
    expect(r!.from).toBe(0);
    expect(r!.inner).toBe("tags: [a]\ntitle: x");
    expect("---\ntags: [a]\ntitle: x\n---\nbody".slice(0, r!.to)).toBe("---\ntags: [a]\ntitle: x\n---");
  });
  it("is position-0-only and requires a closing fence", () => {
    expect(parseFrontmatterRange("intro\n---\ntags: [a]\n---")).toBeNull();
    expect(parseFrontmatterRange("---\ntags: [a]")).toBeNull(); // a lone --- is a thematic break
    expect(parseFrontmatterRange("")).toBeNull();
  });
});

describe("parseFmTags (#370)", () => {
  it("parses inline array / dash list / scalar, strips quotes, dedupes case-insensitively", () => {
    expect(parseFmTags('tags: [Recipes, "b c", recipes]')).toEqual([
      { tag: "recipes", display: "Recipes" }, { tag: "b c", display: "b c" },
    ]);
    expect(parseFmTags("tags:\n  - one\n  - two")).toEqual([
      { tag: "one", display: "one" }, { tag: "two", display: "two" },
    ]);
    expect(parseFmTags("tags: solo")).toEqual([{ tag: "solo", display: "solo" }]);
    expect(parseFmTags("title: x")).toEqual([]);
  });
});

describe("setTagsInFrontmatter (#370 — one-line rewrite, everything else verbatim)", () => {
  it("replaces an existing inline tags line in place", () => {
    expect(setTagsInFrontmatter("---\ntitle: x\ntags: [a]\ndate: y\n---", ["a", "b"]))
      .toBe("---\ntitle: x\ntags: [a, b]\ndate: y\n---");
  });
  it("collapses a dash-list entry into the inline form", () => {
    expect(setTagsInFrontmatter("---\ntags:\n  - a\n  - b\ntitle: x\n---", ["c"]))
      .toBe("---\ntags: [c]\ntitle: x\n---");
  });
  it("inserts a tags line after the opening fence when none exists", () => {
    expect(setTagsInFrontmatter("---\ntitle: x\n---", ["a"])).toBe("---\ntags: [a]\ntitle: x\n---");
  });
  it("an empty tag list REMOVES the tags line (other fields untouched)", () => {
    expect(setTagsInFrontmatter("---\ntags: [a]\ntitle: x\n---", [])).toBe("---\ntitle: x\n---");
    expect(setTagsInFrontmatter("---\ntitle: x\n---", [])).toBe("---\ntitle: x\n---");
  });
  it("quotes a tag containing YAML metacharacters", () => {
    expect(setTagsInFrontmatter("---\n---", ["a,b", 'say "hi"'])).toBe('---\ntags: ["a,b", "say \\"hi\\""]\n---');
  });
  it("round-trips: setTags → parseFmTags yields the same display strings", () => {
    const block = setTagsInFrontmatter("---\n---", ["Recipes", "week night"]);
    const r = parseFrontmatterRange(block + "\nbody")!;
    expect(parseFmTags(r.inner).map((t) => t.display)).toEqual(["Recipes", "week night"]);
  });
});
