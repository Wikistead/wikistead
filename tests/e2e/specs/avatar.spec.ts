import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";

// #3 user avatar: the header user-menu trigger renders an avatar (not the old generic
// person icon). The dev user has no OIDC picture, so it must fall back to a
// deterministic initials chip — i.e. it shows text, not an <img>.
test("the header shows a user avatar with initials fallback (no picture)", async ({ page }) => {
  await openDemo(page);
  const avatar = page.getByTestId("user-avatar");
  await expect(avatar).toBeVisible();
  // Initials fallback for "dev-user" → "DE"; never an <img> when there's no picture.
  await expect(avatar).toHaveText(/^DE$/);
  expect(await avatar.locator("img").count()).toBe(0);
  // Opening the menu still works (avatar is the trigger).
  await page.getByTestId("user-menu").click();
  await expect(page.getByTestId("user-menu-content")).toBeVisible();
});
