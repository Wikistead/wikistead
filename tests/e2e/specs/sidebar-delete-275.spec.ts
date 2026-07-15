import { test, expect } from "@playwright/test";
import { openScratch, sleep } from "../helpers";

// #275: deleting the CURRENTLY-OPEN page from the sidebar ⋯ menu used to be silent — no toast, and the
// (now-404) page body lingered as a ghost because the route never navigated away. The sidebar path now
// mirrors the page-⋯ path: a success toast + navigate home when the deleted page is the open one. Real
// Chromium.
test("#275: sidebar-deleting the open page toasts and navigates away (no ghost)", async ({ page }) => {
  const id = await openScratch(page, `del-${Date.now().toString(36)}`);
  await expect(page).toHaveURL(new RegExp(`/p/${id}`));

  // Open the page's row ⋯ menu in the sidebar and choose Delete.
  const row = page.locator("[data-testid=sidebar] [data-testid=tree-page-name]").first();
  await row.hover();
  await page.locator("[data-testid=sidebar] [data-testid=page-actions]").first().click();
  await page.locator("[data-testid=page-menu]").getByText(/move to trash/i).first().click(); // #411 the soft-delete entry label

  // Confirm the delete.
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-delete").click();
  await sleep(800);

  // The delete succeeded (row gone from the tree) …
  await expect(page.locator("[data-testid=sidebar] [data-testid=tree-page-name]")).toHaveCount(0);
  // … a success toast appeared …
  await expect(page.locator("[data-sonner-toast]").first()).toBeVisible({ timeout: 5000 });
  // … and the URL left the deleted page (no ghost body).
  await expect(page).not.toHaveURL(new RegExp(`/p/${id}(\\?|$)`));
});
