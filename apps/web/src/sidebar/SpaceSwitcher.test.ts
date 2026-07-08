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
