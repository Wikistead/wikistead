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
  // #1: the selected column's cells must VISUALLY fill (computed style, not just the
  // class) — incl. the HEADER cell, whose base `th` background would otherwise win the
  // specificity contest. This is what the class-presence assertion missed on device.
  const hdr = page.getByTestId("table-edit").locator('[data-cellkey="0,0"]'); // header "A"
  const bg = await hdr.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe("rgba(0, 0, 0, 0)"); // not transparent
  expect(bg).not.toBe("transparent");
  expect(bg).not.toBe("rgba(127, 127, 127, 0.12)"); // not the unselected `th` grey
  // outer accent border actually paints (2px on the left edge of the leftmost column).
  expect(await hdr.evaluate((el) => parseFloat(getComputedStyle(el).borderLeftWidth))).toBeGreaterThanOrEqual(2);
  await page.getByTestId("table-bg-blue").click();
  await sleep(200);

  await page.getByText("below", { exact: true }).click();
  await sleep(200);
  const macroTable = page.locator("[data-pane=preview] [data-testid=macro-table]");
  await expect(macroTable).toBeVisible();
  // both cells of column 0 (the th + the td) got a background.
  expect(await macroTable.locator('[style*="background"]').count()).toBe(2);
});

// #2: the select handles read as a spreadsheet header (A/B/C across the top, 1/2/3 down
// the side) — unmistakably not data cells.
test("select handles show spreadsheet labels (A/B/C, 1/2/3)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tablelabels");
  await enterEdit(page);
  await pipeTableInEdit(page);
  expect((await page.getByTestId("table-col-select-0").textContent())?.trim()).toBe("A");
  expect((await page.getByTestId("table-col-select-1").textContent())?.trim()).toBe("B");
  expect((await page.getByTestId("table-row-select-0").textContent())?.trim()).toBe("1");
});

// #1: append a column / row at the end via the trailing "+" handles; stays a pipe table.
test("the trailing + adds a column and a row (stays Tier-1 pipe)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tableadd");
  await enterEdit(page);
  await pipeTableInEdit(page); // 2 cols × (header + 1 body row)

  await page.getByTestId("table-add-col").click();
  await sleep(150);
  await expect(page.getByTestId("table-col-select-2")).toBeVisible(); // 3rd column now exists
  await page.getByTestId("table-add-row").click();
  await sleep(150);
  await expect(page.getByTestId("table-row-select-2")).toBeVisible(); // 3rd row now exists

  await page.getByText("below", { exact: true }).click();
  await sleep(200);
  // Span-free + style-free → still a GFM pipe table (no :::table promotion).
  await expect(page.locator("[data-pane=preview] [data-testid=macro-table]")).toHaveCount(0);
  const tbl = page.locator("[data-pane=preview] table.cm-lp-table");
  await expect(tbl).toBeVisible();
  expect(await tbl.locator("tr").first().locator("th,td").count()).toBe(3); // 3 columns
});

// #1: insert before/after the selected column, and delete a column, from the toolbar.
test("insert-after and delete a column via the contextual toolbar", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tableinsdel");
  await enterEdit(page);
  await pipeTableInEdit(page);

  await page.getByTestId("table-col-select-1").click(); // select column B → column ops show
  await expect(page.getByTestId("table-col-insert-after")).toBeVisible();
  await page.getByTestId("table-col-insert-after").click();
  await sleep(150);
  expect(await page.locator('[data-testid=table-edit] [data-testid^="table-col-select-"]').count()).toBe(3);

  await page.getByTestId("table-col-select-0").click();
  await page.getByTestId("table-col-delete").click();
  await sleep(150);
  expect(await page.locator('[data-testid=table-edit] [data-testid^="table-col-select-"]').count()).toBe(2);
});

// #3: insert before/after the selected ROW, and delete a row, from the contextual toolbar.
test("insert-below and delete a row via the contextual toolbar", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tablerowinsdel");
  await enterEdit(page);
  await pipeTableInEdit(page); // header row + 1 body row = 2 rows

  await page.getByTestId("table-row-select-1").click(); // select row 2 → row ops show
  await expect(page.getByTestId("table-row-insert-below")).toBeVisible();
  await expect(page.getByTestId("table-row-delete")).toBeVisible(); // delete is discoverable (#3)
  await page.getByTestId("table-row-insert-below").click();
  await sleep(150);
  expect(await page.locator('[data-testid=table-edit] [data-testid^="table-row-select-"]').count()).toBe(3);

  await page.getByTestId("table-row-select-0").click();
  await page.getByTestId("table-row-delete").click();
  await sleep(150);
  expect(await page.locator('[data-testid=table-edit] [data-testid^="table-row-select-"]').count()).toBe(2);
});

// #3: the add affordances are now ATTACHED to the table (a "+" in the header band / below
// the last row), not a disconnected labeled bottom bar.
test("the add-column/add-row + handles are attached to the table grid", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tableaddattached");
  await enterEdit(page);
  await pipeTableInEdit(page);
  // both "+" handles live INSIDE the grid table (not a sibling actions bar)
  expect(await page.locator("[data-testid=table-edit] table.cm-lp-table-grid [data-testid=table-add-col]").count()).toBe(1);
  expect(await page.locator("[data-testid=table-edit] table.cm-lp-table-grid [data-testid=table-add-row]").count()).toBe(1);
  // the old disconnected actions bar is gone
  expect(await page.locator(".cm-lp-table-actions").count()).toBe(0);
});

// #2: the contextual toolbar must NOT clip off the right edge when a RIGHTMOST cell is
// selected — its left is clamped so the whole bar stays inside the editor container.
test("toolbar stays inside the container for a rightmost cell (no clip)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tablebarclip");
  await enterEdit(page);
  // a wide table so the rightmost cell sits near the right edge
  await page.click("[data-pane=preview] .cm-content");
  for (const l of ["| A | B | C | D | E |", "| - | - | - | - | - |", "| 1 | 2 | 3 | 4 | 5 |", "", "below"]) { await page.keyboard.type(l); await page.keyboard.press("Enter"); }
  await sleep(250);
  await page.locator("[data-pane=preview] table.cm-lp-table").click();
  await expect(page.getByTestId("table-edit")).toBeVisible();

  // select the rightmost body cell (column E)
  await page.getByTestId("table-edit").locator("td").last().click();
  await sleep(150);
  const bar = page.locator("[data-testid=table-edit] .cm-lp-table-edit-bar");
  await expect(bar).toBeVisible();
  const barBox = (await bar.boundingBox())!;
  const contBox = (await page.getByTestId("table-edit").boundingBox())!;
  // the toolbar's right edge stays within the container's right edge (allow 2px border)
  expect(barBox.x + barBox.width).toBeLessThanOrEqual(contBox.x + contBox.width + 2);
  expect(barBox.x).toBeGreaterThanOrEqual(contBox.x - 2);
});
