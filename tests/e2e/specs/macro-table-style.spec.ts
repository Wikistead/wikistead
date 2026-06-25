import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// M2 #2 Stage A (ADR-022 Part 10): cell alignment via the edit toolbar promotes a pipe
// table to :::table (text-align style), round-trips, and renders.
async function pipeTableInEdit(page: any) {
  await page.click("[data-pane=preview] .cm-content");
  for (const l of ["| A | B |", "| --- | --- |", "| 1 | 2 |", "", "below"]) { await page.keyboard.type(l); await page.keyboard.press("Enter"); }
  await sleep(250);
  // Non-vim: a click enters edit mode directly (#5) — no Ctrl+Enter.
  await page.locator("[data-pane=preview] table.cm-lp-table").click();
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

test("color: select a cell, pick a background preset → promotes with background", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tablecolor");
  await enterEdit(page);
  await pipeTableInEdit(page);

  await page.getByTestId("table-edit").locator("td").first().click();
  await page.getByTestId("table-bg-green").click();
  await sleep(200);

  await page.getByText("below", { exact: true }).click();
  await sleep(200);
  const macroTable = page.locator("[data-pane=preview] [data-testid=macro-table]");
  await expect(macroTable).toBeVisible();
  expect(await macroTable.locator('td[style*="background"]').count()).toBe(1);
});

test("width: drag a column border → promotes with a width style", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tablewidth");
  await enterEdit(page);
  await pipeTableInEdit(page);

  const handle = page.getByTestId("table-col-resize-0");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await sleep(200);

  await page.getByText("below", { exact: true }).click();
  await sleep(200);
  const macroTable = page.locator("[data-pane=preview] [data-testid=macro-table]");
  await expect(macroTable).toBeVisible();
  expect(await macroTable.locator('th[style*="width"]').count()).toBe(1);
});

test("header: toggle a body cell to header (th) → promotes with a body <th>", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tableheader");
  await enterEdit(page);
  await pipeTableInEdit(page);

  await page.getByTestId("table-edit").locator("td").first().click(); // a body cell
  await page.getByTestId("table-header").click();
  await sleep(200);

  await page.getByText("below", { exact: true }).click();
  await sleep(200);
  const macroTable = page.locator("[data-pane=preview] [data-testid=macro-table]");
  await expect(macroTable).toBeVisible();
  // row 0 has 2 <th> (A,B); the promoted body header adds a 3rd → complex header.
  expect(await macroTable.locator("th").count()).toBe(3);
});

// #5: non-vim → a CLICK enters edit mode directly (no Ctrl+Enter). #2: edit mode persists
// across operations (you only leave via Done/Esc).
test("non-vim click enters edit; edit mode persists across ops; Esc exits", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tablepersist");
  await enterEdit(page);
  await pipeTableInEdit(page); // a plain click entered edit (asserted inside)

  const edit = page.getByTestId("table-edit");
  await edit.locator("td").first().click();
  await page.getByTestId("table-align-center").click();
  await sleep(150);
  await expect(page.getByTestId("table-edit")).toBeVisible(); // still in edit mode (#2)
  await page.getByTestId("table-edit").locator("td").first().click();
  await page.getByTestId("table-bg-green").click();
  await sleep(150);
  await expect(page.getByTestId("table-edit")).toBeVisible(); // STILL in edit mode

  await page.keyboard.press("Escape"); // explicit exit
  await sleep(150);
  await expect(page.getByTestId("table-edit")).toHaveCount(0);
});

// #5: row/column header handles select a whole column/row (then an op applies to all).
test("column handle selects the whole column; color applies to all its cells", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tablecolsel");
  await enterEdit(page);
  await pipeTableInEdit(page);

  await page.getByTestId("table-col-select-0").click(); // select column 0 (A + 1)
  // #1: the selected column's cells show the blue selection highlight + outer border.
  expect(await page.locator("[data-testid=table-edit] .cm-lp-cell-sel").count()).toBe(2);
  expect(await page.locator("[data-testid=table-edit] .cm-lp-sel-l").count()).toBeGreaterThan(0);
  await page.getByTestId("table-bg-blue").click();
  await sleep(200);

  await page.getByText("below", { exact: true }).click();
  await sleep(200);
  const macroTable = page.locator("[data-pane=preview] [data-testid=macro-table]");
  await expect(macroTable).toBeVisible();
  // both cells of column 0 (the th + the td) got a background.
  expect(await macroTable.locator('[style*="background"]').count()).toBe(2);
});
