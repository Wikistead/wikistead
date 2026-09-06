import { describe, expect, it } from "vitest";
import { buildLazyNodes, PLACEHOLDERS_MORE_PREFIX, type BranchAnswer } from "./lazy-tree";

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

// #1079 (#1077 review) first pinned that an exhausted placeholder budget must be a visible row, not a
// silently short list — a server-reported "some pages could not be placed here" (ADR-220 §4.3) that
// reached the client and had nothing reading it. #1141 (ADR-220 §4.2 rev13) supersedes the SHAPE of
// that row: what was a dead-end "some pages could not be shown" label is now a RESUMABLE `ph-more:`
// row (the same contract `MORE_PREFIX` already has) carrying the continuation cursor the server sent,
// so the underlying #1079 guarantee (the budget running out is a visible state, never a silent short
// list) still holds — this file exercises the new shape instead of the retired one.
describe("#1141: a placeholder walk that has more to explore is a visible, resumable row", () => {
  it("renders a row for a branch whose placeholder walk is not finished, carrying the cursor in its id", () => {
    const root: BranchAnswer = {
      pages: [page("a")],
      nextCursor: null,
      placeholders: [{ token: "t1", under: null, parentToken: null, pages: [page("b")] }],
      placeholderCursor: "cursor-xyz",
    };

    const nodes = buildLazyNodes({
      spaceId: "space",
      byParent: new Map([[null, root]]),
      pinnedPageIds: new Set(),
      placeholderName: "Hidden",
      pagingDoneLabel: "No more pages",
    });

    expect(nodes.map((n) => n.id)).toEqual(["page:a", "ph:t1", `${PLACEHOLDERS_MORE_PREFIX}root:cursor-xyz`]);
    const row = nodes.find((n) => n.id.startsWith(PLACEHOLDERS_MORE_PREFIX));
    // Same contract as MORE_PREFIX: no label of its own (invisible until scrolled to — the sidebar
    // grows quietly, per the ruling's "the reader sees nothing but the tree getting bigger").
    expect(row?.name, "no static label — this is a loader row, not a message").toBe("");
    expect(row?.children, "not usable like a page or a placeholder — nothing to expand into").toEqual([]);
  });

  it("draws no row when nothing remains unexplored (cursor absent)", () => {
    const root: BranchAnswer = {
      pages: [page("a")],
      nextCursor: null,
      placeholders: [{ token: "t1", under: null, parentToken: null, pages: [page("b")] }],
    };

    const nodes = buildLazyNodes({
      spaceId: "space",
      byParent: new Map([[null, root]]),
      pinnedPageIds: new Set(),
      placeholderName: "Hidden",
      pagingDoneLabel: "No more pages",
    });

    expect(nodes.some((n) => n.id.startsWith(PLACEHOLDERS_MORE_PREFIX)), "an absent cursor must not draw the row either").toBe(false);
  });

  it("is per branch: the child's continuation row nests under the child, not the root", () => {
    const root: BranchAnswer = { pages: [{ ...page("a"), hasChildren: true }], nextCursor: null };
    const child: BranchAnswer = {
      pages: [],
      nextCursor: null,
      placeholders: [{ token: "t2", under: "a", parentToken: null, pages: [page("c")] }],
      placeholderCursor: "cursor-child",
    };

    const nodes = buildLazyNodes({
      spaceId: "space",
      byParent: new Map([[null, root], ["a", child]]),
      pinnedPageIds: new Set(),
      placeholderName: "Hidden",
      pagingDoneLabel: "No more pages",
    });

    expect(nodes.map((n) => n.id), "the root's own row list carries no continuation row").toEqual(["page:a"]);
    const kids = nodes[0]!.children ?? [];
    expect(kids.map((n) => n.id), "the walk was resolving \"a\"'s branch, so the row sits there").toEqual(["ph:t2", `${PLACEHOLDERS_MORE_PREFIX}a:cursor-child`]);
  });

  it("a new cursor value makes a new row id, matching MORE_PREFIX's own fix", () => {
    // (MORE_PREFIX's own regression): a FIXED row id survives react-arborist's append and its
    // mount-once guard stays spent, so a later page never re-triggers the loader. Baking the cursor
    // into the id is what makes each new cursor a fresh row — this is the same mechanism, so it needs
    // the same pin.
    const first: BranchAnswer = { pages: [], nextCursor: null, placeholderCursor: "cursor-1" };
    const second: BranchAnswer = { pages: [], nextCursor: null, placeholderCursor: "cursor-2" };
    const idFor = (b: BranchAnswer) => buildLazyNodes({
      spaceId: "space", byParent: new Map([[null, b]]), pinnedPageIds: new Set(), placeholderName: "Hidden", pagingDoneLabel: "No more pages",
    }).find((n) => n.id.startsWith(PLACEHOLDERS_MORE_PREFIX))!.id;
    expect(idFor(first)).not.toBe(idFor(second));
  });
});
