import { describe, expect, it } from "vitest";
import { buildLazyNodes, type BranchAnswer } from "./lazy-tree";

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

describe("#899 a reloaded deep page does not replace the branch head", () => {
  it("renders a paging gap between the first and reached windows", () => {
    const root: BranchAnswer = {
      pages: [page("a"), page("b")],
      nextCursor: "after-b",
      reachedWindow: {
        pages: [page("deep"), page("z")],
        nextCursor: "after-z",
      },
    };

    const nodes = buildLazyNodes({
      spaceId: "space",
      byParent: new Map([[null, root]]),
      pinnedPageIds: new Set(),
      placeholderName: "Hidden",
    });

    expect(nodes.map((node) => node.id)).toEqual([
      "page:a",
      "page:b",
      "more:root:after-b",
      "page:deep",
      "page:z",
    ]);
  });
});
