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

  // vim ON: moving the CARET into the table reveals raw markdown (a click now enters the
  // mouse edit mode in both modes — ADR-022 review #5, covered in the table-edit specs;
  // pipe tables stay hand-editable via reveal-on-cursor).
  await page.getByTestId("vim-toggle").click();
  await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape"); // vim normal
  await page.keyboard.press("g");
  await page.keyboard.press("g"); // gg → caret to the top (into the table) → reveal
  await sleep(300);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("| Name | Age |");
});

// #216 comment 874: the RichUI-entry pill belongs on the RAW-EDITING state — when the caret is IN the pipe
// table and its `| a | b |` source is visible — NOT on the rendered/finished table (that was the reversed
// condition the reviewer rejected). The pill is BOTH the visible Ctrl+Enter key hint AND a click target; a
// real click opens the in-editor rich table editor. It floats above the first raw row (does not cover the
// source) and is always visible (no hover gate — the hover-only version never showed on the reviewer's device).
test("#216 comment 874: the RichUI-entry pill shows on the RAW-editing state (caret in the table), not the rendered table", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-richui-raw");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("| Name | Age |\n| --- | --- |\n| Alice | 30 |\n\nbelow\n");
  await sleep(400);
  // The caret is BELOW the table (after "below") → the table renders as a widget. Per comment 874 the pill
  // must NOT be on the rendered, non-edited table.
  const table = page.locator("[data-pane=preview] table.cm-lp-table");
  await expect(table).toBeVisible();
  await expect(page.getByTestId("table-richui-enter")).toHaveCount(0); // no pill on the rendered widget

  // Click INTO the table → the caret enters it and the raw `| Name | Age |` source is revealed = the
  // raw-editing state. That is when the pill appears.
  await table.click();
  await sleep(250);
  const content = page.locator("[data-pane=preview] .cm-content");
  expect(await content.innerText()).toContain("| Name | Age |"); // raw source visible (caret-in)
  const btn = page.getByTestId("table-richui-enter");
  await expect(btn).toHaveCount(1);
  await expect(btn).toHaveAttribute("title", /Ctrl\+Enter/);
  await expect(btn).toContainText("Ctrl+↵"); // comment 860/874: visible key hint (not a tooltip)
  // Always visible without any hover (the show/no-show regression was hover-dependency).
  const opacityNoHover = Number(await btn.evaluate((el) => getComputedStyle(el).opacity));
  expect(opacityNoHover).toBeGreaterThan(0.4);
  // Floated ABOVE the first raw row (does not cover the `| Name` source): the pill's bottom is at/above the
  // first revealed line's top. The first .cm-line carrying the raw table source is the anchor row.
  const firstRaw = content.locator(".cm-line", { hasText: "| Name | Age |" }).first();
  const rowBox = (await firstRaw.boundingBox())!;
  const bb = (await btn.boundingBox())!;
  expect(bb.width).toBeGreaterThan(0);
  expect(bb.y).toBeLessThanOrEqual(rowBox.y + 2); // sits above the raw row, not over it
  expect(bb.x).toBeLessThanOrEqual(rowBox.x + rowBox.width); // left side of the row
  await btn.click(); // real click (no force) → reachable / not occluded
  await expect(page.getByTestId("table-edit")).toBeVisible(); // → the in-editor RichUI table editor opens
});

// #89 comment 848: the NON-editing pipe table cell must render its inline markdown (WYSIWYG), not show the
// literal ** / ~~ marks — consistent with the editing island and :::table. The table stays a Tier1 pipe
// table (inline marks don't promote to :::table — Open formats).
test("#89: a pipe table cell renders inline markdown when not editing (WYSIWYG, stays pipe)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-inline-render");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("| Name | Note |\n| --- | --- |\n| Alice | **bold** x ~~strike~~ |\n\nbelow\n");
  await sleep(400);
  const table = page.locator("[data-pane=preview] table.cm-lp-table");
  await expect(table).toBeVisible();
  await expect(table.locator("td strong")).toHaveText("bold"); // ** rendered as <strong>, not literal
  await expect(table.locator("td s")).toHaveText("strike");     // ~~ rendered as <s>
  expect(await table.innerText()).not.toContain("**"); // no literal marks visible in the rendered cell
});

// #89 comment 857 (2,3): Ctrl+Enter opens the RichUI on a displayed pipe table (keyboard entry, non-vim),
// and the RichUI GRID renders each cell's inline markdown (bold/code/link) — consistent with the non-editing
// table, not raw ** / `` marks.
test("#89: Ctrl+Enter opens the RichUI and its grid cells render inline markdown (bold/code/link)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-richui-render");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("| H | Note |\n| - | - |\n| a | **bold** `code` [lnk](https://x.test) |\n\nbelow\n");
  await sleep(400);
  await page.locator("[data-pane=preview] table.cm-lp-table").click(); // caret in → raw
  await sleep(150);
  await page.keyboard.press("Control+Enter"); // → RichUI (keyboard entry, no hover)
  const grid = page.getByTestId("table-edit");
  await expect(grid).toBeVisible(); // (2) Ctrl+Enter opened the RichUI
  await expect(grid.locator("td strong")).toHaveText("bold"); // (3) grid renders the decoration…
  await expect(grid.locator("td code")).toHaveText("code");
  await expect(grid.locator("td a")).toHaveText("lnk");
  expect(await grid.innerText()).not.toContain("**"); // …not the raw marks
});

// #89 comment 876: the NON-editing pipe TableWidget must render `code` and [link] just like bold/strike
// (all four are valid GFM in a pipe cell). Prior e2e only checked bold/strike on the non-editing widget;
// this pins code + link on the RENDERED table (caret moved away), in a real browser.
test("#89 comment 876 REPRO: non-editing pipe table renders code and link (not plain text)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "cell-code-link");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("| H | Note |\n| - | - |\n| a | `code` and [lnk](https://x.test) |\n\nbelow\n");
  await sleep(400);
  // caret is below the table → it renders as the static TableWidget
  const table = page.locator("[data-pane=preview] table.cm-lp-table");
  await expect(table).toBeVisible();
  const bodyCell = table.locator("td").nth(1); // second body cell
  await expect(bodyCell.locator("code")).toHaveText("code"); // `code` -> <code> (not literal backticks)
  await expect(bodyCell.locator("a")).toHaveText("lnk");     // [lnk](url) -> <a> (not literal brackets)
  await expect(bodyCell.locator("a")).toHaveAttribute("href", "https://x.test");

  // Same content in the RichUI grid (Ctrl+Enter) must also render code/link (third path — 863 baseline).
  await table.click(); // caret in -> raw
  await sleep(150);
  await page.keyboard.press("Control+Enter");
  const grid = page.getByTestId("table-edit");
  await expect(grid).toBeVisible();
  await expect(grid.locator("td code").first()).toHaveText("code");
  await expect(grid.locator("td a").first()).toHaveText("lnk");
});
