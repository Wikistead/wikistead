import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildLazyNodes, mergeLoadMoreAppend, PAINT_LIMIT, type BranchAnswer } from "./lazy-tree";

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
  buildLazyNodes({ spaceId: "space", byParent, pinnedPageIds: new Set(), placeholderName: "Hidden" });

// #1149 (ruling): the terminal "no more pages" row is retired — a branch whose cursor ran out
// draws exactly its own pages, whatever it took to get there (one fetch or several). Sweeping the same
// scenarios the retired PAGING_DONE_PREFIX row used to distinguish (fits in one window / exceeds
// PAINT_LIMIT in one fetch / genuinely paged via loadMore) because all three must now look identical:
// no extra row, regardless of how the branch got to `nextCursor: null`.
describe("#1149: a branch with an exhausted cursor never grows an extra row", () => {
  it("a branch that fits in its first window draws only its real pages", () => {
    const root: BranchAnswer = { pages: pages(PAINT_LIMIT - 1), nextCursor: null };
    expect(build(new Map([[null, root]]))).toHaveLength(PAINT_LIMIT - 1);
  });

  it("a single fetch that exceeds PAINT_LIMIT (server default BRANCH_PAGE_LIMIT) draws only its real pages", () => {
    const root: BranchAnswer = { pages: pages(PAINT_LIMIT + 30), nextCursor: null };
    expect(build(new Map([[null, root]]))).toHaveLength(PAINT_LIMIT + 30);
  });

  it("a genuine multi-fetch loadMore continuation that exhausts the cursor draws only its real pages", () => {
    const have: BranchAnswer = { pages: pages(PAINT_LIMIT), nextCursor: "c2" };
    const fresh: BranchAnswer = { pages: pages(10), nextCursor: null };
    const merged = mergeLoadMoreAppend(have, fresh);

    expect(merged.pages).toHaveLength(PAINT_LIMIT + 10);
    expect(build(new Map([[null, merged]]))).toHaveLength(PAINT_LIMIT + 10);
  });

  it("nests the same way for a child branch: no extra row under the child either", () => {
    const root: BranchAnswer = { pages: [{ ...page("a"), hasChildren: true }], nextCursor: null };
    const child: BranchAnswer = { pages: pages(PAINT_LIMIT + 1), nextCursor: null };

    const nodes = build(new Map([[null, root], ["a", child]]));

    expect(nodes.map((n) => n.id)).toEqual(["page:a"]);
    expect(nodes[0]!.children).toHaveLength(PAINT_LIMIT + 1);
  });

  it("still draws the more row while a cursor remains — only the terminal state changed", () => {
    const root: BranchAnswer = { pages: pages(PAINT_LIMIT + 1), nextCursor: "c2" };
    const nodes = build(new Map([[null, root]]));
    expect(nodes).toHaveLength(PAINT_LIMIT + 2); // pages + the more: row
    expect(nodes.at(-1)?.id).toBe("more:root:c2");
  });
});

// #1149 (ruling): the loading state a scrolling reader sees while a `more:`/`ph-more:` row
// fetches must be a bare skeleton, never a text label distinguishing it from any other loading state.
// Source-read (PageTree.tsx is a react-arborist row renderer with heavy runtime deps — not practical
// to render standalone; same fallback #1105/#1130 used).
describe("#1149: MoreRow's loading state renders no text", () => {
  const SRC = readFileSync(resolve(import.meta.dirname, "PageTree.tsx"), "utf8");

  it("the loading branch of MoreRow calls t() for aria-label only, never for visible text", () => {
    const start = SRC.indexOf("function MoreRow(");
    const loadingStart = SRC.indexOf("{loading ? (", start);
    const loadingEnd = SRC.indexOf(") : (", loadingStart);
    expect(loadingStart).toBeGreaterThan(start);
    expect(loadingEnd).toBeGreaterThan(loadingStart);
    const loadingBranch = SRC.slice(loadingStart, loadingEnd);

    // aria-label={t("common.loading")} is the only permitted t() call — nothing renders as visible text.
    const tCalls = loadingBranch.match(/t\("[^"]+"\)/g) ?? [];
    expect(tCalls).toEqual(['t("common.loading")']);
  });
});
