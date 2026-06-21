import { test, expect } from "@playwright/test";
import { openDemo, resetDoc, enterEdit, sleep } from "../helpers";

// P3: a GFM table renders as an HTML <table> in the live preview, and putting the
// cursor in it reveals the raw markdown (so it stays editable). Display-only: the
// canonical Y.Text is unchanged.
test("GFM table renders as an HTML table; cursor reveals raw markdown", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  await enterEdit(page);
  await resetDoc(page);

  await page.click("[data-pane=preview] .cm-content");
  for (const line of ["| Name | Age |", "| --- | --- |", "| Alice | 30 |", "below the table"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  // Cursor is now on the line after the table → the table is not revealed.
  await sleep(400);

  const table = page.locator("[data-pane=preview] table.cm-lp-table");
  await expect(table).toBeVisible();
  await expect(table).toContainText("Name");
  await expect(table).toContainText("Alice");
  await expect(table.locator("th").first()).toContainText("Name"); // header row
  await expect(table.locator("td").first()).toContainText("Alice"); // body row

  // Cursor into the table → raw markdown revealed (the HTML table is gone).
  await table.click();
  await sleep(300);
  expect(await page.locator("[data-pane=preview] table.cm-lp-table").count()).toBe(0);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("| Name | Age |");
});
