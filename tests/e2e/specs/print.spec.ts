import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";

// P5 PDF = browser print. Under print media, only the rendered page surface shows;
// all app chrome is hidden. (The actual print dialog / "Save as PDF" is the
// browser's; we verify the print stylesheet, which is the substance.)
test("print media shows only the rendered page, hiding app chrome", async ({ page }) => {
  await openDemo(page);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("[data-pane=preview] .cm-content")).toBeVisible();
  // sidebar + comments panel are visibility:hidden under print (not visible).
  await expect(page.locator("[data-testid=sidebar]")).toBeHidden();
  await expect(page.locator("[data-testid=comments-panel]")).toBeHidden();
});
