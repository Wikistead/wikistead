import { describe, it, expect } from "vitest";
import { matchTitleLinks } from "./title-links";

// #224 / ADR-104 point 3: the mis-match suppression + matching core (UX-only, no authz — the dictionary is
// already viewer-authorized). These lock the suppression heuristics so the decoration never over-links.
describe("matchTitleLinks", () => {
  it("links a whole-word latin title occurrence", () => {
    const m = matchTitleLinks("see the Release Notes here", [{ title: "Release Notes", pageId: "p1" }]);
    expect(m).toEqual([{ from: 8, to: 21, pageId: "p1", title: "Release Notes" }]);
  });

  it("does NOT link a latin title inside a larger word (word boundary)", () => {
    // "cat" must not light up inside "concatenate"
    expect(matchTitleLinks("please concatenate them", [{ title: "cats", pageId: "p1" }])).toEqual([]);
  });

  it("links a CJK title as a substring (no word boundaries in Japanese)", () => {
    const m = matchTitleLinks("これは設計方針の話です", [{ title: "設計方針", pageId: "jp" }]);
    expect(m).toEqual([{ from: 3, to: 7, pageId: "jp", title: "設計方針" }]);
  });

  it("longest-match-wins: a title that is a substring of a longer matched title does not double-link", () => {
    const m = matchTitleLinks("open the Release Notes page", [
      { title: "Release", pageId: "short" },
      { title: "Release Notes", pageId: "long" },
    ]);
    // only the longer title claims the range; "Release" cannot re-match inside it
    expect(m).toEqual([{ from: 9, to: 22, pageId: "long", title: "Release Notes" }]);
  });

  it("firstPerPage: only the first occurrence of a page's title is linked", () => {
    const m = matchTitleLinks("Roadmap then more Roadmap text", [{ title: "Roadmap", pageId: "p1" }]);
    expect(m).toEqual([{ from: 0, to: 7, pageId: "p1", title: "Roadmap" }]);
  });

  it("firstPerPage=false links every occurrence", () => {
    const m = matchTitleLinks("Roadmap and Roadmap", [{ title: "Roadmap", pageId: "p1" }], { firstPerPage: false });
    expect(m.map((x) => x.from)).toEqual([0, 12]);
  });

  it("respects minLen for latin titles (short titles are noise)", () => {
    expect(matchTitleLinks("the api is here", [{ title: "api", pageId: "p1" }])).toEqual([]); // len 3 < 4
    expect(matchTitleLinks("the apis are here", [{ title: "apis", pageId: "p1" }]).length).toBe(1); // len 4 ok
  });

  it("respects minCjkLen for CJK titles", () => {
    expect(matchTitleLinks("猫がいる", [{ title: "猫", pageId: "p1" }])).toEqual([]); // len 1 < 2
    expect(matchTitleLinks("猫舌だね", [{ title: "猫舌", pageId: "p1" }]).length).toBe(1); // len 2 ok
  });

  it("skips stop words case-insensitively", () => {
    const m = matchTitleLinks("Home is where", [{ title: "Home", pageId: "p1" }], { stopWords: new Set(["home"]) });
    expect(m).toEqual([]);
  });

  it("is case-insensitive when matching", () => {
    const m = matchTitleLinks("the ROADMAP is set", [{ title: "Roadmap", pageId: "p1" }]);
    expect(m).toEqual([{ from: 4, to: 11, pageId: "p1", title: "Roadmap" }]);
  });

  it("returns matches sorted by position across multiple pages", () => {
    const m = matchTitleLinks("Beta before Alpha", [
      { title: "Alpha", pageId: "a" },
      { title: "Beta", pageId: "b" },
    ]);
    expect(m.map((x) => x.pageId)).toEqual(["b", "a"]);
  });

  it("ignores empty/whitespace titles", () => {
    expect(matchTitleLinks("anything here", [{ title: "   ", pageId: "p1" }])).toEqual([]);
  });

  // #224(5): a page's OWN title never self-links inside its own body (selfPageId is skipped).
  it("skips the self page's own title (no self-link)", () => {
    const dict = [{ title: "Roadmap", pageId: "self" }, { title: "Backlog", pageId: "other" }];
    const text = "the Roadmap links to the Backlog";
    // without selfPageId both match…
    expect(matchTitleLinks(text, dict).map((x) => x.pageId).sort()).toEqual(["other", "self"]);
    // …with selfPageId="self", only the OTHER page links (the self title is inert).
    const m = matchTitleLinks(text, dict, { selfPageId: "self" });
    expect(m.map((x) => x.pageId)).toEqual(["other"]);
  });

  // #224 anti-test 7 (ADR-104 Addendum 3): the v1-ACCEPTED CJK over-match, pinned as a RECORD test.
  // Japanese has no word boundaries, so a CJK title matches as a SUBSTRING — lights up inside
  // . This is the documented v1 trade-off (real JP segmentation is a future ticket); if a
  // tokenizer change alters it, this test makes that an INTENTIONAL decision, not a silent regression.
  it("RECORD (v1-accepted over-match): a CJK title matches as a substring inside a longer word", () => {
    const m = matchTitleLinks("この基本設計書を読む", [{ title: "設計", pageId: "p1" }]);
    expect(m).toHaveLength(1);
    expect(m[0]!.pageId).toBe("p1");
    // …while a LATIN title still requires word boundaries (no such over-match).
    expect(matchTitleLinks("concatenate these", [{ title: "cate", pageId: "p2" }])).toEqual([]);
  });
});
