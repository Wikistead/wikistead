import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #413 / ADR-145 §5 (+): tag autocomplete. Real Chromium: the frontmatter chip input opens a
// CUSTOM suggest popup (the native datalist is retired) fed by the view-filtered /tags/suggest, and the
// /tagged palette command opens the tag picker whose suggestion chips insert a complete `:::tagged` atom.

test("#413: the chip input's suggest popup fills with existing tags; the /tagged picker inserts the block", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  // 1. publish a page carrying a distinctive tag so /tags/suggest can offer it
  await openScratch(page, "sug-seed");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("---\ntags: [sugE2E413]\n---\n\nseed body\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(800);

  // 2. a second page: frontmatter chip input → datalist gets the suggestion
  await openScratch(page, "sug-editor");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("---\ntags: []\n---\n\nbody\n");
  await page.keyboard.press("Control+End");
  await sleep(500);
  const input = page.getByTestId("fm-tag-input");
  await expect(input).toBeVisible();
  // FOCUS alone opens the popup with the full view-filtered list (no typing needed)
  await input.click();
  await expect
    .poll(async () => page.locator('[data-testid="fm-tag-suggest-item"]').count(), { timeout: 5000 })
    .toBeGreaterThan(0);
  // typing narrows; the seeded tag stays visible
  await page.keyboard.type("sugE");
  await expect(page.locator('[data-testid="fm-tag-suggest-item"]', { hasText: "sugE2E413" }).first()).toBeVisible({ timeout: 5000 });
  // keyboard: ArrowDown + Enter picks the highlighted suggestion → it becomes a chip
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("fm-tag-suge2e413")).toBeVisible({ timeout: 5000 });
  // the popup carries the app trigger icon (not the UA datalist glyph)
  await expect(page.getByTestId("fm-tag-suggest-open")).toBeVisible();

  // 3. /tagged opens the picker; a suggestion chip inserts the complete block
  await page.keyboard.press("Escape"); // leave the chip input
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("/tagged");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-macro:tagged"]');
  await expect(page.getByTestId("tag-picker-input")).toBeVisible();
  await page.getByTestId("tag-picker-input").fill("sugE2E413".toLowerCase().slice(0, 4));
  await expect(page.getByTestId("tag-suggestion-suge2e413")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("tag-suggestion-suge2e413").click();
  await sleep(500);
  // the inserted :::tagged atom resolves — the seed page appears in the list
  await expect(page.locator('[data-testid^="macro-tagged-item-"]').first()).toBeVisible({ timeout: 10000 });
});
