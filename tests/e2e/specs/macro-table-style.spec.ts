import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// M2 #2 Stage A (ADR-022 Part 10): cell alignment via the edit toolbar promotes a pipe
// table to :::table (text-align style), round-trips, and renders.
async function pipeTableInEdit(page: any) {
  await page.click("[data-pane=preview] .cm-content");
  for (const l of ["| A | B |", "| --- | --- |", "| 1 | 2 |", "", "below"]) { await page.keyboard.type(l); await page.keyboard.press("Enter"); }
  await sleep(250);
  await page.locator("[data-pane=preview] table.cm-lp-table").click();
  await sleep(100);
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("table-edit")).toBeVisible();
}

test("align: select a cell, Align Center → promotes to :::table with text-align", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tablealign");
  await enterEdit(page);
  await pipeTableInEdit(page);

  const edit = page.getByTestId("table-edit");
  await edit.locator("td").first().click(); // select body cell "1"
  await page.getByTestId("table-align-center").click();
  await sleep(200);

  await page.getByText("below", { exact: true }).click();
  await sleep(200);
  const macroTable = page.locator("[data-pane=preview] [data-testid=macro-table]");
  await expect(macroTable).toBeVisible(); // promoted to :::table
  expect(await macroTable.locator('td[style*="center"]').count()).toBe(1);
});
