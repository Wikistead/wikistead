import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #238 (review follow-up): with the vim caret ON a block-atom (table / `:::`), switching Live →
// WYSIWYG WITHOUT moving the caret must apply cm-wys-blank-fatcursor (so the fat cursor doesn't paint the
// atom's hidden `|`/`:`), and switching back must clear it. The earlier guard only reacted to a
// selection/doc change, so a mode switch left the class un-applied (bug) / stuck (symmetric). Real
// Chromium (the fat cursor is a separate render layer). Assert the CLASS, not colour — a non-focused
// editor's fat cursor is transparent regardless (harness note in comment 943).
test("#238: mode switch (Live→WYSIWYG) toggles the blank-fatcursor class with a static vim caret", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "wys-mode-switch");
  await enterEdit(page);
  // vim ON
  await page.getByTestId("vim-toggle").click().catch(async () => {
    await page.locator("[data-testid=vim-toggle], [aria-label*=vim i]").first().click();
  });
  await sleep(200);

  // Seed a doc ending in a pipe-table atom. insertText (NOT char-by-char) — typing `:::`/`|` char by
  // char fights auto-close/caret-guard and corrupts the doc (comment 943 harness note).
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("i"); // insert mode
  await page.keyboard.insertText("top line\n\n| a | b |\n| - | - |\n| c | d |");
  await page.keyboard.press("Escape"); // normal
  await sleep(200);

  // Park the vim caret ON the table (G → last line, which is inside the table block range).
  await page.keyboard.type("G");
  await sleep(150);

  const hasBlank = () => page.locator("[data-pane=preview] .cm-editor.cm-wys-blank-fatcursor").count();

  // In LIVE, a pipe table REVEALS to raw when the caret is inside it (the `|` under the cursor is REAL
  // text — blanking it would be the opposite bug), so `blocks` doesn't contain the caret → no blank.
  await expect.poll(hasBlank, { timeout: 4000 }).toBe(0);

  // In WYSIWYG the table is a RENDERED widget (never revealed) → the fat cursor would paint the hidden
  // `|`, so the blank class applies. The mode-switch transition must (re)compute this without a caret move.
  await page.getByTestId("displaymode-wysiwyg").click();
  await sleep(400);
  await expect.poll(hasBlank, { timeout: 4000 }).toBeGreaterThan(0);

  // Source shows raw text → class clears.
  await page.getByTestId("displaymode-source").click();
  await sleep(400);
  await expect.poll(hasBlank, { timeout: 4000 }).toBe(0);

  // Back to WYSIWYG → applied again (transition recompute).
  await page.getByTestId("displaymode-wysiwyg").click();
  await sleep(400);
  await expect.poll(hasBlank, { timeout: 4000 }).toBeGreaterThan(0);
});
