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

// #368 (redesign): the slide-out was scrapped — hovering to reach Edit tripped the reveal and the
// expanding cluster shoved the always-present Edit button around. View mode is now a FIXED [Edit][⋯]; Watch +
// Share moved INTO the ⋯ overflow menu. Real Chromium — assert the standalone buttons are gone, Edit's x is
// stable on hover, and Watch/Share are reachable from the menu.
test("#368: view actions are a fixed [Edit][⋯] with Watch + Share in the ⋯ menu", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "collapse-controls");
  await expect(page.getByTestId("edit-toggle")).toBeVisible(); // Edit is always shown
  // No standalone slide-out Watch/Share round buttons anymore (the wrapper + the view-mode Share button are gone).
  await expect(page.getByTestId("page-actions-secondary")).toHaveCount(0);
  await expect(page.getByTestId("share-open")).toHaveCount(0);

  // Edit's x position is stable — nothing expands the cluster on hover (the old slide pushed Edit leftward).
  const editX = async () => (await page.getByTestId("edit-toggle").boundingBox())!.x;
  const before = await editX();
  await page.getByTestId("edit-toggle").hover();
  await page.waitForTimeout(300);
  expect(Math.abs((await editX()) - before)).toBeLessThan(1);

  // Watch + Share are reachable from the ⋯ overflow menu (member view surface has a real pageId → watch shows).
  await page.getByTestId("page-overflow-trigger").click();
  await expect(page.getByTestId("watch-toggle")).toBeVisible();
  await expect(page.getByTestId("share-page")).toBeVisible();
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
