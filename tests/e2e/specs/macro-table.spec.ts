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

// #5 (the real toggle path): a rich-editable macro revealed under the caret in vim must
// RE-RENDER when you switch to non-vim — WITHOUT moving the caret. Toggling vim is a
// Compartment reconfigure (no doc/selection change), so the livePreview field has to
// rebuild on the vimEnabled facet change. (Earlier this regressed: the macro stayed raw.)
test("vim→non-vim re-renders the cursor-under rich macro without moving the caret", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "modeswitch");
  await enterEdit(page);
  await page.getByTestId("vim-toggle").click();
  await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-checked", "true");

  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await page.keyboard.press("i");
  for (const line of [
    ":::table",
    "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
    ":::",
  ]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("g"); // caret onto the block → vim reveals raw source
  await sleep(250);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-table]")).toHaveCount(0);

  // Toggle vim OFF — do NOT touch the caret. The macro must render (non-vim = always render).
  await page.getByTestId("vim-toggle").click();
  await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-checked", "false");
  await sleep(250);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-table]")).toBeVisible();
});
