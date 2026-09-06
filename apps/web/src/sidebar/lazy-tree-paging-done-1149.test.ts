import { describe, expect, it } from "vitest";
import { buildLazyNodes, MORE_PREFIX, PAGING_DONE_PREFIX, PAINT_LIMIT, type BranchAnswer } from "./lazy-tree";

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

const pages = (n: number) => Array.from({ length: n }, (_, i) => page(`p${i}`));

const build = (byParent: ReadonlyMap<string | null, BranchAnswer>) =>
  buildLazyNodes({
    spaceId: "space",
    byParent,
    pinnedPageIds: new Set(),
    placeholderName: "Hidden",
    pagingDoneLabel: "No more pages",
  });

// #1149: the `more:` row (§1) just disappears for good once a branch's cursor runs out — the last thing
// a scrolling reader saw was its loading skeleton, then nothing. Indistinguishable from "stuck loading
// forever" (the bug report this ticket exists to fix). A terminal row says so once, for a branch that
// actually paged past its first window; a branch that fit in one fetch never showed that ambiguity and
// gets no row at all (never draw a new "the end" line where none existed before).
describe("#1149: a branch that paged past its first window ends with a visible row, not silence", () => {
  it("renders a terminal row for a branch whose cursor ran out after paging", () => {
    const root: BranchAnswer = { pages: pages(PAINT_LIMIT + 1), nextCursor: null };

    const nodes = build(new Map([[null, root]]));

    expect(nodes.at(-1)?.id).toBe(`${PAGING_DONE_PREFIX}root`);
    expect(nodes.at(-1)?.name, "the label is what the caller passed, not invented here").toBe("No more pages");
    expect(nodes.at(-1)?.children, "not usable like a page — nothing to expand into").toEqual([]);
    expect(nodes.some((n) => n.id.startsWith(MORE_PREFIX)), "the more row and the done row are mutually exclusive").toBe(false);
  });

  it("draws no row for a branch that fit entirely in its first window", () => {
    const root: BranchAnswer = { pages: pages(PAINT_LIMIT - 1), nextCursor: null };

    const nodes = build(new Map([[null, root]]));

    expect(nodes.some((n) => n.id.startsWith(PAGING_DONE_PREFIX)), "no ambiguous loading was ever shown for this branch").toBe(false);
  });

  it("draws the more row, not the done row, while a cursor remains", () => {
    const root: BranchAnswer = { pages: pages(PAINT_LIMIT + 1), nextCursor: "c2" };

    const nodes = build(new Map([[null, root]]));

    expect(nodes.some((n) => n.id.startsWith(PAGING_DONE_PREFIX))).toBe(false);
    expect(nodes.some((n) => n.id.startsWith(MORE_PREFIX))).toBe(true);
  });

  it("is per branch: the child's done row nests under the child, not the root", () => {
    const root: BranchAnswer = { pages: [{ ...page("a"), hasChildren: true }], nextCursor: null };
    const child: BranchAnswer = { pages: pages(PAINT_LIMIT + 1), nextCursor: null };

    const nodes = build(new Map([[null, root], ["a", child]]));

    expect(nodes.map((n) => n.id), "the root's own row list carries no done row").toEqual(["page:a"]);
    const kids = nodes[0]!.children ?? [];
    expect(kids.at(-1)?.id, "the paging happened resolving \"a\"'s branch, so the row sits there").toBe(`${PAGING_DONE_PREFIX}a`);
  });
});
