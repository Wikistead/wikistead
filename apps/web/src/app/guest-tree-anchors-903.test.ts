// #903 / ADR-220 §14 (owner ruling 2026-09-05): the guest tree does not flatten.
//
// THE DEFECT THIS HOLDS DOWN: the 2026-09-01 shipping form returned a page whose parent the guest
// cannot view as a FLAT row with `parentId: null`, and this component's re-rooting rule then drew it as
// a top-level row among the space's real roots — sorted by an ordinal belonging to a parent nobody can
// see. Measured on a real share link before the change: a published page inside a draft folder appeared
// between two unrelated roots. The server now sends the member mechanism's anchors beside `pages`, and
// this builder has to PLACE them; a builder that ignored the field would be green on every other pin
// here (the pages are all still present) while drawing exactly the old flattened tree.
//
// ⚠️ What this measures: the tree STRUCTURE the component renders from. There is no real-DOM renderer
// in this package (`@testing-library/react` is not a dependency — adding one is a licence gate), so the
// rendered rows themselves are measured in real Chromium at review time, not here.
import { describe, it, expect } from "vitest";
import { buildTree, type TreeNode, type GuestPlaceholder } from "./GuestSidebar";
import type { Page } from "../data/queries";

const page = (id: string, parentId: string | null, position = 0): Page =>
  ({ id, spaceId: "s", parentId, title: id, position }) as Page;

/** The row titles of one level, in draw order. Anchors report as "(anchor)". */
const level = (nodes: TreeNode[]) => nodes.map((n) => (n.placeholder ? "(anchor)" : n.title));
const find = (nodes: TreeNode[], title: string): TreeNode | undefined => {
  for (const n of nodes) {
    if (!n.placeholder && n.title === title) return n;
    const deep = find(n.children, title);
    if (deep) return deep;
  }
  return undefined;
};

describe("#903 §14: a page behind an invisible parent keeps its depth", () => {
  it("a surfaced page hangs under its anchor, NOT among the real roots", () => {
    const surfaced = { ...page("surfaced", null, 0), title: "surfaced" };
    const anchor: GuestPlaceholder = { token: "t1", under: null, parentToken: null, pages: [surfaced] };
    const tree = buildTree([page("rootA", null, 0), page("rootB", null, 1)], [anchor]);

    expect(level(tree), "the anchor draws last on its level, like the member tree").toEqual(["rootA", "rootB", "(anchor)"]);
    expect(level(tree[2]!.children)).toEqual(["surfaced"]);
    // The whole point: it is NOT also a top-level row. Drawing it twice was the shape this replaced.
    expect(tree.filter((n) => !n.placeholder).map((n) => n.title)).not.toContain("surfaced");
  });

  it("the surfaced page keeps its own children, which need no anchor of their own", () => {
    const surfaced = page("surfaced", null);
    const anchor: GuestPlaceholder = { token: "t1", under: null, parentToken: null, pages: [surfaced] };
    // its child carries the REAL parent id (the surfaced page is visible), so it arrives as an
    // ordinary row — and must nest under it rather than being re-rooted for want of a present parent.
    const tree = buildTree([page("child", "surfaced")], [anchor]);
    expect(level(tree)).toEqual(["(anchor)"]);
    expect(level(find(tree, "surfaced")!.children)).toEqual(["child"]);
  });

  it("an anchor under a visible page hangs under THAT page", () => {
    const anchor: GuestPlaceholder = { token: "t1", under: "rootA", parentToken: null, pages: [page("deep", null)] };
    const tree = buildTree([page("rootA", null, 0), page("rootB", null, 1)], [anchor]);
    expect(level(tree)).toEqual(["rootA", "rootB"]);
    expect(level(tree[0]!.children)).toEqual(["(anchor)"]);
    expect(level(tree[0]!.children[0]!.children)).toEqual(["deep"]);
  });

  it("two invisible layers draw as an anchor inside an anchor", () => {
    const outer: GuestPlaceholder = { token: "t1", under: null, parentToken: null, pages: [] };
    const inner: GuestPlaceholder = { token: "t2", under: null, parentToken: "t1", pages: [page("deep", null)] };
    const tree = buildTree([], [outer, inner]);
    expect(level(tree)).toEqual(["(anchor)"]);
    expect(level(tree[0]!.children)).toEqual(["(anchor)"]);
    expect(level(tree[0]!.children[0]!.children)).toEqual(["deep"]);
  });

  it("the #245 re-rooting floor still catches a page nothing anchored", () => {
    // A row whose parent is simply absent from the set (no anchor sent for it) must still be drawn —
    // "a permitted page is never orphaned out of the tree" is older than the anchors and survives them.
    const tree = buildTree([page("orphan", "someone-invisible")], []);
    expect(level(tree)).toEqual(["orphan"]);
  });

  it("siblings keep position order, and anchors follow the pages of their level", () => {
    const anchor: GuestPlaceholder = { token: "t1", under: null, parentToken: null, pages: [page("surfaced", null)] };
    const tree = buildTree([page("second", null, 5), page("first", null, 1)], [anchor]);
    expect(level(tree)).toEqual(["first", "second", "(anchor)"]);
  });
});
