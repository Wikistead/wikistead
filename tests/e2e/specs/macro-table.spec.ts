import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// M2 (ADR-022 Part 10): :::table renders its HTML <table> body (with colspan/rowspan)
// as a sanitized table; the ::: fence reveals raw on the cursor; source round-trips; and
// since it's a richEditUI=inline macro, the caret shows the "<key> edit" hint.
test(":::table renders the HTML table (merged cell), reveals raw, round-trips, hints", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tablemacro");
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
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
  await sleep(400);

  // Renders as a sanitized table with the merged (colspan=2) cell.
  const tbl = page.locator("[data-pane=preview] [data-testid=macro-table]");
  await expect(tbl).toBeVisible();
  await expect(tbl).toContainText("merged");
  expect(await tbl.locator('td[colspan="2"]').count()).toBe(1); // the merge rendered

  // vim ON: caret onto the block reveals the raw HTML source (round-trip preserved) +
  // shows the edit hint. (Non-vim click enters edit mode instead — covered elsewhere.)
  await page.getByTestId("vim-toggle").click();
  await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-checked", "true");
  await tbl.click();
  await sleep(200);
  await expect(page.getByTestId("macro-edit-hint")).toBeVisible();
  const raw = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(raw).toContain(":::table");
  expect(raw).toContain("colspan");
});
