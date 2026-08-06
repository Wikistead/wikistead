import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #623 slice 8: every row of the page tree can be reached.
//
// The rail is a fixed region of the shell and its ancestors are `overflow-hidden`, so a tree taller than
// the window is simply CUT — there is nothing to scroll. Measured on the demo space's real pages, whose
// last row already sits below the fold: bottom 755 against a 720px window, inside a 680px hidden box.
//
// What is asserted is REACHABILITY, not the presence of a scrollbar. A previous attempt counted rows and
// could not be turned red — flattening the tree left it green — and the reason turned out to matter:
// react-arborist VIRTUALISES, so the row count is a window and never grows with the space. That is also
// why the fixture is stubbed here: the demo space has one page, and a rail with one row strands nothing.
//
// A virtualised list still needs somewhere to scroll. Without it the window it renders simply runs off
// the bottom of a clipped box, which is what this measures: a row the reader cannot get to.
const PAGES = Array.from({ length: 300 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  title: `Tree page ${i}`, parentId: null, position: i,
  spaceId: "demo_space", tenantId: "tenant_dev", private: false, frozen: null, published: true,
}));

test("#623: no row of the page tree is stranded below the fold", async ({ page }) => {
  test.setTimeout(180_000);
  await page.route(/\/spaces\/[^/]+\/pages(\?|$)/, (r) =>
    r.request().method() === "GET" ? r.fulfill({ json: PAGES }) : r.fallback());
  await openDemo(page);
  await sleep(1500);

  const m = await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="tree-page"]')];
    if (rows.length === 0) return null;
    const tree = document.querySelector<HTMLElement>('[data-testid="page-tree"]')!;
    // the nearest ancestor that can actually scroll, tree included
    let scroller: HTMLElement | null = tree;
    while (scroller) {
      const oy = getComputedStyle(scroller).overflowY;
      if ((oy === "auto" || oy === "scroll") && scroller.scrollHeight > scroller.clientHeight + 1) break;
      if (oy === "auto" || oy === "scroll") break;
      scroller = scroller.parentElement;
    }
    const last = rows[rows.length - 1]!;
    return {
      rows: rows.length,
      lastBottom: Math.round(last.getBoundingClientRect().bottom),
      viewport: window.innerHeight,
      // how far past its container the content runs, and whether that container can be scrolled
      overflowBy: tree.scrollHeight - tree.clientHeight,
      scroller: scroller ? `${scroller.tagName}.${scroller.className.toString().slice(0, 30)}` : null,
    };
  });

  expect(m, "the tree drew rows (else this measures an empty rail)").not.toBeNull();
  expect(m!.rows, "…and more than one").toBeGreaterThan(1);
  // Either the last row is on screen, or something between it and the document can be scrolled to it.
  // Both are fine; neither is the defect.
  const reachable = m!.lastBottom <= m!.viewport || m!.scroller !== null;
  expect(reachable,
    `the last of ${m!.rows} rows ends at ${m!.lastBottom}px in a ${m!.viewport}px window, and nothing between it and the document scrolls (overflowing by ${m!.overflowBy}px)`)
    .toBe(true);
});
