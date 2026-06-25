import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// M2 (ADR-022 Part 10): cell-merge mouse editing. A GFM pipe table (Tier 1) → toggle
// edit (Ctrl+Enter) → select cells → Merge → PROMOTES to a :::table (HTML colspan). Then
// edit the :::table → Unmerge → auto-DEMOTES back to a pipe table.
test("pipe table → merge promotes to :::table → unmerge demotes back", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tablemerge");
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
  for (const line of ["| A | B |", "| --- | --- |", "| 1 | 2 |", "", "below"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(300);

  // The pipe table renders (Tier 1 — not a :::table macro yet).
  await expect(page.locator("[data-pane=preview] table.cm-lp-table")).toBeVisible();
  expect(await page.locator("[data-pane=preview] [data-testid=macro-table]").count()).toBe(0);

  // Caret into the table, then Ctrl+Enter → edit mode (cell-merge toolbar).
  await page.locator("[data-pane=preview] table.cm-lp-table").click();
  await sleep(120);
  await page.keyboard.press("Control+Enter");
  const edit = page.getByTestId("table-edit");
  await expect(edit).toBeVisible();

  // Select the two body cells and Merge → promote.
  await edit.locator("td").nth(0).click();
  await edit.locator("td").nth(1).click();
  await page.getByTestId("table-merge").click();
  await sleep(200);

  // Caret off the block → the promoted :::table renders with a colspan=2 cell.
  await page.getByText("below", { exact: true }).click();
  await sleep(200);
  const macroTable = page.locator("[data-pane=preview] [data-testid=macro-table]");
  await expect(macroTable).toBeVisible();
  expect(await macroTable.locator('td[colspan="2"]').count()).toBe(1);

  // Now demote: edit the :::table, select the merged cell, Unmerge → back to pipe table.
  await macroTable.click();
  await sleep(120);
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("table-edit")).toBeVisible();
  await page.getByTestId("table-edit").locator('td[colspan="2"]').click();
  await page.getByTestId("table-unmerge").click();
  await sleep(200);

  await page.getByText("below", { exact: true }).click();
  await sleep(200);
  // Demoted: no more :::table macro; a plain pipe table renders again.
  expect(await page.locator("[data-pane=preview] [data-testid=macro-table]").count()).toBe(0);
  await expect(page.locator("[data-pane=preview] table.cm-lp-table")).toBeVisible();
});
