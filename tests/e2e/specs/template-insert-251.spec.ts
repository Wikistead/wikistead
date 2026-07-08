import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #251 / ADR-110: the "/"-palette "Insert template" command. Selecting it opens the picker (the same
// list/preview asset as the #250 sidebar picker); choosing a template INSERTS its body at the caret — it
// does NOT replace the page, and the title is untouched. Real Chromium.
test("#251: slash 'insert template' inserts the template body at the caret, non-destructively", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();

  // Make a personal template from a published page.
  const src = await openScratch(page, `ins-src-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Inserted heading\n\n- alpha\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(700);
  await page.goto(`/p/${src}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("save-template-open").click();
  await page.getByTestId("template-name").fill("Snippet");
  await page.getByTestId("save-template-submit").click();
  await sleep(500);

  // On a fresh page, type some existing content, then insert the template via the "/" palette.
  await openScratch(page, `ins-host-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("Existing line\n");
  await sleep(200);

  await page.keyboard.type("/template");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-insert-template"]');

  // The picker opens; choose the template and use it.
  await expect(page.getByTestId("template-picker")).toBeVisible();
  const item = page.getByTestId("template-picker-item").filter({ hasText: "Snippet" }).first();
  await expect(item).toBeVisible({ timeout: 8000 });
  await item.click();
  await page.getByTestId("template-picker-use").click();
  await sleep(400);

  // The body was inserted at the caret; the original content is preserved (non-destructive).
  const content = page.locator("[data-pane=preview] .cm-content");
  await expect(content).toContainText("Existing line");
  await expect(content).toContainText("Inserted heading");
  await expect(content).toContainText("alpha");
});
