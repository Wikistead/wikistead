import { describe, it, expect } from "vitest";
import { afterIdForMove, type BranchAnswer } from "./lazy-tree";

const page = (id: string, position: number) => ({
  id,
  spaceId: "space",
  title: id,
  parentId: null,
  position,
  published: false,
  hasUnpublishedChanges: false,
  private: false,
  frozen: null,
  taskDone: 0,
  taskTotal: 0,
  hasChildren: false,
});

const branch = (pages: ReturnType<typeof page>[], extra: Partial<BranchAnswer> = {}): BranchAnswer => ({
  pages, nextCursor: null, ...extra,
});

// #1080 (#1077 review): the server nulls a placeholder-child page's `parentId` (ADR-220 §4.2), which
// makes it indistinguishable from a genuine root page once flattened into a single list. #1092
// removed that flattening step entirely — `afterIdForMove` now reads one branch's own answer, where a
// placeholder-child page lives only inside `ph.pages` (nested), never in `branch.pages` or
// `branch.reachedWindow.pages` (the two arrays this function draws siblings from) — so there is no
// longer a set to filter it out of; it structurally cannot appear.
describe("#1080: a placeholder-child page is never counted as a root sibling", () => {
  it("skips a placeholder-child page when computing afterId among root pages", () => {
    // Root has three real pages (a, b, c) and one placeholder row holding a hidden child. Render
    // order: a, b, c, placeholder-row (1 synthetic row, appended after every real primary page).
    const b = branch([page("a", 0), page("b", 1), page("c", 2)], {
      placeholders: [{ token: "ph1", under: null, parentToken: null, pages: [page("hidden", 0.5)] }],
    });
    // Dragging "a" past the placeholder row (react-arborist's original-slot-inclusive index for
    // "past everything" = the full rendered length, 4) must land after "c" — the last REAL row — not
    // after "hidden", which the placeholder row's mere presence must not promote to a root sibling.
    const afterId = afterIdForMove({ branch: b, parentPageId: null, movedId: "a", index: 4 });
    expect(afterId, "lands after the last real page; the placeholder's hidden child is never a candidate").toBe("c");
  });

  it("a non-root parentId is unaffected: the placeholder gate is per-branch, not a global id set", () => {
    const b = branch([page("child1", 0), page("child2", 1)]);
    const afterId = afterIdForMove({ branch: b, parentPageId: "realParent", movedId: "child2", index: 1 });
    expect(afterId).toBe("child1");
  });
});

// #1080 rev2 (review): the index/movedId mismatch reproduces with ZERO synthetic rows —
// a bare root of three real pages already misplaces every downward drag. These pin the shipped code
// against a plain root=[a,b,c], matching the three drags the review measured by hand. #1092's
// rewrite must reproduce them identically: with no placeholders, no exhausted row, no "more" row and
// no reached window, `synthetic` is 0 and this collapses to the pre-#1092 arithmetic exactly.
describe("#1080 rev2: root drag-reorder lands where the reader dropped it, no synthetic rows involved", () => {
  const root3 = branch([page("a", 0), page("b", 1), page("c", 2)]);

  it("drag the top row to the bottom (index 3) — lands after the last row, not at the top", () => {
    const afterId = afterIdForMove({ branch: root3, parentPageId: null, movedId: "a", index: 3 });
    expect(afterId, "a dropped past c belongs after c, not thrown back to null/first").toBe("c");
  });

  it("drag the top row one slot down (index 2, between b and c) — lands after b, not after c", () => {
    const afterId = afterIdForMove({ branch: root3, parentPageId: null, movedId: "a", index: 2 });
    expect(afterId, "a downward drag one slot short of the bottom must not overshoot to the last row").toBe("b");
  });

  it("drag the bottom row upward (index 1, between a and b) — lands after a (this direction was already correct)", () => {
    const afterId = afterIdForMove({ branch: root3, parentPageId: null, movedId: "c", index: 1 });
    expect(afterId).toBe("a");
  });
});

// #1092: the defect this ticket exists for. `assemble()` renders a reached-window branch (#899 — the
// extra window fetched to reach a page opened deep in the tree) as real … synthetic … real, never one
// unbroken block of real rows. The old code (a flat, cross-branch `pages` list built from only
// `b.pages`, never `b.reachedWindow`) could not see the second real group at all; dropping there
// either landed on the wrong row or silently clamped to "end of the first group".
describe("#1092: a branch with a reached window renders real … synthetic … real, and afterId must too", () => {
  it("dropping between the two reached-window pages lands correctly, past a placeholder row", () => {
    // Render order: a, b, c (primary) · ph (synthetic, 1 row) · d, e (reached window). Six rendered
    // rows in all. Dragging "a" to sit between "d" and "e" — react-arborist's index (the dragged row
    // still counted at its ORIGINAL slot, per) is 5: [a,b,c,ph,d,e], "above" = d at index 4, so
    // index = indexOf(above) + 1 = 5.
    const b = branch([page("a", 0), page("b", 1), page("c", 2)], {
      placeholders: [{ token: "ph1", under: null, parentToken: null, pages: [page("hidden", 0.5)] }],
      reachedWindow: branch([page("d", 10), page("e", 11)]),
    });
    const afterId = afterIdForMove({ branch: b, parentPageId: null, movedId: "a", index: 5 });
    expect(afterId, "lands after d — the synthetic placeholder row must not be mistaken for a 4th real row").toBe("d");
  });

  it("dropping right after the synthetic block, before the reached window starts, clamps to the end of primary", () => {
    // Render order: a, b, c · exhausted-row (synthetic) · d, e. Dropping between the exhausted row and
    // "d" — "above" = the exhausted row at index 3 in [a,b,c,ex,d,e], so index = 3 + 1 = 4 — must not
    // silently jump into the reached window; it lands after the last PRIMARY page, matching #1080
    // rev2's "not a request to nest among page rows" clamp.
    const b = branch([page("a", 0), page("b", 1), page("c", 2)], {
      placeholdersExhausted: true,
      reachedWindow: branch([page("d", 10), page("e", 11)]),
    });
    const afterId = afterIdForMove({ branch: b, parentPageId: null, movedId: "a", index: 4 });
    expect(afterId, "clamps to after c, the last primary row — not into the reached window").toBe("c");
  });

  it("multiple synthetic rows (exhausted + more) between two real groups are all skipped, not just one", () => {
    // Render order: a, b · exhausted-row, more-row (2 synthetic) · c, d (reached). Dragging "a" to land
    // between "c" and "d" — "above" = c at index 4 in [a,b,ex,more,c,d], so index = 4 + 1 = 5. A version
    // that skipped only ONE synthetic row (off by one) would land after "d" instead — clamping to
    // `real.length` cannot rescue that mistake here, unlike a drop at the very end would.
    const b = branch([page("a", 0), page("b", 1)], {
      placeholdersExhausted: true, nextCursor: "cursor-1",
      reachedWindow: branch([page("c", 10), page("d", 11)]),
    });
    const afterId = afterIdForMove({ branch: b, parentPageId: null, movedId: "a", index: 5 });
    expect(afterId, "both synthetic rows must be skipped in one pass, not just the first").toBe("c");
  });
});
