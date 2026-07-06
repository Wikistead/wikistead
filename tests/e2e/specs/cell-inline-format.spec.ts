import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #89: the in-cell inline-decoration toolbar (bold/italic/strike/code/link) for a table cell being edited.
// Real-Chromium coverage for the comment-886 fixes: (②) the Link button opens a URL popover so a real
// destination can be entered, and (③) a mark spanning an in-cell <br> decorates BOTH lines (per-line wrap).
async function openRichUICell(page: any) {
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("| A | B |\n| --- | --- |\n| 1 | 2 |\n\nbelow\n");
  await sleep(300);
  await page.locator("[data-pane=preview] table.cm-lp-table").click();
  await sleep(150);
  await page.keyboard.press("Control+Enter"); // pipe x Live RichUI opt-in
  await expect(page.getByTestId("table-edit")).toBeVisible();
}
// Select the whole contents of an editing cell (the toolbar shows on a non-collapsed in-cell selection).
async function selectCell(cell: any) {
  await cell.evaluate((el: HTMLElement) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

test("#89 comment 886 (②): cell Link toolbar opens a URL popover → inserts a real [text](url)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "cell-link");
  await enterEdit(page);
  await openRichUICell(page);
  const cell = page.getByTestId("table-edit").locator("td").first(); // body cell "1"
  await cell.dblclick(); // enter edit
  await sleep(100);
  await selectCell(cell);
  await sleep(150);
  await expect(page.getByTestId("cell-format-bar")).toBeVisible();
  await page.getByTestId("cell-format-link").click();
  await expect(page.getByTestId("cell-link-popover")).toBeVisible();
  await page.getByTestId("cell-link-url").fill("https://example.com/z");
  await page.keyboard.press("Enter"); // sent to the focused input (which closePopover removes on confirm)
  await sleep(200);
  await expect(cell.locator("a")).toHaveAttribute("href", "https://example.com/z"); // real destination set
  await expect(cell.locator("a")).toHaveText("1");
});

test("#89 comment 886 (③): a mark spanning an in-cell <br> decorates BOTH lines (per-line wrap)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "cell-multiline");
  await enterEdit(page);
  await openRichUICell(page);
  const cell = page.getByTestId("table-edit").locator("td").first();
  await cell.dblclick();
  await sleep(100);
  await selectCell(cell);
  await page.keyboard.type("one");
  await page.keyboard.press("Shift+Enter"); // in-cell <br>
  await page.keyboard.type("two");
  await sleep(100);
  await selectCell(cell); // select "one<br>two"
  await sleep(150);
  await expect(page.getByTestId("cell-format-bar")).toBeVisible();
  await page.getByTestId("cell-format-bold").click();
  await sleep(200);
  // per-line wrap → two <strong>, not one <strong> spanning the <br> (which would break the source round-trip).
  await expect(cell.locator("strong")).toHaveCount(2);
  await expect(cell.locator("br")).toHaveCount(1);
});
