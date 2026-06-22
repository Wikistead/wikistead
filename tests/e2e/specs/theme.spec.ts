import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";

// Phase 3a: personal light/dark/system theme. The choice sets <html data-theme>
// (token CSS + CSS-variable CodeMirror theme follow it) and persists per user.
test("personal theme: switch to dark persists across reload; switch back to light", async ({ page }) => {
  await openDemo(page);
  await page.click("[data-testid=theme-toggle]");
  await page.locator("[data-testid=theme-menu]").getByText("Dark", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.reload();
  await page.waitForSelector("[data-testid=sidebar]");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark"); // persisted

  await page.click("[data-testid=theme-toggle]");
  await page.locator("[data-testid=theme-menu]").getByText("Light", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
