import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";

// #2: Publish enables the instant the draft diverges — driven by an external store
// (the editor writes it from a DOM `input` listener — NOT a Y.Text observer, which
// regressed presence; only the publish control subscribes), NOT React host state, so
// the editor never re-renders and presence is untouched (foundation.spec covers that).
// A 1.2s budget passes only because of the signal (the persist debounce + poll path
// could not flip the button this fast).
test("publish enables the instant an edit diverges (external dirty signal)", async ({ page }) => {
  await openDemo(page);

  // A fresh page opens in edit mode with an empty draft → nothing to publish yet.
  await page.getByTestId("new-page").click();
  await page.waitForURL(/\/p\/.+edit=1/);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await expect(page.getByTestId("publish-page")).toBeDisabled();

  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("hello");
  await expect(page.getByTestId("publish-page")).toBeEnabled({ timeout: 1200 });
});
