import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";
import { assertConstantChipRatio } from "../avatar-ratio";

// #284the REAL failure was device-only — Chrome's minimum-font-size setting (ja/CJK locales default it to
// ~10px) clamped a sub-10px chip font UP, re-breaking the constant font/box ratio the fractional font had
// fixed. A headless run with no floor stayed green, so the bug slipped through. This file launches Chromium WITH
// that floor (`--blink-settings=minimumFontSize=10`) and asserts the ratio is STILL constant — which only holds
// because the glyph is now drawn at a fixed 16px (above the floor) and shrunk with a `transform: scale()` that the
// floor is exempt from. With the old fractional-font-size approach this spread would be ~0.044+ under the floor.
//
// The floor is a browser-launch (blink-settings) flag, so `test.use({ launchOptions })` forces a new worker and
// must be top-level in the file — hence this separate spec (the no-floor ratio test stays in space-avatar-288).
test.use({ launchOptions: { args: ["--blink-settings=minimumFontSize=10"] } });

test("#284chip ratio stays constant even under a 10px font floor", async ({ page }) => {
  await openDemo(page);
  // sanity: the floor is actually in effect for this browser (a tiny-font probe is clamped up to >= 10px).
  const clamped = await page.evaluate(() => {
    const p = document.createElement("span");
    p.style.fontSize = "4px";
    p.textContent = "x";
    document.body.appendChild(p);
    const fs = parseFloat(getComputedStyle(p).fontSize);
    p.remove();
    return fs;
  });
  expect(clamped, "the minimumFontSize floor is active for this browser").toBeGreaterThanOrEqual(9.5);
  await assertConstantChipRatio(page);
});
