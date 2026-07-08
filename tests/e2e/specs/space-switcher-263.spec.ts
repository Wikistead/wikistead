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
