import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";

// Phase 5 #6: inline page-title rename from the toolbar (edit-capable users).
// Click the title → edit → commit reuses updatePage (page#edit gated server-side),
// consistent with the sidebar ••• Rename. Renames demo and restores it, so later
// specs that match "Demo Page" are unaffected.
test("editable title renames the page from the toolbar and updates the tree", async ({ page }) => {
  await openDemo(page);

  await page.getByTestId("page-title").click();
  await page.getByTestId("page-title-input").fill("Renamed Demo");
  await page.getByTestId("page-title-input").press("Enter");

  // Toolbar title reflects the rename, and so does the sidebar tree.
  await expect(page.getByTestId("page-title")).toHaveText("Renamed Demo");
  await expect(page.locator("[data-testid=tree-page]", { hasText: "Renamed Demo" })).toBeVisible();

  // Restore the seed name for later specs.
  await page.getByTestId("page-title").click();
  await page.getByTestId("page-title-input").fill("Demo Page");
  await page.getByTestId("page-title-input").press("Enter");
  await expect(page.getByTestId("page-title")).toHaveText("Demo Page");
});
