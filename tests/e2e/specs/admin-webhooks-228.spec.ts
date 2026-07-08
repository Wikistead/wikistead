import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #228 / ADR-108: the admin webhooks console (tenant-admin only; dev-user is admin in dev mode). Create a
// webhook → the signing secret is shown ONCE → it appears in the list → delete it. Real Chromium.
test("#228: admin creates a webhook (secret shown once), sees it listed, deletes it", async ({ page }) => {
  await openDemo(page);
  await page.goto("/admin/webhooks");
  await expect(page.getByTestId("admin-webhooks")).toBeVisible();

  const url = `https://example.com/hook-${Date.now()}`; // unique per run (avoid leftovers from prior runs)
  await page.getByTestId("webhook-url").fill(url);
  await page.getByTestId("webhook-create").click();

  // The signing secret is shown once.
  await expect(page.getByTestId("webhook-secret")).toBeVisible({ timeout: 8000 });
  // The webhook appears in the list.
  const item = page.getByTestId("webhook-item").filter({ hasText: url }).first();
  await expect(item).toBeVisible({ timeout: 8000 });

  // Delete it → gone.
  await item.getByTestId("webhook-delete").click();
  await sleep(500);
  await expect(page.getByTestId("webhook-item").filter({ hasText: url })).toHaveCount(0);
});
