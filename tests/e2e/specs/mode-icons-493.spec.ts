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

// #493(review rejection): the editor-chrome card's per-mode CHECKBOX rows enumerate the
// same four modes right below the displayMode picker — they must carry the same glyphs. The testid sits
// on the checkbox control; the glyph lives in the row's label span, so pin on the enclosing label row.
test("#493the editor-chrome mode checkboxes show the same glyphs", async ({ page }) => {
  await openDemo(page);
  await page.goto("/settings/account/editor");
  await expect(page.getByTestId("account-chrome-mode-live")).toBeVisible({ timeout: 10000 });

  // NOT iconClassOf/svg.first(): a checked row's first svg is the checkbox's own Check glyph.
  const rowOf = (m: string) =>
    page.locator("label", { has: page.getByTestId(`account-chrome-mode-${m}`) });
  await expect(rowOf("live").locator("svg.lucide-zap"), "chrome live row has the Zap glyph").toHaveCount(1);
  await expect(rowOf("source").locator("svg.lucide-code"), "chrome source row has the Code glyph").toHaveCount(1);
  await expect(rowOf("reading").locator("svg.lucide-book-open"), "chrome reading row has the BookOpen glyph").toHaveCount(1);
  await expect(rowOf("wysiwyg").locator("svg.lucide-eye"), "chrome wysiwyg row has the Eye glyph").toHaveCount(1);
});
