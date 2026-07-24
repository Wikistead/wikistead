import { test, expect } from "@playwright/test";
import { openDemo, sleep, API } from "../helpers";
// #336 A(4): pinning lives in the row menu for an UNPINNED page; once pinned the row shows an
// always-visible ★ (click to unpin, then it disappears) and the menu drops the pin item.
test("#336: pin lives in the row menu; a pinned page shows an always-visible star", async ({ page }) => {
  await openDemo(page);
  await page.waitForSelector("[data-testid=tree-page]");
  const row = page.locator("[data-testid=tree-page][data-selected]").first();

  // Unpinned: NO standalone pin button on the row — pinning is in the menu instead.
  await expect(row.locator("[data-testid=tree-pin-toggle]")).toHaveCount(0);
  await row.locator("[data-testid=page-actions]").click();
  const menu = page.locator("[data-testid=page-menu][data-state=open]");
  await menu.waitFor();
  await expect(menu.getByTestId("tree-pin-menu-item")).toBeVisible();
  await menu.getByTestId("tree-pin-menu-item").click();
  await sleep(700);

  // Pinned: the ★ is now always visible on the row; the menu no longer offers the pin item.
  await expect(row.locator("[data-testid=tree-pin-toggle]")).toBeVisible();
  await row.locator("[data-testid=page-actions]").click();
  const menu2 = page.locator("[data-testid=page-menu][data-state=open]");
  await menu2.waitFor();
  await expect(menu2.getByTestId("tree-pin-menu-item")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Unpin via the ★ → it disappears (state readable from the row).
  await row.locator("[data-testid=tree-pin-toggle]").click();
  await sleep(700);
  await expect(row.locator("[data-testid=tree-pin-toggle]")).toHaveCount(0);
});

// #336 A(3) + #343: the row menu takes ZERO WIDTH (not just opacity 0) on a non-selected, unhovered row, and
// grows to its real width on hover — so an idle row gives its whole width to the title.
test("#343/#336: the row menu is zero-width until hover on a non-selected row", async ({ page }) => {
  await openDemo(page);
  await page.waitForSelector("[data-testid=tree-page]");
  await page.evaluate(async (api) => {
    await fetch(`${api}/spaces/demo_space/pages`, { method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" }, body: JSON.stringify({ title: "Sibling-336" }) });
  }, API);
  await page.reload();
  await page.waitForSelector("[data-testid=tree-page]");

  const other = page.locator("[data-testid=tree-page]:not([data-selected])", { hasText: "Sibling-336" }).first();
  // #343: the width animation lives on the grid wrapper (tree-row-menu), collapsed to 0fr when idle.
  const menuWrap = other.locator("[data-testid=tree-row-menu]");
  const widthOf = () => menuWrap.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);

  expect(await widthOf(), "zero-width by default on an idle non-selected row").toBeLessThan(2);
  await other.hover();
  await sleep(250);
  expect(await widthOf(), "takes its real width on hover").toBeGreaterThan(10);
});

// #343: the trailing icons sit flush at the row's right edge when idle (the menu reserves no width) and glide
// LEFT when the menu slides in on hover. Uses a pinned NON-selected sibling so the always-visible ★ is a
// stable probe AND the row can go fully idle (a selected row keeps its menu revealed).
test("#343: the pinned ★ is flush-right when idle and moves left when the menu reveals on hover", async ({ page }) => {
  await openDemo(page);
  await page.waitForSelector("[data-testid=tree-page]");
  await page.evaluate(async (api) => {
    await fetch(`${api}/spaces/demo_space/pages`, { method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" }, body: JSON.stringify({ title: "Flush-343" }) });
  }, API);
  await page.reload();
  await page.waitForSelector("[data-testid=tree-page]");
  const sib = page.locator("[data-testid=tree-page]:not([data-selected])", { hasText: "Flush-343" }).first();

  // Pin it (hover → menu → Pin) so the ★ is always rendered on the row.
  await sib.hover();
  await sib.locator("[data-testid=page-actions]").click();
  await page.locator("[data-testid=page-menu][data-state=open]").waitFor();
  await page.getByTestId("tree-pin-menu-item").click();
  await sleep(700);
  await page.mouse.move(2, 2); // leave the row → idle
  await page.keyboard.press("Escape");
  await sleep(250);

  const sibStar = sib.locator("[data-testid=tree-pin-toggle]");
  await expect(sibStar).toBeVisible();
  const starRight = () => sibStar.evaluate((el) => (el as HTMLElement).getBoundingClientRect().right);
  const rowRight = await sib.evaluate((el) => (el as HTMLElement).getBoundingClientRect().right);

  const idleStarRight = await starRight();
  // Idle: the ★ sits near the row's right edge (within the pr-2 padding ≈ 8px) — no reserved menu slot.
  expect(rowRight - idleStarRight, "★ flush at the right edge when the menu is collapsed").toBeLessThan(20);

  await sib.hover();
  await sleep(250);
  const hoverStarRight = await starRight();
  // Hover: the menu takes its width and pushes the ★ LEFT (smaller right-x).
  expect(hoverStarRight, "★ glides left as the menu slides in").toBeLessThan(idleStarRight - 4);
});
