import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// M2 (ADR-022 Part 10/11): :::table renders its HTML <table> body (colspan/rowspan) as a
// sanitized table; in vim the caret reveals the raw source (round-trip preserved). We
// author the :::table in VIM (reveal lets you hand-edit the source; non-vim renders
// macros always, so it isn't hand-typed there — it's created by promoting a pipe table).
test(":::table renders the HTML table (merged cell) and reveals raw source in vim", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tablemacro");
  await enterEdit(page);
  await page.getByTestId("vim-toggle").click();
  await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-checked", "true");

  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await page.keyboard.press("i"); // vim insert
  for (const line of [
    ":::table",
    '<table><tr><th>A</th><th>B</th></tr><tr><td colspan="2">merged</td></tr></table>',
    ":::",
    "",
    "below",
  ]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Escape"); // normal; caret is below the block → it renders
  await sleep(300);

  const tbl = page.locator("[data-pane=preview] [data-testid=macro-table]");
  await expect(tbl).toBeVisible();
  await expect(tbl).toContainText("merged");
  expect(await tbl.locator('td[colspan="2"]').count()).toBe(1); // the merge rendered

  // Caret onto the block (gg) → raw HTML source revealed (round-trip preserved).
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await sleep(200);
  const raw = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(raw).toContain(":::table");
  expect(raw).toContain("colspan");
});
