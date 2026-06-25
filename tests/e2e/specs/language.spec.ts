import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";

// Phase 5: the language switcher. Japanese is core to positioning, so reaching it
// must be one click in the header (not a config edit). The choice persists across
// reloads (localStorage). Playwright gives each test a fresh context, so the
// default here is English (browser locale en-US).
test("header language switcher toggles the UI to Japanese and persists across reload", async ({ page }) => {
  await openDemo(page);
  // Default English. The floating Edit control is icon-only (its label is the i18n'd
  // aria-label / hover tooltip), so assert the accessible label, not text content.
  await expect(page.getByTestId("edit-toggle")).toHaveAttribute("aria-label", "Edit");

  // Switch to Japanese via the header switcher.
  await page.getByTestId("language-toggle").click();
  await page.getByTestId("language-ja").click();
  await expect(page.getByTestId("edit-toggle")).toHaveAttribute("aria-label", "編集");
  // <html lang> follows the choice.
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe("ja");

  // Persists across a full reload (no re-selection needed).
  await page.reload();
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await expect(page.getByTestId("edit-toggle")).toHaveAttribute("aria-label", "編集");
});
