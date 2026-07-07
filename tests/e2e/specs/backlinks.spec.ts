import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #230: the "Linked mentions" section on a page lists pages that link to it via a persisted /p/<id>
// link (server FGA-view-gated). Real Chromium: create a target, publish a second page linking to it,
// then open the target and see the backlink; click it to navigate.
test("#230: a page shows a backlink from another page that links to it", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const target = await openScratch(page, "bl-target");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("I am the target page.\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(600);

  // Second page links to the target via /p/<id>.
  const linker = await openScratch(page, "bl-linker");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`see [the target](/p/${target}) here\n`);
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(800);

  // Open the target in READ mode → the backlinks section shows the linker.
  await page.goto(`/p/${target}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await expect(page.getByTestId("backlinks")).toBeVisible({ timeout: 10000 });
  const link = page.getByTestId(`backlink-${linker}`);
  await expect(link).toBeVisible();
  await expect(link).toHaveText("bl-linker");
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/p/${linker}$`));
});

test("#230: a page with no backlinks renders no section (no clutter)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const lonely = await openScratch(page, "bl-lonely");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("nobody links to me\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(600);
  await page.goto(`/p/${lonely}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(1500);
  expect(await page.getByTestId("backlinks").count()).toBe(0);
});
