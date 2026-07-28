import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep, API } from "../helpers";

// #511the bulk-select checkbox was a bare 13×13px input — the only clickable spot was the box
// itself, a third of the #406 tap-target floor. The ruling: grow the hit area AROUND the checkbox only;
// the title cell keeps navigating. The label wraps just the input with padding pulled back by negative
// margins, so nothing moves and nothing else is eaten.
const H = { Authorization: "Bearer dev-token" };

async function seedSpaceWithPages(page: Page, titles: string[]): Promise<string> {
  return page.evaluate(async ({ api, headers, titles }) => {
    const s = await (await fetch(`${api}/spaces`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: `hit-e2e-${Date.now()}` }) })).json();
    for (const title of titles) {
      await fetch(`${api}/spaces/${s.id}/pages`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ title }) });
    }
    return s.id as string;
  }, { api: API, headers: H, titles });
}

test("#511the row checkbox is hittable around itself, and the title still navigates", async ({ page }) => {
  await openDemo(page);
  const spaceId = await seedSpaceWithPages(page, ["Hit A", "Hit B"]);
  await page.goto(`/spaces/${spaceId}/settings/pages`);
  await page.waitForSelector("[data-testid=space-page-row]", { timeout: 10000 });
  await sleep(300);

  // 1. The hit target is at least 32px in both axes (was 13×13 — red before the fix).
  const hit = page.getByTestId("bulk-select-row-hit").first();
  const box = (await hit.boundingBox())!;
  expect(box.width, "hit area width").toBeGreaterThanOrEqual(32);
  expect(box.height, "hit area height").toBeGreaterThanOrEqual(32);

  // 2. Clicking NEAR the checkbox (its padded ring, outside the 13px box) toggles the selection.
  const input = page.getByTestId("bulk-select-row").first();
  await expect(input).not.toBeChecked();
  await page.mouse.click(box.x + 2, box.y + 2); // top-left corner of the ring — well off the input box
  await sleep(200);
  await expect(input, "a ring click toggles").toBeChecked();

  // 3. The select-all header checkbox got the same treatment.
  const allBox = (await page.getByTestId("bulk-select-all-hit").boundingBox())!;
  expect(allBox.width).toBeGreaterThanOrEqual(32);
  expect(allBox.height).toBeGreaterThanOrEqual(32);

  // 4. The title cell is NOT eaten: clicking the title still navigates to the page.
  await page.getByTestId("space-page-row").filter({ hasText: "Hit B" }).getByText("Hit B").click();
  await sleep(800);
  await expect(page, "the title click still navigates").toHaveURL(/\/p\//);
});
