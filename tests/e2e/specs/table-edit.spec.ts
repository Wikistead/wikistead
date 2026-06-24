import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

const tableCount = (p: Page) => p.locator("[data-pane=preview] table.cm-lp-table").count();
const text = (p: Page) => p.locator("[data-pane=preview] .cm-content").innerText();

// ADR-017 core: a rendered block (collapsed widget) must stay editable as Markdown
// SOURCE — the caret enters it (reveal raw) and leaves (re-render). A block widget
// can't be entered by vertical motion, so the `blockEntry` transaction filter redirects
// motion that would SKIP a collapsed block INTO it; the source lines are then real and
// j/k/arrows traverse them one at a time. One mechanism for every block (table, hr,
// future container macros), arrows AND vim alike.
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

test("vim k traverses a table's source line-by-line (no skip / overtake)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-vim");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  for (const l of ["| H | I |", "| --- | --- |", "| a | b |", "", "b0", "b1"]) {
    await page.keyboard.type(l);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.type("b2");
  await page.getByTestId("vim-toggle").click();
  await sleep(300);
  await page.click("[data-pane=preview] .cm-content"); // refocus the editor (toggle took focus)
  await page.keyboard.press("Escape"); // normal mode
  await page.keyboard.type("G"); // last line
  await sleep(200);

  // Press k upward; the table must reveal for as many consecutive steps as it has source
  // rows (3) — i.e. the caret stops on EACH row, never skipping/overtaking the block.
  let revealedRun = 0;
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("k");
    await sleep(110);
    if ((await tableCount(page)) === 0) revealedRun++;
    else if (revealedRun > 0) break; // left the top of the table
  }
  expect(revealedRun).toBeGreaterThanOrEqual(3);
});

test("a horizontal rule is enterable (reveals ***), not skipped", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "hr-edit");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  for (const l of ["top", "", "***", "", "p1", "p2"]) {
    await page.keyboard.type(l);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.type("p3");
  await sleep(300);
  // caret far below → the rule renders (glyph hidden)
  expect(await page.locator("[data-pane=preview] .cm-lp-hr").count()).toBeGreaterThan(0);
  expect(await text(page)).not.toContain("***");
  // arrow up onto the rule line → the `***` source reveals (the caret lands on it,
  // it isn't skipped)
  for (let i = 0; i < 8 && !(await text(page)).includes("***"); i++) {
    await page.keyboard.press("ArrowUp");
    await sleep(110);
  }
  expect(await text(page)).toContain("***");
});
