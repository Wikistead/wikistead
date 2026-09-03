import { describe, expect, it } from "vitest";
import { buildLazyNodes, PLACEHOLDERS_EXHAUSTED_PREFIX, type BranchAnswer } from "./lazy-tree";

const page = (id: string) => ({
  id,
  spaceId: "space",
  title: id,
  parentId: null,
  position: 0,
  published: false,
  hasUnpublishedChanges: false,
  private: false,
  frozen: null,
  taskDone: 0,
  taskTotal: 0,
  hasChildren: false,
});

// #1079 (#1077 review): `placeholdersExhausted` reached the client and had nothing reading it — a
// server-reported "some pages could not be placed here" (ADR-220 §4.3) that rendered as nothing at
// all, which is exactly the "short answer that looks complete" §4.3 forbids.
describe("#1079: an exhausted placeholder budget is a visible row, not a silently short list", () => {
  it("renders a row for a branch whose placeholder budget ran out", () => {
    const root: BranchAnswer = {
      pages: [page("a")],
      nextCursor: null,
      placeholders: [{ token: "t1", under: null, parentToken: null, pages: [page("b")] }],
      placeholdersExhausted: true,
    };

    const nodes = buildLazyNodes({
      spaceId: "space",
      byParent: new Map([[null, root]]),
      pinnedPageIds: new Set(),
      placeholderName: "Hidden",
      placeholdersExhaustedLabel: "Some pages could not be shown",
    });

    expect(nodes.map((n) => n.id)).toEqual(["page:a", "ph:t1", `${PLACEHOLDERS_EXHAUSTED_PREFIX}root`]);
    const row = nodes.find((n) => n.id.startsWith(PLACEHOLDERS_EXHAUSTED_PREFIX));
    expect(row?.name, "the label is what the caller passed, not invented here").toBe("Some pages could not be shown");
    expect(row?.children, "not usable like a page or a placeholder — nothing to expand into").toEqual([]);
  });

  it("draws no row when the budget was not exhausted", () => {
    const root: BranchAnswer = {
      pages: [page("a")],
      nextCursor: null,
      placeholders: [{ token: "t1", under: null, parentToken: null, pages: [page("b")] }],
      placeholdersExhausted: false,
    };

    const nodes = buildLazyNodes({
      spaceId: "space",
      byParent: new Map([[null, root]]),
      pinnedPageIds: new Set(),
      placeholderName: "Hidden",
      placeholdersExhaustedLabel: "Some pages could not be shown",
    });

    expect(nodes.some((n) => n.id.startsWith(PLACEHOLDERS_EXHAUSTED_PREFIX)), "undefined/false must not draw the row either").toBe(false);
  });

  it("is per branch: the child's exhausted row nests under the child, not the root", () => {
    const root: BranchAnswer = { pages: [{ ...page("a"), hasChildren: true }], nextCursor: null };
    const child: BranchAnswer = {
      pages: [],
      nextCursor: null,
      placeholders: [{ token: "t2", under: "a", parentToken: null, pages: [page("c")] }],
      placeholdersExhausted: true,
    };

    const nodes = buildLazyNodes({
      spaceId: "space",
      byParent: new Map([[null, root], ["a", child]]),
      pinnedPageIds: new Set(),
      placeholderName: "Hidden",
      placeholdersExhaustedLabel: "Some pages could not be shown",
    });

    expect(nodes.map((n) => n.id), "the root's own row list carries no exhausted row").toEqual(["page:a"]);
    const kids = nodes[0]!.children ?? [];
    expect(kids.map((n) => n.id), "the budget was spent resolving \"a\"'s branch, so the row sits there").toEqual(["ph:t2", `${PLACEHOLDERS_EXHAUSTED_PREFIX}a`]);
  });
});
