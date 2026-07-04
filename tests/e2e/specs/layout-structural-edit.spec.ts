import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #213: columns/tabs get a hover +/- bar that ADDS/REMOVES a child :::column / :::tab as a real
// Y.Text edit (not raw hand-typing). Verified in a real browser (the widget + dispatch need real layout).
async function columnsDoc(page: any) {
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n\n::::columns\n:::column\nAAA\n:::\n:::column\nBBB\n:::\n::::\n\nbot\n");
  await sleep(700);
}
test("#213: + adds a column, - removes the last (real Y.Text edit)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const errs: string[] = []; page.on("pageerror", (e) => errs.push(String(e)));
  await openScratch(page, "layout213"); await enterEdit(page);
  await columnsDoc(page);
  await page.getByText("bot").click(); await sleep(200); // caret out → the widget renders
  const before = await page.locator("[data-pane=preview] .cm-lp-column").count();
  expect(before).toBe(2);
  await page.locator("[data-pane=preview] .cm-lp-columns").hover(); await sleep(150);
  await page.locator("[data-pane=preview] [data-testid=layout-add-column]").click({ force: true }); await sleep(300);
  await page.getByText("bot").click(); await sleep(200);
  expect(await page.locator("[data-pane=preview] .cm-lp-column").count()).toBe(3);
  await page.locator("[data-pane=preview] .cm-lp-columns").hover(); await sleep(150);
  await page.locator("[data-pane=preview] [data-testid=layout-remove-column]").click({ force: true }); await sleep(300);
  await page.getByText("bot").click(); await sleep(200);
  expect(await page.locator("[data-pane=preview] .cm-lp-column").count()).toBe(2);
  expect(errs, errs.join(" | ")).toHaveLength(0);
});
