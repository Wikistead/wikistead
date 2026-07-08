import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

const API = "http://dev.localhost:4010";

// #263: the space switcher shows a BOUNDED default set and an incremental SEARCH over all viewable spaces
// (cmdk). Real Chromium: create uniquely-named spaces, open the switcher, type a query → the list filters;
// pick a match → it becomes the active space.
test("#263: the switcher searches spaces and selects a match", async ({ page }) => {
  await openDemo(page);
  const tag = Date.now().toString(36);
  const mk = (name: string) =>
    page.evaluate(async ({ api, name }) => {
      const r = await fetch(`${api}/spaces`, {
        method: "POST",
        headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      return ((await r.json()) as { id: string }).id;
    }, { api: API, name });
  await mk(`Zephyr-${tag}`);
  await mk(`Quokka-${tag}`);
  await page.reload();
  await page.waitForSelector("[data-testid=space-switcher]");
  await sleep(400);

  // open the switcher → the search input + a bounded option list appear
  await page.click("[data-testid=space-switcher]");
  await expect(page.getByTestId("space-menu")).toBeVisible();
  await expect(page.getByTestId("space-search")).toBeVisible();

  // search "quokka" → the list narrows to the matching space
  await page.getByTestId("space-search").fill("quokka");
  await sleep(200);
  const options = page.locator("[data-testid=space-menu] [data-testid=space-option]");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText(`Quokka-${tag}`);
  // a non-matching space is absent
  await expect(page.locator("[data-testid=space-menu]", { hasText: `Zephyr-${tag}` })).toHaveCount(0);

  // pick it → it becomes the active space (shown on the trigger)
  await options.first().click();
  await sleep(400);
  await expect(page.getByTestId("space-switcher")).toContainText(`Quokka-${tag}`);
});

const mkSpace = (page: import("@playwright/test").Page, name: string) =>
  page.evaluate(async ({ api, name }) => {
    const r = await fetch(`${api}/spaces`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return ((await r.json()) as { id: string }).id;
  }, { api: API, name });

// #263 rejection ②: opening the switcher must NOT shift the header row. On a narrow sidebar the menu's
// autoFocus used to scroll the overflow-hidden sidebar root horizontally, dragging the whole trigger left.
// Real Chromium at a pinned narrow width — a geometry regression happy-dom can't measure.
test("#263: opening the switcher does not shift the trigger (narrow sidebar)", async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => localStorage.setItem("wks.sidebarW", "180px"));
  await page.reload();
  await page.waitForSelector("[data-testid=space-switcher]");
  await sleep(400);

  const trigger = page.getByTestId("space-switcher");
  const before = (await trigger.boundingBox())!;
  await trigger.click();
  await expect(page.getByTestId("space-menu")).toBeVisible();
  await sleep(250); // let any (unwanted) scroll-into-view settle
  const after = (await trigger.boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(2); // no horizontal shift

  // the menu itself stays within the sidebar width (not clipped off to the right)
  const menu = (await page.getByTestId("space-menu").boundingBox())!;
  const sidebar = (await page.getByTestId("sidebar").boundingBox())!;
  expect(menu.x + menu.width).toBeLessThanOrEqual(sidebar.x + sidebar.width + 1);
});

// #263 rejection ①: when the bounded default list hides spaces, the switcher shows a "N more — search"
// hint instead of truncating silently; the hint disappears once a query spans all spaces.
test("#263: a truncation hint appears when spaces exceed the default cap, and hides on search", async ({ page }) => {
  await openDemo(page);
  const tag = Date.now().toString(36);
  for (let i = 0; i < 10; i++) await mkSpace(page, `Cap-${tag}-${i}`); // push the total well past the cap of 8
  await page.reload();
  await page.waitForSelector("[data-testid=space-switcher]");
  await sleep(400);

  await page.click("[data-testid=space-switcher]");
  await expect(page.getByTestId("space-menu")).toBeVisible();
  // empty query → capped list + a "more" hint
  await expect(page.locator("[data-testid=space-menu] [data-testid=space-option]")).toHaveCount(8);
  await expect(page.getByTestId("space-more-hint")).toBeVisible();

  // searching spans ALL spaces → nothing is hidden → the hint is gone
  await page.getByTestId("space-search").fill(`Cap-${tag}-3`);
  await sleep(200);
  await expect(page.getByTestId("space-more-hint")).toHaveCount(0);
});
