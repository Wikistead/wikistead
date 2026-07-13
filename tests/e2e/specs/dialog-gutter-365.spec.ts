import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #365: at a MID width (below a wide picker's `sm:max-w-5xl`, above `sm`) the base DialogContent's narrow cap
// governs. It used to be `max-w-[calc(100%-2rem)]` → a dialog sat 16px from the screen edge ("gutter too
// narrow"). Now `calc(100%-4rem)` (2rem/side) keeps it off the edge. Measured on the real search modal (a wide
// `sm:max-w-5xl` picker) at an 800px viewport. Real Chromium — a geometry assert, no happy-dom layout engine.
test("#365: a wide picker keeps a comfortable side gutter at a mid width", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await openDemo(page);
  if ((await page.getByTestId("search-input").count()) === 0) await page.getByTestId("search-trigger").click();
  await page.waitForSelector("[data-slot=dialog-content]", { timeout: 5000 });
  await sleep(200); // let the open animation settle so the box is final

  const content = page.locator("[data-slot=dialog-content]");
  const box = (await content.boundingBox())!;
  expect(box).not.toBeNull();
  // 4rem total gutter, centered → ~2rem (32px) each side. Assert ≥ 24px (the old 16px would fail — the pin) and
  // that the right side matches (centered, off both edges).
  expect(box.x).toBeGreaterThanOrEqual(24);
  const rightGap = 800 - (box.x + box.width);
  expect(rightGap).toBeGreaterThanOrEqual(24);
});
