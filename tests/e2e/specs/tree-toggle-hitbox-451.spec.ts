import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep, API } from "../helpers";

// #451: the sidebar expand toggle's hit area. The ▶ used to be clickable only on its 14×14 icon;
// now a 24×24 hit box (icon unchanged, negative margins keep the occupied width at ~14px so the
// title indent and childless-row alignment don't move). Real Chromium — happy-dom has no layout.
async function mkPage(page: Page, title: string, parentId?: string): Promise<string> {
  return page.evaluate(async ({ api, title, parentId }) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title, ...(parentId ? { parentId } : {}) }),
    });
    return (await r.json()).id as string;
  }, { api: API, title, parentId });
}

test("#451: the expand toggle has a ≥23px hit box, an edge click toggles, and alignment/row-click hold", async ({ page }) => {
  await openDemo(page);
  const stamp = Date.now();
  const parentId = await mkPage(page, `hitbox-parent-${stamp}`);
  await mkPage(page, `hitbox-child-${stamp}`, parentId);
  const leafId = await mkPage(page, `hitbox-leaf-${stamp}`);
  await page.reload();
  await page.waitForSelector("[data-testid=tree-page]");
  await sleep(600);

  const parentRow = page.locator("[data-testid=tree-page]", { hasText: `hitbox-parent-${stamp}` }).first();
  const leafRow = page.locator("[data-testid=tree-page]", { hasText: `hitbox-leaf-${stamp}` }).first();
  await parentRow.scrollIntoViewIfNeeded();

  // 1. hit box ≥ 23px square (was 14×14)
  const toggle = parentRow.getByTestId("tree-expand-toggle");
  const box = (await toggle.boundingBox())!;
  expect(box.width, "toggle hit width").toBeGreaterThanOrEqual(23);
  expect(box.height, "toggle hit height").toBeGreaterThanOrEqual(23);

  // 2. a click at the box CORNER (outside the old 14px icon) expands the children
  const childRow = page.locator("[data-testid=tree-page]", { hasText: `hitbox-child-${stamp}` });
  await expect(childRow).toHaveCount(0);
  await page.mouse.click(box.x + 2, box.y + 2);
  await expect(childRow.first()).toBeVisible({ timeout: 5000 });
  // ... and collapses again from the opposite corner
  const box2 = (await toggle.boundingBox())!;
  await page.mouse.click(box2.x + box2.width - 2, box2.y + box2.height - 2);
  await expect(childRow).toHaveCount(0, { timeout: 5000 });

  // 3. alignment: a childless root row's title starts at the same x as the parent's (spacer parity)
  const parentTitleX = (await parentRow.locator("[data-testid=tree-page-name]").boundingBox())!.x;
  const leafTitleX = (await leafRow.locator("[data-testid=tree-page-name]").boundingBox())!.x;
  expect(Math.abs(parentTitleX - leafTitleX), "title indent parity").toBeLessThanOrEqual(1);

  // 4. row click (on the title) still OPENS the page — toggle and navigation stay separate
  await leafRow.locator("[data-testid=tree-page-name]").click();
  await expect(page).toHaveURL(new RegExp(`/p/${leafId}`), { timeout: 8000 });
});
