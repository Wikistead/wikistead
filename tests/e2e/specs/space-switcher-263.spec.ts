import { test, expect } from "@playwright/test";
import { openDemo, sleep, API } from "../helpers";
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
  // empty query → capped list + the "show all" entry point (#287)
  await expect(page.locator("[data-testid=space-menu] [data-testid=space-option]")).toHaveCount(8);
  await expect(page.getByTestId("space-show-all")).toBeVisible();

  // searching spans ALL spaces → nothing is hidden → the entry point is gone
  await page.getByTestId("space-search").fill(`Cap-${tag}-3`);
  await sleep(200);
  await expect(page.getByTestId("space-show-all")).toHaveCount(0);
});

// #287: "show all" expands the capped default into the FULL name-sorted list, so a space that wasn't in the
// bounded default (current + recents) can be found by browsing. Real Chromium.
test("#287: 'show all' reveals every viewable space (name-sorted), and one can be selected", async ({ page }) => {
  await openDemo(page);
  const tag = Date.now().toString(36);
  // a uniquely-named space that sorts LATE (won't be in the current+recents default) — so it only appears
  // after expanding "show all".
  const zebraName = `Zzz-showall-${tag}`;
  await mkSpace(page, zebraName);
  for (let i = 0; i < 9; i++) await mkSpace(page, `Fill-${tag}-${i}`); // push well past the cap of 8
  await page.reload();
  await page.waitForSelector("[data-testid=space-switcher]");
  await sleep(400);

  await page.click("[data-testid=space-switcher]");
  await expect(page.getByTestId("space-menu")).toBeVisible();
  const options = page.locator("[data-testid=space-menu] [data-testid=space-option]");
  await expect(options).toHaveCount(8); // bounded default
  // the late-sorting space is NOT in the bounded default…
  await expect(page.locator("[data-testid=space-menu]", { hasText: zebraName })).toHaveCount(0);

  // click "show all" → the full list; the previously-hidden space now appears.
  await page.getByTestId("space-show-all").click();
  await sleep(200);
  expect(await options.count()).toBeGreaterThan(8);
  const zebra = options.filter({ hasText: zebraName }).first();
  await expect(zebra).toBeVisible();

  // selecting it switches the active space.
  await zebra.click();
  await sleep(400);
  await expect(page.getByTestId("space-switcher")).toContainText(zebraName);
});

// #295: a search that matches NO space must show the "no spaces match" empty message. cmdk's <CommandEmpty>
// never fired (the always-present rename/new items kept its internal count >= 2), so the message was dead
// code and the menu looked frozen. Now it's rendered explicitly when a non-empty query matches nothing.
test("#295: a non-matching space search shows the empty message; a matching one does not", async ({ page }) => {
  await openDemo(page);
  await page.waitForSelector("[data-testid=space-switcher]");
  await sleep(300);
  await page.click("[data-testid=space-switcher]");
  await expect(page.getByTestId("space-menu")).toBeVisible();

  // a query that matches nothing → 0 options AND the explicit empty message.
  await page.getByTestId("space-search").fill("zzz-no-such-space-zzz");
  await sleep(200);
  await expect(page.locator("[data-testid=space-menu] [data-testid=space-option]")).toHaveCount(0);
  await expect(page.getByTestId("space-empty")).toBeVisible();

  // clearing the query hides the empty message (spaces are listed again).
  await page.getByTestId("space-search").fill("");
  await sleep(200);
  await expect(page.getByTestId("space-empty")).toHaveCount(0);
});
