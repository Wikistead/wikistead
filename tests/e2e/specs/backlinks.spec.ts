import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #230: the "Backlinks" section on a page lists pages that link to it via a persisted /p/<id>
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

  // #322 / ADR-133: open the target, then open the "Related" right-rail panel from the ⋯ menu (was the
  // standalone "Backlinks" panel #230; backlinks are now the first SECTION inside Related).
  await page.goto(`/p/${target}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("related-toggle").click();
  await expect(page.getByTestId("related-panel")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("related-panel")).toContainText("Backlinks"); // the §Backlinks section header
  const link = page.getByTestId(`backlink-${linker}`);
  await expect(link).toBeVisible();
  await expect(link).toHaveText("bl-linker");
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/p/${linker}$`));
});

// #246: the page-delete confirm dialog warns when the page is referenced by others (advisory — delete is
// not blocked). Real Chromium.
test("#246: delete confirm shows a backlink warning listing the referrers", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const target = await openScratch(page, "del-target");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("target to be deleted.\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(600);

  const linker = await openScratch(page, "del-linker");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`ref [target](/p/${target}) here\n`);
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(800);

  // Open the target and start the delete flow via the page overflow menu.
  await page.goto(`/p/${target}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(500);
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("delete-page").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  // The warning appears with the referrer listed.
  const warning = page.getByTestId("delete-backlink-warning");
  await expect(warning).toBeVisible({ timeout: 8000 });
  await expect(warning).toContainText("del-linker");
  // Delete is NOT blocked — the confirm button is still present; cancel to avoid deleting.
  await expect(page.getByTestId("confirm-delete-page")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("#246: no backlink warning when the page has no references", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const lonely = await openScratch(page, "del-lonely");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("nobody references me\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(600);
  await page.goto(`/p/${lonely}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(500);
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("delete-page").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await sleep(1200); // give the backlinks fetch time to resolve
  expect(await page.getByTestId("delete-backlink-warning").count()).toBe(0);
});

test("#230: the backlinks panel shows an empty state and opens in edit mode too", async ({ browser }) => {
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
  await sleep(400);
  // Open the panel (read mode) → empty state, not a list. No always-on bottom section anymore.
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("related-toggle").click();
  await expect(page.getByTestId("related-panel")).toBeVisible();
  await expect(page.getByTestId("backlinks-empty")).toBeVisible();
  // #230 redesign: openable in EDIT mode too (the old bottom section never rendered while editing).
  await page.getByTestId("related-close").click();
  await enterEdit(page);
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("related-toggle").click();
  await expect(page.getByTestId("related-panel")).toBeVisible();
});
