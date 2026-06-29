import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #158-C3 / ADR-052: $…$ inline and $$…$$ block render via KaTeX as atoms; caret-in reveals raw.
test("inline + block math render via KaTeX; caret-in reveals the raw TeX", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "math");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("before $E=mc^2$ after\n\n$$\\int_0^1 x\\,dx$$\n\ntail\n");
  await sleep(400);
  await page.keyboard.press("Control+End"); // caret away from the formulas
  await sleep(200);

  // both render: a KaTeX element exists inside the inline + block math widgets.
  await expect(page.locator("[data-pane=preview] [data-testid=math-inline] .katex").first()).toBeVisible();
  await expect(page.locator("[data-pane=preview] [data-testid=math-block] .katex").first()).toBeVisible();
  // the raw $…$ source is hidden while rendered.
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain("E=mc^2");

  // click into the inline formula → reveal raw TeX (editable), widget drops.
  await page.locator("[data-pane=preview] [data-testid=math-inline]").first().click();
  await sleep(200);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("E=mc^2");
});
