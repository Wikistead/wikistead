import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #278 §1 (was #213): columns/tabs structure ops are PER-ITEM inline affordances on the rendered cells now
// each column/tab has a hover `×` that removes THAT item (not just the last) and a trailing `` adds one,
// each a real Y.Text edit. Verified in a real browser (the widget + dispatch need real layout).
async function columnsDoc(page: any) {
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n\n::::columns\n:::column\nAAA\n:::\n:::column\nBBB\n:::\n::::\n\nbot\n");
  await sleep(700);
}
const cols = (page: any) => page.locator("[data-pane=preview] [data-testid=macro-columns] .cm-lp-column");

test("#278 §1: a per-item × removes THAT column (not the last); a trailing ＋ adds one", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const errs: string[] = []; page.on("pageerror", (e) => errs.push(String(e)));
  await openScratch(page, "layout278"); await enterEdit(page);
  await columnsDoc(page);
  await page.getByText("bot").click(); await sleep(200); // caret out → the widget renders
  await expect(cols(page)).toHaveCount(2);

  // remove the FIRST column via its own × → the SECOND (BBB) survives (proves remove-AT, not remove-last).
  const removes = page.locator("[data-pane=preview] [data-testid=layout-remove-column]");
  await expect(removes).toHaveCount(2);
  await removes.nth(0).click({ force: true }); await sleep(300);
  await page.getByText("bot").click(); await sleep(200);
  await expect(cols(page)).toHaveCount(1);
  await expect(cols(page).first()).toContainText("BBB");
  await expect(cols(page).first()).not.toContainText("AAA");

  // add via the trailing → back to 2 columns.
  await page.locator("[data-pane=preview] [data-testid=macro-columns]").hover(); await sleep(150);
  await page.locator("[data-pane=preview] [data-testid=layout-add-column]").click({ force: true }); await sleep(300);
  await page.getByText("bot").click(); await sleep(200);
  await expect(cols(page)).toHaveCount(2);
  expect(errs, errs.join(" | ")).toHaveLength(0);
});
