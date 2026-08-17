// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { visibleSpaces, recordRecentSpace } from "./space-recent";
import type { Space } from "../data/queries";

const mk = (id: string, name: string): Space => ({ id, name });
const S = [mk("a", "Alpha"), mk("b", "Beta"), mk("c", "Gamma"), mk("d", "Delta")];

describe("#263 visibleSpaces (bounded default + search)", () => {
  beforeEach(() => localStorage.clear());

  it("empty query: current first, then fills with the rest (fresh member, no recents)", () => {
    const out = visibleSpaces(S, "c", "");
    expect(out[0]!.id).toBe("c"); // current pinned first
    expect(out.map((s) => s.id)).toEqual(["c", "a", "b", "d"]); // then the rest in order
  });

  it("empty query: recents (most-recent first) come right after the current space", () => {
    recordRecentSpace("d");
    recordRecentSpace("b"); // b is most recent
    const out = visibleSpaces(S, "a", "");
    expect(out.map((s) => s.id).slice(0, 3)).toEqual(["a", "b", "d"]); // current, then recents in order
  });

  it("query filters by name over ALL spaces, case-insensitive (not just the default set)", () => {
    expect(visibleSpaces(S, "a", "elt").map((s) => s.id)).toEqual(["d"]); // "Delta"
    expect(visibleSpaces(S, "a", "a").map((s) => s.id).sort()).toEqual(["a", "b", "c", "d"]); // every name has an "a"
    expect(visibleSpaces(S, "a", "zzz")).toEqual([]);
  });

  it("recordRecentSpace dedupes and keeps most-recent first", () => {
    recordRecentSpace("a");
    recordRecentSpace("b");
    recordRecentSpace("a"); // re-select a → moves to front, no dup
    expect(JSON.parse(localStorage.getItem("wks:recent-spaces")!)).toEqual(["a", "b"]);
  });

  it("the default set is capped (never unbounded)", () => {
    const many = Array.from({ length: 30 }, (_, i) => mk(`s${i}`, `S${i}`));
    expect(visibleSpaces(many, "s0", "").length).toBe(8);
  });
});

describe("#284 visibleSpaces with pins (pinned-first, cap-exempt)", () => {
  beforeEach(() => localStorage.clear());

  it("pinned spaces come FIRST, in pin order, before the current space", () => {
    const out = visibleSpaces(S, "a", "", ["d", "b"]);
    expect(out.map((s) => s.id).slice(0, 3)).toEqual(["d", "b", "a"]); // pins in order, then current
  });

  it("a pinned current space is not duplicated", () => {
    const out = visibleSpaces(S, "b", "", ["b"]);
    expect(out.filter((s) => s.id === "b").length).toBe(1);
    expect(out[0]!.id).toBe("b");
  });

  it("pins are exempt from the cap: the bounded tail stays full-size alongside pins", () => {
    const many = Array.from({ length: 30 }, (_, i) => mk(`s${i}`, `S${i}`));
    const pinned = ["s20", "s21", "s22"];
    const out = visibleSpaces(many, "s0", "", pinned);
    expect(out.length).toBe(11); // 3 pins + 8 bounded
    expect(out.map((s) => s.id).slice(0, 3)).toEqual(pinned); // and none of the pins were folded
  });

  it("a pinned id whose space is no longer viewable is skipped (no phantom row)", () => {
    const out = visibleSpaces(S, "a", "", ["zzz", "c"]);
    expect(out.map((s) => s.id).slice(0, 2)).toEqual(["c", "a"]);
  });

  it("while searching, the pin ordering is irrelevant (filter spans all spaces)", () => {
    expect(visibleSpaces(S, "a", "elt", ["b"]).map((s) => s.id)).toEqual(["d"]);
  });
});

// #710: hiddenSpaceCount / allSpacesSorted are retired with the client-side roster walk — the
// count and the name order both come from the server now (a first-page count would lie).
