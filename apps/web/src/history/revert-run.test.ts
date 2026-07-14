// #327 the bulk-revert affordance guards. The one-click "revert this guest's edits" row may
// appear ONLY for an anonymous (anon:/guest:) latest run of 2+ revisions with a baseline beneath —
// a member's edit or a single revision must never grow a one-click that would restore whatever buried
// version precedes it (the review footgun: "revert bob's 1 edit" restored the vandal version).
import { describe, it, expect } from "vitest";
import { latestRun, isRevertableRun } from "./revert-run";

const revs = (...actors: (string | null)[]) => actors.map((createdBy) => ({ createdBy }));

describe("latestRun", () => {
  it("derives the newest contiguous same-actor run and whether a baseline exists", () => {
    expect(latestRun(revs("anon:aa", "anon:aa", "user:alice"))).toEqual({ actor: "anon:aa", count: 2, hasBaseline: true });
    expect(latestRun(revs("anon:aa", "anon:aa"))).toEqual({ actor: "anon:aa", count: 2, hasBaseline: false });
    expect(latestRun(revs())).toBeNull();
    expect(latestRun(revs(null, "user:alice"))).toBeNull(); // no recorded actor on the newest → no run
  });
});

describe("isRevertableRun (guards)", () => {
  it("allows only an anonymous run of 2+ revisions", () => {
    expect(isRevertableRun(latestRun(revs("anon:aa", "anon:aa", "user:alice")))).toBe(true);
    expect(isRevertableRun(latestRun(revs("guest:l1", "guest:l1", "user:alice")))).toBe(true);
  });
  it("rejects a member run — even a long one (bob's fix must not one-click back to a buried vandal)", () => {
    expect(isRevertableRun(latestRun(revs("user:bob", "anon:aa", "user:alice")))).toBe(false);
    expect(isRevertableRun(latestRun(revs("user:bob", "user:bob", "user:bob", "anon:aa")))).toBe(false);
  });
  it("rejects a single-revision run (one edit is handled by the plain per-revision restore)", () => {
    expect(isRevertableRun(latestRun(revs("anon:aa", "user:alice")))).toBe(false);
  });
  it("rejects when there is no run at all", () => {
    expect(isRevertableRun(null)).toBe(false);
  });
});
