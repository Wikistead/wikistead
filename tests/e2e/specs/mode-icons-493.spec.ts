import { test, expect, type Page } from "@playwright/test";
import { openDemo } from "../helpers";

// #493: the display-mode glyphs, reassigned by meaning. Live moved off Eye (which read as WYSIWYG) to
// Zap (instant); WYSIWYG took Eye (see-what-you-get); Source=Code and Reading=BookOpen are unchanged.
// The account editor tab's display-mode picker also GAINS icons (it had labels only). Pinned by the
// lucide class each glyph carries, on every surface that shows a mode icon.

const iconClassOf = (loc: import("@playwright/test").Locator) =>
  loc.locator("svg").first().getAttribute("class");

test("#493: the account display-mode picker shows the reassigned glyphs", async ({ page }) => {
  await openDemo(page);
  await page.goto("/settings/account/editor");
  await expect(page.getByTestId("account-displaymode-live")).toBeVisible({ timeout: 10000 });

  // live=Zap, source=Code, wysiwyg=Eye — and the picker now HAS icons where it had none
  expect(await iconClassOf(page.getByTestId("account-displaymode-live")), "live is the Zap glyph").toContain("lucide-zap");
  expect(await iconClassOf(page.getByTestId("account-displaymode-source")), "source stays Code").toContain("lucide-code");
  expect(await iconClassOf(page.getByTestId("account-displaymode-wysiwyg")), "wysiwyg is the Eye glyph").toContain("lucide-eye");
  // and crucially NOT the old assignment
  expect(await iconClassOf(page.getByTestId("account-displaymode-live")), "live is no longer Eye").not.toContain("lucide-eye");
});
