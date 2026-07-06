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

// #216 comment 836: a pipe (Tier1) table in LIVE must show a VISIBLE RichUI-entry button on hover, so a
// non-vim mouse user can reach the rich editor without knowing Ctrl+Enter. Subtle (hidden until hover),
// top-left, tooltip names the shortcut; clicking it opens the in-editor rich table editor.
test("#216: a pipe table in Live shows a hover RichUI-entry button that opens the rich editor", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-richui-btn");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("| Name | Age |\n| --- | --- |\n| Alice | 30 |\n\nbelow\n");
  await sleep(400);
  const table = page.locator("[data-pane=preview] table.cm-lp-table");
  await expect(table).toBeVisible();
  const btn = page.getByTestId("table-richui-enter");
  await expect(btn).toHaveCount(1); // present in the DOM…
  await expect(btn).toHaveAttribute("title", /Ctrl\+Enter/); // …with the shortcut hint in its tooltip
  expect(await btn.evaluate((el) => getComputedStyle(el).opacity)).toBe("0"); // invisible to the eye until hover
  // comment 853: hover the TABLE (what a user does) → the button becomes opaque AND is anchored at the
  // table's top-left CORNER (inside its box, so it's on-screen and reachable), then a REAL click (no force,
  // through the hover) opens the RichUI — proving it's genuinely reachable, not just opacity-toggled.
  await table.hover();
  await sleep(150);
  expect(await btn.evaluate((el) => getComputedStyle(el).opacity)).toBe("1"); // now visible to the eye
  const tb = (await table.boundingBox())!;
  const bb = (await btn.boundingBox())!;
  expect(bb.x).toBeGreaterThanOrEqual(tb.x - 2); // at the table's top-left corner, inside its box
  expect(bb.y).toBeGreaterThanOrEqual(tb.y - 2);
  expect(bb.x).toBeLessThan(tb.x + tb.width);
  expect(bb.width).toBeGreaterThan(0); // a real, sized, hit-testable button
  await btn.click(); // real click (no force) through the hover → reachable
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
