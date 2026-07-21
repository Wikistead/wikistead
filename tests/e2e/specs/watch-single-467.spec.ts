import { test, expect } from "@playwright/test";
import { openScratch, sleep } from "../helpers";

// #467: the page ⋯ menu offers exactly ONE watch control — "watch this page", flipping to "unwatch"
// once you do. The subtree and space scope items are gone (three toggles for one concept read as
// clutter). UI only: the server still speaks every scope, so nobody's existing subtree/space watch
// is stranded (that half is pinned in watch-ui-362).
test("#467: exactly one watch item in the ⋯ menu, and it toggles + persists", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const title = `watch467-${Date.now()}`;
  await openScratch(page, title);

  await page.getByTestId("page-overflow-trigger").click();
  const toggle = page.getByTestId("watch-toggle");
  await expect(toggle).toBeVisible();
  // the retired scope items are ABSENT from the DOM (not merely hidden)
  await expect(page.getByTestId("watch-subtree-toggle")).toHaveCount(0);
  await expect(page.getByTestId("watch-space-toggle")).toHaveCount(0);

  // label reads "watch this page" while not watching
  const before = (await toggle.textContent())!;
  expect(before).toMatch(/Watch this page|このページをウォッチ/);
  await toggle.click();
  await sleep(500);

  // reopened: the same single item now reads "unwatch" — state took, and survives a reload
  await page.getByTestId("page-overflow-trigger").click();
  await expect(page.getByTestId("watch-toggle")).toContainText(/Unwatch|ウォッチを解除/, { timeout: 5000 });
  await expect(page.getByTestId("watch-subtree-toggle")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.reload();
  await page.waitForSelector("[data-testid=page-overflow-trigger]");
  await page.getByTestId("page-overflow-trigger").click();
  await expect(page.getByTestId("watch-toggle"), "watching survives a reload").toContainText(/Unwatch|ウォッチを解除/, { timeout: 8000 });

  // cleanup: unwatch so the shared dev tenant stays tidy
  await page.getByTestId("watch-toggle").click();
  await sleep(400);
});
