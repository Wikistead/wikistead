// #985 / ADR-266 §1.4: the bulk-move destination list read `moveTargets.length === 0` straight into
// `spacePages.moveNoTargets` ("you manage no other spaces") with no read of whether the `spaces` /
// `moveSearch` queries that FEED `moveTargets` had actually failed — a network error stood in for a
// fact about the admin's own permissions. Neither query's `isError` appears anywhere in this file
// before this fix (measured), and #888's own walk does not catch this site: `moveNoTargets` contains
// neither "empty"/"Empty" nor "noResults", the two spellings that walk's EMPTY_STATE regex accepts.
//
// No `@testing-library/react` in this package (a new dependency needs a licence gate + review — see
// hint-order-881.test.ts), so this reads the source the way that file and bulk-bar-layout-511.test.ts
// do: JSX here is one flat ternary chain, so source order IS render-branch order, and this is a
// property of that chain, not of pixels.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(import.meta.dirname, "./SpacePagesTab.tsx"), "utf8");

describe("#985 a failed destination fetch is not an empty destination list", () => {
  it("moveIsError reads BOTH queries the destination list is actually sourced from", () => {
    const line = /const moveIsError = ([^;]+);/.exec(SRC)?.[1];
    expect(line, "moveIsError must exist").toBeTruthy();
    expect(line, "must read moveSearch's own failure").toContain("moveSearch.isError");
    expect(line, "must read spaces' own failure").toContain("spaces.isError");
  });

  it("the failure branch is checked BEFORE the empty-targets branch, in the same ternary chain moveNoTargets sits in", () => {
    const errorBranch = SRC.indexOf("moveIsError\n");
    const loadFailed = SRC.indexOf("<LoadFailed", errorBranch);
    const emptyBranch = SRC.indexOf('t("spacePages.moveNoTargets")');
    expect(errorBranch, "moveIsError is read in the render").toBeGreaterThan(-1);
    expect(loadFailed, "LoadFailed is drawn on that branch").toBeGreaterThan(errorBranch);
    expect(loadFailed, "...before the empty-targets branch, so a failure never falls through to it").toBeLessThan(emptyBranch);
  });

  it("⚠️ break-check: removing the moveIsError branch leaves ONLY the empty-targets check reachable", () => {
    // Simulates the pre-fix source: strip the `moveIsError ? <LoadFailed .../> :` prefix this fix
    // added — literally, the exact text this fix inserted, so the mutation is unambiguous — and
    // confirm what's left is exactly the bug: a bare `moveTargets.length === 0` ternary with no
    // failure read in front of it, which is the shape #985 was filed against.
    const inserted = '{moveIsError\n              ? <LoadFailed testId="bulk-move-failed" onRetry={() => { void moveRefetch(); }} />\n              : moveTargets.length === 0';
    expect(SRC, "the exact inserted text must still be present, unmodified").toContain(inserted);
    const withoutFix = SRC.replace(inserted, "{moveTargets.length === 0");
    expect(withoutFix, "the mutation actually changed the source").not.toBe(SRC);
    const emptyAt = withoutFix.indexOf('data-testid="bulk-move-empty"');
    const nearby = withoutFix.slice(Math.max(0, emptyAt - 200), emptyAt);
    expect(nearby, "the stripped version has no failure read guarding the empty-targets branch any more").not.toContain("moveIsError");
    expect(withoutFix, "...and the empty-targets ternary is still there, now unguarded").toContain("moveTargets.length === 0");
  });

  it("wires a retry to whichever query is actually live (typed filter vs. the roster page)", () => {
    const line = /const moveRefetch = ([^;]+);/.exec(SRC)?.[1];
    expect(line, "moveRefetch must exist").toBeTruthy();
    expect(line, "retries the search when the reader typed a filter").toContain("moveSearch.refetch");
    expect(line, "retries the roster page otherwise").toContain("spaces.refetch");
    expect(SRC).toMatch(/onRetry=\{\(\)\s*=>\s*\{\s*void moveRefetch\(\);?\s*\}\}/);
  });

  it("uses the shared #888 copy — no new wording for the same fact", () => {
    expect(SRC, "must render the shared LoadFailed component, not bespoke markup").toMatch(/<LoadFailed\s+testId="bulk-move-failed"/);
  });
});
