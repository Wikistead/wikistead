import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

const tableCount = (p: Page) => p.locator("[data-pane=preview] table.cm-lp-table").count();
const hrCount = (p: Page) => p.locator("[data-pane=preview] .cm-lp-hr").count();
const text = (p: Page) => p.locator("[data-pane=preview] .cm-content").innerText();
const head = (p: Page) => p.evaluate(() => (window as Window & { __lpHeadLine?: number }).__lpHeadLine);

// ADR-017 core: a rendered block (collapsed widget) must stay editable as Markdown
// SOURCE — the caret traverses its lines ONE AT A TIME (no skip / overtake), revealing
// raw source, and re-renders on leave. A block widget can't be entered by vertical
// motion, so `blockEntry` redirects motion that would skip a collapsed block INTO it.
// One mechanism for every block (table, hr, future macros), arrows AND vim alike.

// Build: A0 / blank / table(3-5) / blank / B0 / B1 / B2(9). Caret ends on line 9.
async function buildTable(page: Page) {
  await page.click("[data-pane=preview] .cm-content");
  for (const l of ["A0", "", "| H | I |", "| --- | --- |", "| a | b |", "", "B0", "B1"]) {
    await page.keyboard.type(l);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.type("B2");
  await sleep(300);
}

test("arrows traverse a table's source line-by-line (no skip / overtake)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tbl-arrow");
  await enterEdit(page);
  await buildTable(page);
  await expect.poll(() => tableCount(page), { timeout: 4000 }).toBe(1); // rendered (caret far)

  const heads: (number | undefined)[] = [];
  const revealed: number[] = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("ArrowUp");
    await sleep(110);
    heads.push(await head(page));
    revealed.push(await tableCount(page));
  }
  // EVERY line visited in order — no jump over the collapsed table
  expect(heads).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  // table revealed exactly while the caret is on its rows (lines 5,4,3 = indices 3,4,5)
  expect(revealed).toEqual([1, 1, 1, 0, 0, 0, 1, 1]);
});

test("vim k traverses a table's source line-by-line (no skip / overtake)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tbl-vim");
  await enterEdit(page);
  await buildTable(page);
  await page.getByTestId("vim-toggle").click();
  await sleep(300);
  await page.click("[data-pane=preview] .cm-content"); // refocus (toggle button took focus)
  await page.keyboard.press("Escape"); // normal mode
  await page.keyboard.type("G"); // last line
  await sleep(200);

  const heads: (number | undefined)[] = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("k");
    await sleep(110);
    heads.push(await head(page));
  }
  expect(heads).toEqual([8, 7, 6, 5, 4, 3, 2, 1]); // one line per k, through the table
});

test("table source is editable in place, and re-renders on leave", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tbl-edit");
  await enterEdit(page);
  await buildTable(page);
  await expect.poll(() => tableCount(page), { timeout: 4000 }).toBe(1);

  // navigate up into the table header (line 3) via the keyboard, then edit the first
  // cell safely (insert inside it — keeps the table valid)
  for (let i = 0; i < 8 && (await head(page)) !== 3; i++) {
    await page.keyboard.press("ArrowUp");
    await sleep(110);
  }
  expect(await head(page)).toBe(3);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("X");
  await sleep(200);
  expect(await text(page)).toContain("XH");

  // leave → re-renders
  for (let i = 0; i < 10 && (await tableCount(page)) === 0; i++) {
    await page.keyboard.press("ArrowDown");
    await sleep(110);
  }
  await expect.poll(() => tableCount(page), { timeout: 4000 }).toBe(1);
});

test("horizontal rule: rule shown when away, raw *** (no rule) when caret on it", async ({ browser }) => {
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
  // caret far below → the rule renders, the glyph is hidden
  expect(await hrCount(page)).toBe(1);
  expect(await text(page)).not.toContain("***");

  // arrow up onto the rule line (line 3) → raw *** revealed AND the rule is gone
  for (let i = 0; i < 8 && (await head(page)) !== 3; i++) {
    await page.keyboard.press("ArrowUp");
    await sleep(110);
  }
  expect(await head(page)).toBe(3);
  expect(await text(page)).toContain("***");
  expect(await hrCount(page)).toBe(0); // the actual rule disappears while editing the source

  // move away → the rule comes back, glyph hidden again
  await page.keyboard.press("ArrowUp");
  await sleep(150);
  expect(await hrCount(page)).toBe(1);
  expect(await text(page)).not.toContain("***");
});
