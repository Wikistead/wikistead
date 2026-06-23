import { test, expect } from "@playwright/test";
import { openDemo, enterEdit, resetDoc, sleep } from "../helpers";

// The format toolbar is a FLOATING selection bubble (Notion/Medium style), not an
// always-on ribbon: hidden with no selection, shown above a text selection. The
// command behaviour is unchanged — clicking B bolds the selection.
test("format toolbar floats on selection and bolds", async ({ page }) => {
  await openDemo(page);
  await enterEdit(page);
  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("hello world");
  await sleep(200);

  // no selection → no ribbon
  await expect(page.getByTestId("format-bubble")).toBeHidden();

  // select "hello" → the bubble appears
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect(page.getByTestId("format-bubble")).toBeVisible();

  // clicking B wraps the selection (same command as before — chrome only)
  await page.getByTestId("format-bubble").getByText("B", { exact: true }).click();
  await sleep(200);
  await expect
    .poll(async () => page.locator("[data-pane=preview] .cm-content").innerText(), { timeout: 4000 })
    .toContain("**hello**");
});
