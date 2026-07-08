import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// M2 #2 Stage A (ADR-022 Part 10): cell alignment via the edit toolbar promotes a pipe
// table to :::table (text-align style), round-trips, and renders.
async function pipeTableInEdit(page: any) {
  await page.click("[data-pane=preview] .cm-content");
  for (const l of ["| A | B |", "| --- | --- |", "| 1 | 2 |", "", "below"]) { await page.keyboard.type(l); await page.keyboard.press("Enter"); }
  await sleep(250);
  // #154: a click on the table enters render-active → the IN-EDITOR table editor (table-edit)
  // mounts inside CodeMirror (no modal). Each op commits to the doc per-op (host.replaceSource);
  // Escape exits edit mode → the static render.
  await page.locator("[data-pane=preview] table.cm-lp-table").click(); await sleep(150); await page.keyboard.press("Control+Enter"); // #216: pipe×Live RichUI = Ctrl+Enter opt-in
  await expect(page.getByTestId("table-edit")).toBeVisible();
  expect(await page.getByTestId("macro-modal").count()).toBe(0);
}

// #197: the always-on spreadsheet select handles (A/B/1/2) are removed — selection is by DRAGGING
// across cells. A full-height drag over one column = column selected (col ops show); full-width over
// one row = row selected. These helpers reproduce that gesture by data-cellkey.
async function dragCells(page: any, from: string, to: string) {
  const s = (await page.locator(`[data-testid=table-edit] [data-cellkey="${from}"]`).boundingBox())!;
  const e = (await page.locator(`[data-testid=table-edit] [data-cellkey="${to}"]`).boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2, { steps: 6 });
  await page.mouse.up();
  await sleep(80);
}
const selectCol = (page: any, c: number, lastRow: number) => dragCells(page, `0,${c}`, `${lastRow},${c}`);
const selectRow = (page: any, r: number, lastCol: number) => dragCells(page, `${r},0`, `${r},${lastCol}`);
// Count columns / rows from the data cells (data-cellkey="r,c") — the select-handle count is gone.
const colCount = (page: any) => page.locator('[data-testid=table-edit] [data-cellkey^="0,"]').count(); // row-0 cells
const rowCount = (page: any) => page.locator('[data-testid=table-edit] [data-cellkey$=",0"]').count(); // col-0 cells

test("align: select a cell, Align Center → promotes to :::table with text-align", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tablealign");
  await enterEdit(page);
  await pipeTableInEdit(page);

  const edit = page.getByTestId("table-edit");
  await edit.locator("td").first().click(); // select body cell "1"
  await page.getByTestId("table-align-center").click();
  await sleep(200);

  await page.keyboard.press("Escape"); // #154: per-op commit; Escape exits in-editor edit mode
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

  await page.keyboard.press("Escape"); // #154: per-op commit; Escape exits in-editor edit mode
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

  await page.keyboard.press("Escape"); // #154: per-op commit; Escape exits in-editor edit mode
  await sleep(200);
  const macroTable = page.locator("[data-pane=preview] [data-testid=macro-table]");
  await expect(macroTable).toBeVisible();
  expect(await macroTable.locator('th[style*="width"]').count()).toBe(1);
});

// #146 / ADR-041 option B: with MULTIPLE columns selected, a single border drag resizes ALL
// selected columns, and the LIVE PREVIEW already moves them — so the table does NOT jump on
// release (preview == commit, the bug fix), and every selected column ends up with a width.
test("multi-column resize: live preview matches commit (no jump) + all selected columns resized", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tablemultiresize");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  for (const l of ["| A | B | C |", "| - | - | - |", "| 1 | 2 | 3 |", "", "below"]) { await page.keyboard.type(l); await page.keyboard.press("Enter"); }
  await sleep(250);
  await page.locator("[data-pane=preview] table.cm-lp-table").click(); await sleep(150); await page.keyboard.press("Control+Enter"); // #216: pipe×Live RichUI = Ctrl+Enter opt-in
  await expect(page.getByTestId("table-edit")).toBeVisible(); // #154: in-editor, no modal

  const grid = page.locator("[data-testid=table-edit] table.cm-lp-table-grid");
  const before = (await grid.boundingBox())!.width;

  await dragCells(page, "0,0", "1,2"); // #197: drag across every cell → drag-resize applies to all columns
  await sleep(100);
  const handle = page.getByTestId("table-col-resize-0");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 8 });
  await sleep(60);
  const previewW = (await grid.boundingBox())!.width; // table width WHILE dragging (the preview)
  await page.mouse.up();
  await sleep(200);
  const committedW = (await page.locator("[data-testid=table-edit] table.cm-lp-table-grid").boundingBox())!.width; // after commit re-render

  expect(committedW).toBeGreaterThan(before + 40); // multiple columns grew (not just one)
  expect(Math.abs(committedW - previewW)).toBeLessThanOrEqual(8); // no jump: preview == commit

  await page.keyboard.press("Escape"); // #154: per-op commit; Escape exits in-editor edit mode
  await sleep(200);
  const macroTable = page.locator("[data-pane=preview] [data-testid=macro-table]");
  await expect(macroTable).toBeVisible();
  expect(await macroTable.locator('th[style*="width"]').count()).toBeGreaterThanOrEqual(2); // all selected columns got a width
});

test("header: toggle a body cell to header (th) → promotes with a body <th>", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tableheader");
  await enterEdit(page);
  await pipeTableInEdit(page);

  await page.getByTestId("table-edit").locator("td").first().click(); // a body cell
  await page.getByTestId("table-header").click();
  await sleep(200);

  await page.keyboard.press("Escape"); // #154: per-op commit; Escape exits in-editor edit mode
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
test("drag-selecting a whole column applies colour to all its cells (#197)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tablecolsel");
  await enterEdit(page);
  await pipeTableInEdit(page);

  await selectCol(page, 0, 1); // #197: drag over column 0's cells (full height) → column selected
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

  await page.keyboard.press("Escape"); // #154: per-op commit; Escape exits in-editor edit mode
  await sleep(200);
  const macroTable = page.locator("[data-pane=preview] [data-testid=macro-table]");
  await expect(macroTable).toBeVisible();
  // both cells of column 0 (the th + the td) got a background.
  expect(await macroTable.locator('[style*="background"]').count()).toBe(2);
});

// #197: the spreadsheet A/B/1/2 labels + select handles are REMOVED (drag-select replaces them), so
// the old "labels show A/B/C, 1/2/3" test is gone by design.

// #197 (comment 638): insert a column / row via the SELECTED CELL's op toolbar (the standalone "+"
// bars were removed); any cell selection targets its column + row. Stays a pipe table.
test("insert a column and a row from a selected cell's ops (stays Tier-1 pipe)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tableadd");
  await enterEdit(page);
  await pipeTableInEdit(page); // 2 cols × (header + 1 body row)

  await dragCells(page, "1,1", "1,1"); // select a single body cell → its col + row ops show
  await sleep(120);
  await page.getByTestId("table-col-insert-after").click();
  await sleep(150);
  expect(await colCount(page)).toBe(3); // #197: 3rd column now exists (counted from data cells)
  await dragCells(page, "1,0", "1,0");
  await sleep(120);
  await page.getByTestId("table-row-insert-below").click();
  await sleep(150);
  expect(await rowCount(page)).toBe(3); // 3rd row now exists

  await page.keyboard.press("Escape"); // #154: per-op commit; Escape exits in-editor edit mode
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

  await selectCol(page, 1, 1); // #197: drag-select column 1 (full height) → column ops show
  await expect(page.getByTestId("table-col-insert-after")).toBeVisible();
  await page.getByTestId("table-col-insert-after").click();
  await sleep(150);
  expect(await colCount(page)).toBe(3);

  await selectCol(page, 0, 1);
  await page.getByTestId("table-col-delete").click();
  await sleep(150);
  expect(await colCount(page)).toBe(2);
});

// #3: insert before/after the selected ROW, and delete a row, from the contextual toolbar.
test("insert-below and delete a row via the contextual toolbar", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tablerowinsdel");
  await enterEdit(page);
  await pipeTableInEdit(page); // header row + 1 body row = 2 rows

  await selectRow(page, 1, 1); // #197: drag-select row 1 (full width) → row ops show
  await expect(page.getByTestId("table-row-insert-below")).toBeVisible();
  await expect(page.getByTestId("table-row-delete")).toBeVisible(); // delete is discoverable (#3)
  await page.getByTestId("table-row-insert-below").click();
  await sleep(150);
  expect(await rowCount(page)).toBe(3);

  await selectRow(page, 0, 1);
  await page.getByTestId("table-row-delete").click();
  await sleep(150);
  expect(await rowCount(page)).toBe(2);
});

// #3: the add affordances are now ATTACHED to the table (a "+" in the header band / below
// the last row), not a disconnected labeled bottom bar.
test("column/row insert+delete ops live on the contextual toolbar (not in-grid handles or a disconnected bar)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tableaddattached");
  await enterEdit(page);
  await pipeTableInEdit(page);
  // #197: the in-grid `+` handles were REMOVED — insert/delete for a column OR row is now on the selected
  // cell's op toolbar. Select a cell → the col/row op groups appear.
  await page.getByTestId("table-edit").locator("td").first().click();
  await sleep(150);
  await expect(page.getByTestId("table-col-insert-before")).toBeVisible();
  await expect(page.getByTestId("table-col-insert-after")).toBeVisible();
  await expect(page.getByTestId("table-col-delete")).toBeVisible();
  await expect(page.getByTestId("table-row-insert-above")).toBeVisible();
  await expect(page.getByTestId("table-row-insert-below")).toBeVisible();
  await expect(page.getByTestId("table-row-delete")).toBeVisible();
  // the old in-grid handles + the disconnected actions bar are both gone (#197).
  expect(await page.locator("[data-testid=table-add-col], [data-testid=table-add-row]").count()).toBe(0);
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
  await page.locator("[data-pane=preview] table.cm-lp-table").click(); await sleep(150); await page.keyboard.press("Control+Enter"); // #216: pipe×Live RichUI = Ctrl+Enter opt-in
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

// #217 (comment 772): at a narrow width the contextual toolbar WRAPS (not horizontal scroll — scroll hid
// ops). Every op stays visible without scrolling, groups (cm-lp-table-ops) wrap as indivisible units, and
// the bar is clamped to the editor width so it can't run off. At a normal width it stays one row.
test("#217: the table edit toolbar wraps (no scroll) at narrow width, groups stay intact, one row when wide", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 900, height: 800 } })).newPage();
  await openScratch(page, "tablebarwrap");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // a many-column table → a wide toolbar (all ops present) relative to the editor
  for (const l of ["| A | B | C | D | E | F |", "| - | - | - | - | - | - |", "| 1 | 2 | 3 | 4 | 5 | 6 |", "", "below"]) { await page.keyboard.type(l); await page.keyboard.press("Enter"); }
  await sleep(250);
  await page.locator("[data-pane=preview] table.cm-lp-table").click(); await sleep(150); await page.keyboard.press("Control+Enter"); // #216: pipe×Live RichUI = Ctrl+Enter opt-in
  await expect(page.getByTestId("table-edit")).toBeVisible();
  await page.getByTestId("table-edit").locator("td").first().click();
  const bar = page.locator("[data-testid=table-edit] .cm-lp-table-edit-bar");
  await expect(bar).toBeVisible();

  const m = await bar.evaluate((el) => {
    const cs = getComputedStyle(el);
    const barRect = el.getBoundingClientRect();
    // every op button is WITHIN the bar bounds (no horizontal clipping / no scroll needed to reach it).
    const btns = Array.from(el.querySelectorAll("button")) as HTMLElement[];
    const allWithin = btns.every((b) => { const r = b.getBoundingClientRect(); return r.left >= barRect.left - 1 && r.right <= barRect.right + 1; });
    // each logical group sits on ONE row (its buttons share a top) — groups never split mid-group.
    const groupsIntact = (Array.from(el.querySelectorAll(".cm-lp-table-ops")) as HTMLElement[]).every((g) => {
      const bs = Array.from(g.querySelectorAll("button")) as HTMLElement[];
      if (bs.length < 2) return true;
      const t0 = Math.round(bs[0]!.getBoundingClientRect().top);
      return bs.every((b) => Math.abs(Math.round(b.getBoundingClientRect().top) - t0) < 4);
    });
    return { flexWrap: cs.flexWrap, noScroll: el.scrollWidth <= el.clientWidth + 1, allWithin, groupsIntact, height: Math.round(barRect.height) };
  });
  expect(m.flexWrap).toBe("wrap"); // wraps, not nowrap
  expect(m.noScroll, "no horizontal scroll — all ops visible by wrapping").toBe(true);
  expect(m.allWithin, "every op button is within the bar bounds (nothing clipped off)").toBe(true);
  expect(m.groupsIntact, "each logical group stays on one row (wraps as a unit)").toBe(true);
});

// #256: the structural-op + no-fill buttons used environment-dependent Unicode glyphs (⊞ ✕ ⌀) that broke
// on some fonts. They must now be trusted static SVG icons (no font fallback). Real Chromium.
test("#256: table structural-op / no-fill buttons render as SVG icons, not font glyphs", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-icons");
  await enterEdit(page);
  await pipeTableInEdit(page);

  // Select a column → the column ops group shows.
  await selectCol(page, 0, 1);
  for (const id of ["table-col-insert-before", "table-col-insert-after", "table-col-delete"]) {
    await expect(page.getByTestId(id).locator("svg")).toHaveCount(1);
    expect(((await page.getByTestId(id).textContent()) ?? "").trim(), `${id} must have no glyph text`).toBe("");
  }
  // Select a row → the row ops group shows.
  await selectRow(page, 0, 1);
  for (const id of ["table-row-insert-above", "table-row-insert-below", "table-row-delete"]) {
    await expect(page.getByTestId(id).locator("svg")).toHaveCount(1);
  }
  // The "no fill" colour swatch is an SVG too (was the ⌀ glyph).
  await expect(page.getByTestId("table-bg-clear").locator("svg")).toHaveCount(1);
});
