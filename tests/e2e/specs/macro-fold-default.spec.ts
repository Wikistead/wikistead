import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// M2 (ADR-022 Part 5): a LARGE fence-macro block defaults to folded on load, so a long
// document stays skimmable. Auto-fold runs once after the initial collab sync — so we
// type a big block, let it persist, RELOAD (the content arrives over the provider), and
// assert it comes back folded. (A block typed during a session is NOT folded out from
// under the cursor — that's why we test via reload.)
test("a large macro block auto-folds on load", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "folddefault");
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
  const body = ["graph TD;"];
  for (let i = 0; i < 12; i++) body.push(`N${i}-->N${i + 1};`); // > 10 lines → over threshold
  for (const line of ["```mermaid", ...body, "```", "", "below"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  // Typed during the session → NOT auto-folded (renders, or stays as source under cursor).
  await sleep(1500); // let the draft persist to the collab server

  await page.reload();
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await enterEdit(page);

  // On reload the synced content auto-folds the large block → the summary line shows.
  await expect(page.locator("[data-pane=preview] [data-testid=macro-folded]")).toBeVisible({ timeout: 10000 });
  await expect(page.locator("[data-pane=preview] [data-testid=macro-folded]")).toContainText("Mermaid diagram");
});
