import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// M2 acceptance (ADR-022 Part 5): vim `za`/`zo` toggle a macro fold. M1 built fold on
// CodeMirror native folding + a foldService for macro fences specifically so vim's fold
// commands work for free; this confirms it (the JIS `\`-style "verify it actually maps"
// check).
test("vim za/zo fold and unfold a macro block", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "vimfold");
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
  for (const line of ["```mermaid", "graph TD; A-->B;", "```", "", "below"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(300);

  // vim on.
  await page.getByTestId("vim-toggle").click();
  await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-checked", "true");

  // Put the caret on a line inside the macro fence (clicking the rendered block places
  // the caret at the block start → its source is revealed), then NORMAL mode.
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").click();
  await sleep(150);
  await page.keyboard.press("Escape");

  // za → fold: the block collapses to the summary line.
  await page.keyboard.press("z");
  await page.keyboard.press("a");
  await sleep(200);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-folded]")).toBeVisible();

  // zo → unfold: the summary is gone (the source/diagram is back).
  await page.keyboard.press("z");
  await page.keyboard.press("o");
  await sleep(200);
  expect(await page.locator("[data-pane=preview] [data-testid=macro-folded]").count()).toBe(0);
});
