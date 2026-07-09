import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #305 (B-): a TRULY inline image (text shares its line) renders as a line-height thumbnail so a large
// natural size no longer occupies the whole line width and pushes the surrounding text onto new visual rows
// ("a newline got inserted"). A STANDALONE image (its own line) stays a full-size atom (#255, unchanged). The
// bytes don't load for a made-up attachment id, but the display CONVENTION (the max-height cap applied to the
// inline widget and NOT the standalone one) is what this asserts — the visual no-wrap with a real large image
// is a review. Both the Live edit surface and the read-only view surface use the same widget/CSS.
test("#305: an inline image is a line-height thumbnail; a standalone image stays full-size", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  await openScratch(page, "inline-img-305");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // line 1: text + inline image + text (the reported case). line 3: a standalone image (its own line).
  await page.keyboard.insertText("before ![a](wks-attachment:fake-a) after\n\n![b](wks-attachment:fake-b)\n");
  await sleep(400);

  // the INLINE image carries the thumbnail modifier and its max-height is capped near the line height (not none).
  const inline = page.locator("[data-pane=preview] img.cm-lp-image-inline").first();
  await expect(inline).toBeVisible();
  const inlineMax = await inline.evaluate((el) => getComputedStyle(el).maxHeight);
  expect(inlineMax, `inline max-height ${inlineMax} should be a small thumbnail cap`).not.toBe("none");
  expect(parseFloat(inlineMax), `inline max-height ${inlineMax} px`).toBeGreaterThan(0);
  expect(parseFloat(inlineMax), `inline max-height ${inlineMax} px should be ~1 line, not a full image`).toBeLessThan(48);
  //(the review bounce): sizing alone is NOT enough — the Tailwind preflight sets
  // img { display: block }, which forces the line break even for a correctly-sized thumbnail. The
  // computed display must be overridden to an inline flavour (assertable without loading real bytes).
  const inlineDisplay = await inline.evaluate((el) => getComputedStyle(el).display);
  expect(inlineDisplay, `inline image display ${inlineDisplay} must flow with text, not break the line`).toBe("inline-block");

  // the STANDALONE image (inside cm-lp-image-wrap) is NOT capped — it keeps the full-size atom look (#255).
  const standalone = page.locator("[data-pane=preview] .cm-lp-image-wrap img.cm-lp-image").first();
  await expect(standalone).toBeVisible();
  await expect(standalone).not.toHaveClass(/cm-lp-image-inline/);
  const standaloneMax = await standalone.evaluate((el) => getComputedStyle(el).maxHeight);
  expect(standaloneMax, "standalone image must NOT be thumbnail-capped").toBe("none");
  const standaloneDisplay = await standalone.evaluate((el) => getComputedStyle(el).display);
  expect(standaloneDisplay, "standalone image stays a block (centred full-size atom)").toBe("block");
});
