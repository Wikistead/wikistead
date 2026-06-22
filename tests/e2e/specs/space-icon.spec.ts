import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";

// #4 space icon: every space shows a visual with no input — the switcher renders a
// deterministic initials chip auto-generated from the name ("Demo Space" → "DS").
test("the space switcher shows an auto-generated initials icon", async ({ page }) => {
  await openDemo(page);
  const icon = page.getByTestId("space-icon");
  await expect(icon).toBeVisible();
  await expect(icon).toHaveText(/^DS$/); // initials of "Demo Space"
  expect(await icon.locator("img").count()).toBe(0); // auto = initials, not an image
});

// The General settings tab lets a manager override the icon with an emoji, with a live
// preview that updates as you type (the save round-trip itself is server-tested).
test("space settings has an icon override with a live preview", async ({ page }) => {
  await page.goto("/spaces/demo_space/settings/general");
  const input = page.getByTestId("space-icon-input");
  await expect(input).toBeVisible();
  const preview = page.getByTestId("space-icon-preview");
  // Auto first (initials), then the typed emoji takes over verbatim.
  await expect(preview).toHaveText(/^DS$/);
  await input.fill("📚");
  await expect(preview).toHaveText("📚");
});
