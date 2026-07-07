import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #223 comment 895/910: the fix is on cell link styling (B) + editing-cell paste renders an <a> in place (C). Real Chromium.
// (Copy-side A is unit-tested in link-copy.test — headless can't round-trip a real Ctrl+C→Ctrl+V clipboard.)
test("#223 B: a link inside a rendered table cell is styled as a link (cm-lp-link)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "cell-link-style");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("| A | B |\n| --- | --- |\n| [docs](https://ex.test/d) | 2 |\n\nbelow\n");
  await sleep(500);
  // the static table cell's anchor carries cm-lp-link (so the baseTheme colour+underline apply)
  const anchor = page.locator("[data-pane=preview] table.cm-lp-table a.cm-lp-link").first();
  await expect(anchor).toBeVisible();
  await expect(anchor).toHaveText("docs");
  const deco = await anchor.evaluate((a) => getComputedStyle(a).textDecorationLine);
  expect(deco).toContain("underline");
});

test("#223 C: pasting a URL into an editing cell shows an <a> immediately (not literal [](url))", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "cell-paste-link");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("| A | B |\n| --- | --- |\n| 1 | 2 |\n\nbelow\n");
  await sleep(300);
  await page.locator("[data-pane=preview] table.cm-lp-table").click();
  await sleep(150);
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("table-edit")).toBeVisible();
  const cell = page.getByTestId("table-edit").locator("td").first();
  await cell.dblclick();
  await sleep(100);
  await page.evaluate(() => navigator.clipboard.writeText("https://ex.test/z"));
  await page.keyboard.press("Control+v");
  await sleep(250);
  // an <a> is shown in the editing cell immediately (not the literal [https://…](https://…) text)
  await expect(cell.locator("a")).toHaveAttribute("href", "https://ex.test/z");
});
