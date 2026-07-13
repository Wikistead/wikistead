import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit } from "../helpers";

// The old full-width top bar is gone; its controls float in role-based groups (status by
// the title, actions bottom-right, vim bottom-left). Behaviour is unchanged (covered by
// the other specs) — here we assert the relocation + the title wrap/clamp.
const lineClamp = (p: Page) =>
  p.getByTestId("page-title").evaluate((el) => getComputedStyle(el).webkitLineClamp);

test("floating controls + title clamp (view) / full (edit)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "a very long page title that should wrap to two lines and then ellipsise rather than overflow forever");

  // VIEW: status group (with the draft badge) sits by the title; edit action floats.
  await expect(page.getByTestId("page-status")).toBeVisible();
  await expect(page.getByTestId("draft-badge")).toBeVisible();
  await expect(page.getByTestId("edit-toggle")).toBeVisible();
  expect(await lineClamp(page)).toBe("2"); // long title clamps to 2 lines in view

  // EDIT: vim floats bottom-left; publish/done float bottom-right.
  await enterEdit(page);
  await expect(page.getByTestId("vim-toggle")).toBeVisible();
  await expect(page.getByTestId("publish-page")).toBeVisible();
  await expect(page.getByTestId("view-toggle")).toBeVisible();
  // #312 (ea12965): the static title clamps to 2 lines on EVERY surface — view AND page-edit mode (only the
  // rename TEXTAREA grows). This assertion previously expected "none" (the old pageEditing→block branch) and
  // had been stale-red since #312 landed.
  expect(await lineClamp(page)).toBe("2");
});

// #368: in view mode the Watch + Share buttons take NO width when idle and slide out (grid 0fr→1fr) on hover of
// the bottom-right cluster; Edit stays always-visible. Real Chromium — a width geometry assert.
test("#368: Watch/Share collapse to zero width and slide out on cluster hover", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "collapse-controls");
  await expect(page.getByTestId("edit-toggle")).toBeVisible(); // Edit is always shown
  const secondary = page.getByTestId("page-actions-secondary");
  await expect(secondary).toBeAttached(); // the collapsible Watch/Share wrapper exists in view mode

  const width = async () => (await secondary.boundingBox())?.width ?? -1;
  const idle = await width();
  expect(idle).toBeLessThan(6); // grid-cols-[0fr] → ~zero width when idle (no reserved space)

  // Hover the always-visible Edit button (inside the same cluster group) → the secondary slides open.
  await page.getByTestId("edit-toggle").hover();
  await expect.poll(width, { timeout: 3000, intervals: [150, 250, 400] }).toBeGreaterThan(28); // Watch + Share now take width
  await expect(page.getByTestId("share-open")).toBeVisible();
});

test("narrow viewport collapses the groups into one bottom-right ⋯", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 600, height: 800 } })).newPage();
  await openScratch(page, "narrow");
  // the three floating groups collapse to a single ⋯; the spread edit/vim buttons are gone
  await expect(page.getByTestId("page-controls-mobile")).toBeVisible();
  await expect(page.getByTestId("edit-toggle")).toHaveCount(0);
  await expect(page.getByTestId("vim-toggle")).toHaveCount(0);
  // opening it reveals the labelled actions
  await page.getByTestId("page-controls-mobile").click();
  await expect(page.getByTestId("m-edit-toggle")).toBeVisible();
});
