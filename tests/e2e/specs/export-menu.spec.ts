import { test, expect } from "@playwright/test";
import { openScratch } from "../helpers";

// #85: the export overflow menu must offer BOTH Markdown and HTML (the bounce was that only Markdown
// was reachable). This asserts both items render in the ⋯ menu on a member page.
test("the ⋯ menu offers both Markdown and HTML export", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "export-menu");

  await page.click("[data-testid=page-overflow-trigger]");
  await expect(page.getByTestId("export-page")).toBeVisible(); // Export as Markdown
  await expect(page.getByTestId("export-page-html")).toBeVisible(); // Export as HTML
});
