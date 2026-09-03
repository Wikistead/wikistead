import { describe, it, expect } from "vitest";
import { afterIdForMove } from "./lazy-tree";

const page = (id: string, parentId: string | null, position: number) => ({
  id,
  spaceId: "space",
  title: id,
  parentId,
  position,
  published: false,
  hasUnpublishedChanges: false,
  private: false,
  frozen: null,
  taskDone: 0,
  taskTotal: 0,
  hasChildren: false,
});

// #1080 (#1077 review): the server nulls a placeholder-child page's `parentId` (ADR-220 §4.2), which
// makes it indistinguishable from a genuine root page once flattened. `Sidebar.tsx`'s `pages` list
// (fed by `lazyTree.byParent`) mixes both in — this pin exercises the resulting `afterId` computation
// directly, at the same "flat pages + placeholder ids" shape the component builds.
describe("#1080: root drag-reorder does not count a placeholder-child page as a root sibling", () => {
  it("skips a placeholder-child page when computing afterId among root pages", () => {
    // Root has three real pages (a, b, c) at positions 0/1/2, and one placeholder-child page ("hidden")
    // whose parentId the server nulled — same shape as a real root page, but it renders nested under
    // a placeholder row, never at root, so it never occupies a screen index the reader dragged past.
    // Dragging "c" to index 2 (the reader's second on-screen slot, meaning "after b") must compute
    // afterId "b" — not "hidden", which only outranks "b" once it is wrongly counted as a sibling.
    const pages = [page("a", null, 0), page("b", null, 1), page("c", null, 2), page("hidden", null, 0.5)];
    const placeholderChildIds = new Set(["hidden"]);

    const afterId = afterIdForMove({ pages, placeholderChildIds, parentPageId: null, movedId: "c", index: 2 });
    expect(afterId, "the reader's screen order (a, b) — the placeholder child is not a root sibling").toBe("b");
  });

  it("an empty placeholderChildIds reproduces the defect (documents why the filter is load-bearing)", () => {
    // Calls the SAME function, same pages, same index as the fixed test above, with an empty set
    // standing in for "the caller forgot to pass placeholder-child ids" — the pre-#1080 shape. "hidden"
    // sorts between "a" and "b" by position, so it becomes the SECOND sibling and index 2 (meant to
    // land after "b") resolves to "hidden" instead: an id `pages.ts:2862`'s sibling check rejects
    // unless a real root page happens to reuse it, which is the ticket's "lands one slot off" wording.
    const pages = [page("a", null, 0), page("b", null, 1), page("c", null, 2), page("hidden", null, 0.5)];
    const afterId = afterIdForMove({ pages, placeholderChildIds: new Set(), parentPageId: null, movedId: "c", index: 2 });
    expect(afterId, "the defect this ticket describes, reproduced through the real function").toBe("hidden");
  });

  it("a non-root parentId is unaffected: a placeholder-child's nulled parentId never matches a real parent id", () => {
    const pages = [page("child1", "realParent", 0), page("child2", "realParent", 1), page("hidden", null, 0)];
    const placeholderChildIds = new Set(["hidden"]);
    const afterId = afterIdForMove({ pages, placeholderChildIds, parentPageId: "realParent", movedId: "child2", index: 1 });
    expect(afterId).toBe("child1");
  });
});
