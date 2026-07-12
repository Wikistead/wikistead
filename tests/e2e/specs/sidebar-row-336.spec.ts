import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

const API = "http://dev.localhost:4010";

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

// #336 A(3): the row menu is hidden (opacity 0, zero-width slide-out) on a non-selected, unhovered row,
// and revealed on hover — so an idle row gives its whole width to the title.
test("#336: the row menu is hidden until hover on a non-selected row", async ({ page }) => {
  await openDemo(page);
  await page.waitForSelector("[data-testid=tree-page]");
  await page.evaluate(async (api) => {
    await fetch(`${api}/spaces/demo_space/pages`, { method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" }, body: JSON.stringify({ title: "Sibling-336" }) });
  }, API);
  await page.reload();
  await page.waitForSelector("[data-testid=tree-page]");

  const other = page.locator("[data-testid=tree-page]:not([data-selected])", { hasText: "Sibling-336" }).first();
  const trigger = other.locator("[data-testid=page-actions]");
  // The transition/opacity lives on the wrapping span (the trigger's parent).
  const opacityOf = () => trigger.evaluate((el) => Number(getComputedStyle(el.parentElement as HTMLElement).opacity));

  expect(await opacityOf(), "hidden by default on an idle non-selected row").toBeLessThan(0.5);
  await other.hover();
  await sleep(250);
  expect(await opacityOf(), "revealed on hover").toBeGreaterThan(0.5);
});
