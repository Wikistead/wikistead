import { test, expect, type Page } from "@playwright/test";
import { openScratch, sleep } from "../helpers";

// #489 boot slice: opening a page must not fetch the watch state — it feeds only the ⋯ menu's Watch
// row, which nobody sees until the menu opens. The state loads on menu open (the row is disabled for
// the instant it takes), and the toggle still works end-to-end.

const recordWatchGets = (page: Page, log: string[]) =>
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.endsWith("/watches") && r.method() === "GET") log.push(u.search);
  });

test("#489: the watch state loads when the menu opens, not at page open", async ({ page }) => {
  const calls: string[] = [];
  recordWatchGets(page, calls);
  await openScratch(page, `boot489-${Date.now()}`);
  await sleep(1500); // let boot settle
  expect(calls, "no watch fetch rides the page open").toHaveLength(0);

  // the ⋯ menu opens → the state fetch happens now, and the row becomes usable
  await page.getByTestId("page-overflow-trigger").click();
  const toggle = page.getByTestId("watch-toggle");
  await expect(toggle).toBeVisible({ timeout: 8000 });
  await expect(toggle).toBeEnabled({ timeout: 8000 });
  expect(calls.length, "the menu open fetched the state").toBeGreaterThanOrEqual(1);

  // and the toggle still round-trips (watch → verify → unwatch, leaving the world as found)
  await toggle.click();
  await sleep(600);
  await page.getByTestId("page-overflow-trigger").click();
  await expect(toggle, "the toggle landed").toContainText(/Unwatch|ウォッチを解除/, { timeout: 8000 });
  await toggle.click();
  await sleep(600);
});
