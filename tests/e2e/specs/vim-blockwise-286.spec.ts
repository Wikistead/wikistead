import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

const ranges = (p: import("@playwright/test").Page) => p.evaluate(() => (window as any).__lpRanges as { from: number; to: number }[]);

// #286: vim blockwise visual (Ctrl+V) selects a RECTANGLE — one selection range per line. The editor used
// minimalSetup, which omits allowMultipleSelections, so codemirror-vim's per-line ranges were collapsed to
// one (only the caret line was selected). Enabling the facet (plus bailing the single-range selection
// guards on a multi-range selection) restores the rectangle. Real Chromium + vim.
test("#286: Ctrl+V blockwise visual makes a multi-range rectangle; v stays single-range", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "blockwise");
  await enterEdit(page);
  await page.getByTestId("vim-toggle").click();
  await page.click("[data-pane=preview] .cm-content");

  // type four lines, back to normal, go to the top-left
  await page.keyboard.press("i");
  await page.keyboard.type("aaaa\nbbbb\ncccc\ndddd");
  await page.keyboard.press("Escape");
  await page.keyboard.type("gg0");

  // blockwise visual, extend down 3 lines + right 1 column → a 4-row rectangle
  await page.keyboard.press("Control+v");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await page.keyboard.press("l");
  await sleep(200);
  const block = await ranges(page);
  expect(block.length, "blockwise visual spans one range per line").toBeGreaterThanOrEqual(4);
  // every range is non-empty (each covers the rectangle's column span on its line)
  expect(block.every((r) => r.to > r.from)).toBe(true);

  // charwise `v` is a SINGLE contiguous range (non-regression)
  await page.keyboard.press("Escape");
  await page.keyboard.type("gg0");
  await page.keyboard.press("v");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await sleep(200);
  const char = await ranges(page);
  expect(char.length, "charwise v stays one range").toBe(1);
});
