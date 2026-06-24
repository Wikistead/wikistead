import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// Light-3: vim ex commands as entry points to existing actions. From NORMAL-mode `:`,
// :q leaves edit mode and :w publishes (which, in this app, returns to the rendered view
// — publish == done). The publish path itself is unchanged; these only invoke it.
async function toNormalMode(page: import("@playwright/test").Page) {
  await page.getByTestId("vim-toggle").click();
  await sleep(300);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape"); // ensure NORMAL mode
}

test("vim :q leaves edit mode (back to the rendered view)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "vim-q");
  await enterEdit(page);
  // editing now → the Edit toggle is gone
  expect(await page.getByTestId("edit-toggle").count()).toBe(0);

  await toNormalMode(page);
  await page.keyboard.type(":q");
  await page.keyboard.press("Enter");

  // back in view mode → the Edit toggle reappears
  await expect(page.getByTestId("edit-toggle")).toBeVisible();
});

test("vim :w publishes (and returns to view, publish == done)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "vim-w");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("publish me via :w");
  await sleep(300);

  await toNormalMode(page);
  await page.keyboard.type(":w");
  await page.keyboard.press("Enter");

  // publish succeeded → returns to the rendered view (Edit toggle reappears)
  await expect(page.getByTestId("edit-toggle")).toBeVisible({ timeout: 10_000 });
  // and the published content is shown in the read-only view
  await expect(page.locator("[data-pane=preview] .cm-content")).toContainText("publish me via :w");
});
