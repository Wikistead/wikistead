import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #593 (user, on a Mac): the table of contents overflows the window (in the non-floating state).
//
// The rail placed itself against its PARENT and sized itself against the VIEWPORT, and only one of those
// knows the sidebar is 260px wide. The difference is exactly half a sidebar, which is what was measured
// hanging off the right edge: +126px at 1200, +96px at 1440, with item text cut mid-word.
//
// Two things had to be true and neither was: the rail fits inside the window, and when it cannot fit it
// does not appear at all (the old media query asked the viewport, so a window with the sidebar open
// counted as "wide" while the real gutter was 84px — and clamp's 210px floor then guaranteed an
// overflow rather than a fallback).
//
// Real browser, real layout: a rect is the whole subject here.

const HEADINGS = "# One\n\n## Two two two two\n\n### Three three three three three\n\n#### Four four four four\n";

test("#593: the rail never hangs off the right edge, at any width", async ({ page }) => {
  await openScratch(page, "#593 toc rail");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(HEADINGS);
  await sleep(400);

  for (const width of [1200, 1280, 1440, 1680]) {
    await page.setViewportSize({ width, height: 900 });
    await sleep(300);
    const rail = page.getByTestId("toc-rail");
    const shown = await rail.isVisible().catch(() => false);
    if (!shown) continue; // not fitting is a legitimate answer — the overlay takes over
    const box = (await rail.boundingBox())!;
    expect(Math.round(box.x + box.width), `rail overruns the window at ${width}px`).toBeLessThanOrEqual(width);
    expect(box.width, `the rail is at least its minimum at ${width}px`).toBeGreaterThanOrEqual(209);
  }
});

test("#593: when the gutter is too small the rail is absent, not clipped", async ({ page }) => {
  await openScratch(page, "#593 toc fallback");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(HEADINGS);
  await sleep(400);

  // 1200 with the sidebar open leaves ~84px beside the reading column — far under the 210px minimum
  await page.setViewportSize({ width: 1200, height: 900 });
  await sleep(300);
  await expect(page.getByTestId("toc-rail"), "no rail where it cannot fit").toHaveCount(0);

  // and the same document at a width that DOES have room shows it, so the pin above is not vacuous
  await page.setViewportSize({ width: 1900, height: 900 });
  await sleep(400);
  const rail = page.getByTestId("toc-rail");
  await expect(rail, "the rail returns when there is room").toBeVisible({ timeout: 5000 });
  const box = (await rail.boundingBox())!;
  expect(Math.round(box.x + box.width)).toBeLessThanOrEqual(1900);
});
