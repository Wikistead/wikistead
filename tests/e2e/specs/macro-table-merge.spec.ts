import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// M2 (ADR-022 Part 10): cell-merge mouse editing. A GFM pipe table (Tier 1) → toggle
// edit (Ctrl+Enter) → select cells → Merge → PROMOTES to a :::table (HTML colspan). Then
// edit the :::table → Unmerge → auto-DEMOTES back to a pipe table.
test("pipe table → merge promotes to :::table → unmerge demotes back", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tablemerge");
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
  for (const line of ["| A | B |", "| --- | --- |", "| 1 | 2 |", "", "below"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(300);

  // The pipe table renders (Tier 1 — not a :::table macro yet).
  await expect(page.locator("[data-pane=preview] table.cm-lp-table")).toBeVisible();
  expect(await page.locator("[data-pane=preview] [data-testid=macro-table]").count()).toBe(0);

  // Non-vim: a click enters edit mode (cell-merge toolbar) — no Ctrl+Enter (#5).
  await page.locator("[data-pane=preview] table.cm-lp-table").click(); await sleep(150); await page.keyboard.press("Control+Enter"); // #216: pipe×Live RichUI = Ctrl+Enter opt-in
  const edit = page.getByTestId("table-edit");
  await expect(edit).toBeVisible();

  // Rectangular drag-select across the two body cells, then Merge → promote.
  const c0 = (await edit.locator("td").nth(0).boundingBox())!;
  const c1 = (await edit.locator("td").nth(1).boundingBox())!;
  await page.mouse.move(c0.x + c0.width / 2, c0.y + c0.height / 2);
  await page.mouse.down();
  await page.mouse.move(c1.x + c1.width / 2, c1.y + c1.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.getByTestId("table-merge").click();
  await sleep(200);

  // #154: merge commits per-op (host.replaceSource) — no Save. Escape exits the in-editor edit
  // mode; the promoted :::table then renders with a colspan=2 cell.
  await page.keyboard.press("Escape");
  await sleep(200);
  const macroTable = page.locator("[data-pane=preview] [data-testid=macro-table]");
  await expect(macroTable).toBeVisible();
  expect(await macroTable.locator('td[colspan="2"]').count()).toBe(1);

  // Now demote: click the :::table (enters edit), select the merged cell, Unmerge.
  await macroTable.click();
  await expect(page.getByTestId("table-edit")).toBeVisible();
  await page.getByTestId("table-edit").locator('td[colspan="2"]').click();
  await page.getByTestId("table-unmerge").click();
  await sleep(200);

  await page.keyboard.press("Escape"); // #154: per-op commit; Escape exits edit mode
  await sleep(200);
  // Demoted: no more :::table macro; a plain pipe table renders again.
  expect(await page.locator("[data-pane=preview] [data-testid=macro-table]").count()).toBe(0);
  await expect(page.locator("[data-pane=preview] table.cm-lp-table")).toBeVisible();
});
