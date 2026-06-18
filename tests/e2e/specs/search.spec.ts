import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep } from "../helpers";
import { STALE_TITLE } from "../fixtures";

const API = "http://dev.localhost:4010";

async function typeSearch(page: Page, q: string) {
  const input = page.locator("[data-testid=search-input]");
  await input.click();
  await input.fill("");
  await input.fill(q);
  await sleep(700); // debounce + query
}
const resultsText = (page: Page) => page.$eval("[data-testid=search-results]", (el) => el.innerText).catch(() => "");

test("search: find by title, FGA-excluded title hidden, empty, keyboard", async ({ page }) => {
  await openDemo(page);

  // create an indexed page via the member API (createPage -> Meili upsert)
  const title = "SEARCHME-E2E-UNIQUE";
  await page.evaluate(async ({ api, title }) => {
    await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
  }, { api: API, title });
  await sleep(2000); // allow async indexing

  // (1) found by title; (2) selecting navigates
  await typeSearch(page, title);
  await page.waitForSelector("[data-testid=search-item]", { timeout: 5000 });
  expect(await resultsText(page)).toContain(title);
  await page.locator("[data-testid=search-item]").first().click();
  await sleep(500);
  expect(page.url()).toMatch(/\/p\/[0-9a-f-]{36}$/);

  // (3) **SECURITY** a title present in Meili (stage-1 candidate) but lacking an
  // FGA grant (stage-2) must NOT appear in the UI.
  await typeSearch(page, STALE_TITLE);
  await sleep(400);
  expect(await page.locator("[data-testid=search-item]").count()).toBe(0);
  expect(await resultsText(page)).toMatch(/no results/i);

  // (4) genuine no-match
  await typeSearch(page, "QQ-NO-MATCH-QQ");
  expect(await resultsText(page)).toMatch(/no results/i);

  // (5) keyboard ArrowDown + Enter opens a result
  await typeSearch(page, title);
  await page.waitForSelector("[data-testid=search-item]", { timeout: 5000 });
  await page.locator("[data-testid=search-input]").press("ArrowDown");
  await page.locator("[data-testid=search-input]").press("Enter");
  await sleep(500);
  expect(page.url()).toMatch(/\/p\/[0-9a-f-]{36}$/);
});
