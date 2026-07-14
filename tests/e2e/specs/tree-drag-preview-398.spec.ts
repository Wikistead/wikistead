import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";

// #398: react-arborist's drag preview clones a row into a position:fixed FULL-WIDTH overlay that does NOT
// inherit the Tree's width constraint, so a row's `w-full` stretched the ghost to the viewport (worst on a
// selected row whose action menu is force-expanded). The fix caps each row to the measured sidebar width via
// a --tree-w CSS var. The actual drag GHOST width during an HTML5 drag can't be driven in Playwright (react-dnd
// HTML5 backend), so that stays a human check — here we pin the structural cap: a row's max-width is the
// sidebar width (finite, < viewport), not unbounded.
test("#398: a tree row caps its width to the sidebar (--tree-w), so the drag ghost can't span the viewport", async ({ page }) => {
  await openDemo(page);
  await page.waitForSelector("[data-testid=tree-page]");

  const treeVar = await page.locator("[data-testid=page-tree]").evaluate((el) => getComputedStyle(el).getPropertyValue("--tree-w").trim());
  expect(treeVar, "the measured tree width is exposed as --tree-w").toMatch(/^\d+(\.\d+)?px$/);

  const row = page.locator("[data-testid=tree-page]").first();
  const m = await row.evaluate((el) => ({ maxW: getComputedStyle(el).maxWidth, px: parseFloat(getComputedStyle(el).maxWidth), vw: window.innerWidth }));
  expect(m.maxW, "the row width is capped (was 'none' → a viewport-wide ghost)").not.toBe("none");
  expect(m.px, "the cap is a real pixel width").toBeGreaterThan(0);
  expect(m.px, "the cap is the sidebar width, well under the viewport").toBeLessThan(m.vw);
});
