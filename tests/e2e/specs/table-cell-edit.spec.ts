import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #154 (was #86): cell TEXT editing IN-EDITOR (no modal). A click on the table enters
// render-active → the inline table editor mounts INSIDE CodeMirror on an atom root
// (contenteditable=false, ADR-054 focus delegation), so the nested cell holds focus and CM
// doesn't reclaim it. Double-click a cell → contenteditable IN PLACE. Enter commits the cell
// DIRECTLY to the doc (one Y.Text edit via host.replaceSource — there is no Save button);
// Shift+Enter inserts an in-cell newline (<br>) which promotes the table to :::table; paste is
// forced to text/plain. Escape (when not typing in a cell) exits edit mode → the static render.
async function openTableInline(page: any) {
  await page.click("[data-pane=preview] .cm-content");
  for (const l of ["| A | B |", "| --- | --- |", "| 1 | 2 |", "", "below"]) { await page.keyboard.type(l); await page.keyboard.press("Enter"); }
  await sleep(250);
  await page.locator("[data-pane=preview] table.cm-lp-table").click();
  // The inline editor mounts inside .cm-content — NO modal overlay.
  await expect(page.getByTestId("table-edit")).toBeVisible();
  expect(await page.getByTestId("macro-modal").count()).toBe(0);
}

test("double-click a cell → type → Enter commits the new text to the doc (stays a pipe table)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "celledit");
  await enterEdit(page);
  await openTableInline(page);

  const cell = page.getByTestId("table-edit").locator("td").first(); // body cell "1"
  await cell.dblclick();
  await page.keyboard.press("Shift+Home"); // select the existing "1"
  await page.keyboard.type("hello");
  await page.keyboard.press("Enter"); // commit the cell → the doc (no Save)
  await sleep(200);
  await page.keyboard.press("Escape"); // exit edit mode → static render
  await sleep(200);

  // span/style-free → still a plain pipe table; the first body cell now reads "hello".
  await expect(page.locator("[data-pane=preview] [data-testid=macro-table]")).toHaveCount(0);
  const tbl = page.locator("[data-pane=preview] table.cm-lp-table");
  await expect(tbl).toBeVisible();
  await expect(tbl.locator("td").first()).toHaveText("hello");
});

test("Shift+Enter inserts an in-cell newline → promotes to :::table with a <br>", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "cellnewline");
  await enterEdit(page);
  await openTableInline(page);

  const cell = page.getByTestId("table-edit").locator("td").first();
  await cell.dblclick();
  await page.keyboard.press("Shift+Home");
  await page.keyboard.type("x");
  await page.keyboard.press("Shift+Enter"); // in-cell newline
  await page.keyboard.type("y");
  await page.keyboard.press("Enter"); // commit the cell → the doc
  await sleep(200);
  await page.keyboard.press("Escape"); // exit edit mode → static render
  await sleep(200);

  // a newline is pipe-inexpressible → :::table HTML with a <br> inside the cell.
  const macroTable = page.locator("[data-pane=preview] [data-testid=macro-table]");
  await expect(macroTable).toBeVisible();
  expect(await macroTable.locator("td br").count()).toBeGreaterThanOrEqual(1);
  await expect(macroTable.locator("td").first()).toContainText("x");
  await expect(macroTable.locator("td").first()).toContainText("y");
});

test("Escape while editing a cell discards the typed text (stays in edit mode)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "celldiscard");
  await enterEdit(page);
  await openTableInline(page);

  const cell = page.getByTestId("table-edit").locator("td").first();
  await cell.dblclick();
  await page.keyboard.press("Shift+Home");
  await page.keyboard.type("DISCARDME");
  await page.keyboard.press("Escape"); // cancel the cell edit (NOT the whole editor)
  await sleep(200);
  // still IN the inline editor (Escape cancelled only the cell), and the cell reverted to "1".
  await expect(page.getByTestId("table-edit")).toBeVisible();
  await expect(page.getByTestId("table-edit").locator("td").first()).toHaveText("1");

  await page.keyboard.press("Escape"); // now exit the editor → static render
  await sleep(200);
  const tbl = page.locator("[data-pane=preview] table.cm-lp-table");
  await expect(tbl.locator("td").first()).toHaveText("1");
});
