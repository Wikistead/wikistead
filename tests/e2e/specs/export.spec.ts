import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";

// P5: the Export button downloads the page (a lone page → .md). Content correctness
// + the authz/image/zip-slip guarantees are covered by the server export tests;
// this proves the button → server → browser-download wiring end to end.
test("export button downloads the page as markdown", async ({ page }) => {
  await openDemo(page);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15_000 }),
    page.click("[data-testid=export-page]"),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.(md|zip)$/);
});
