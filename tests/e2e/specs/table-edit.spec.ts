import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

const tableCount = (p: Page) => p.locator("[data-pane=preview] table.cm-lp-table").count();
const text = (p: Page) => p.locator("[data-pane=preview] .cm-content").innerText();

// ADR-017 core: a rendered table (a collapsed block widget) must stay editable as
// Markdown SOURCE — the cursor can enter it (reveal raw) and leave (re-render). A
// block widget can't be entered by vertical motion, so the block reveals when the
// cursor is on it OR an adjacent line. This is what makes "macros are editable text
// under the cursor" hold for multi-line blocks; future container macros reuse it.
test("a rendered table is enterable + editable as source, and re-renders on leave", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-edit");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // table, a blank line to end it, then paragraphs so the caret can sit far below
  for (const l of ["| H | I |", "| --- | --- |", "| a | b |", "", "p1", "p2", "p3"]) {
    await page.keyboard.type(l);
    await page.keyboard.press("Enter");
  }
  // caret is far below → the table renders as an HTML table
  await expect.poll(() => tableCount(page), { timeout: 4000 }).toBe(1);

  // navigate UP with the keyboard until the table reveals (proves a block widget is
  // reachable by vertical motion — the bug was that the caret skipped over it)
  for (let i = 0; i < 8 && (await tableCount(page)) > 0; i++) {
    await page.keyboard.press("ArrowUp");
    await sleep(120);
  }
  expect(await tableCount(page)).toBe(0); // revealed
  expect(await text(page)).toContain("| H | I |"); // raw source shown

  // edit the source in place, deterministically + safely: go to the header row (a table
  // line, so it stays revealed), step INTO the first cell and insert text — this keeps
  // the table valid (editing the delimiter row would break it).
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("X");
  await sleep(200);
  expect(await text(page)).toContain("XH"); // the source cell was edited

  // leave: move the caret far below again → the (still valid) table re-renders
  for (let i = 0; i < 10 && (await tableCount(page)) === 0; i++) {
    await page.keyboard.press("ArrowDown");
    await sleep(120);
  }
  await expect.poll(() => tableCount(page), { timeout: 4000 }).toBe(1);
});
