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

  // select "hello" → the bubble appears (auto, no key — the mouse/selection entry)
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  const bubble = page.getByTestId("format-bubble");
  await expect(bubble).toBeVisible();

  // layer-A (inline) only: bold/italic/strike/highlight/code/link — NOT block constructs
  await expect(bubble.getByText("I", { exact: true })).toBeVisible();
  await expect(bubble.getByText("S", { exact: true })).toBeVisible();
  await expect(bubble.getByText("H", { exact: true })).toBeVisible(); // #334: highlight (==) is a layer-A inline format
  expect(await bubble.getByText("• List", { exact: true }).count()).toBe(0); // list (block construct) → palette, not here
  // image (P, insert) is NOT in the on-selection bubble — it lives in the `/` palette, so
  // the on-selection menu is decoration-only and identical across vim (`\`) and non-vim.
  expect(await bubble.getByText("Image", { exact: true }).count()).toBe(0);
  expect(await page.getByTestId("lp-image-btn").count()).toBe(0);

  // clicking B wraps the selection (same command as before — chrome only)
  await bubble.getByText("B", { exact: true }).click();
  await sleep(200);
  await expect
    .poll(async () => page.locator("[data-pane=preview] .cm-content").innerText(), { timeout: 4000 })
    .toContain("**hello**");
});
