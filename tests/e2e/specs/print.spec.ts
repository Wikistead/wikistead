import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";

// P5 PDF = browser print. (The print dialog / "Save as PDF" is the browser's; what we verify is the
// print stylesheet, which is the substance.)
//
// #505 changed WHAT prints: every reading surface renders its body with CodeMirror, which
// VIRTUALISES its viewport, so printing the live pane printed one screenful. Print now shows a dedicated
// static surface (the PrintSurface portal) and hides the live app entirely — so this file's original
// expectation, "the live .cm-content is visible under print", asserted the very thing that redesign
// removed, and it had been failing on master ever since. It pins the current contract instead: under
// print the app chrome AND the live editor are gone, and the static print surface is what remains.
test("print media shows only the static print surface, hiding the live app and its chrome", async ({ page }) => {
  await openDemo(page);
  await page.emulateMedia({ media: "print" });

  // the live, virtualised editing surface is NOT what gets printed any more
  await expect(page.locator("[data-pane=preview] .cm-content")).toBeHidden();
  // …the static portal is
  await expect(page.locator("[data-print-root]")).toBeVisible();
  // and the app chrome stays out of the sheet
  await expect(page.locator("[data-testid=sidebar]")).toBeHidden();
  await expect(page.locator("[data-testid=comments-panel]")).toBeHidden();
});
