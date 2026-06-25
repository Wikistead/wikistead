import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// P3: a GFM table renders as an HTML <table> in the live preview, and putting the
// cursor in it reveals the raw markdown (so it stays editable). Display-only: the
// canonical Y.Text is unchanged.
//
// Uses a REAL throwaway page (unique id, not the shared demo doc) so this test's
// transient presence caret cannot linger as a ghost into other demo-based specs.
test("GFM table renders as an HTML table; cursor reveals raw markdown", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tables");
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
  // Blank line after the rows so the paragraph is NOT absorbed as a single-cell table
  // row (GFM), and so the caret ends 2+ lines below → the block is not adjacent-revealed.
  for (const line of ["| Name | Age |", "| --- | --- |", "| Alice | 30 |", "", "below the table"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  // Cursor is now well below the table → it renders (not revealed).
  await sleep(400);

  const table = page.locator("[data-pane=preview] table.cm-lp-table");
  await expect(table).toBeVisible();
  await expect(table).toContainText("Name");
  await expect(table).toContainText("Alice");
  await expect(table.locator("th").first()).toContainText("Name"); // header row
  await expect(table.locator("td").first()).toContainText("Alice"); // body row

  // vim ON: the cursor in the table reveals raw markdown (non-vim click now enters the
  // mouse edit mode instead — ADR-022 review #5, covered in the table-edit specs).
  await page.getByTestId("vim-toggle").click();
  await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-checked", "true");
  await page.locator("[data-pane=preview] table.cm-lp-table").click();
  await sleep(300);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("| Name | Age |");
});
