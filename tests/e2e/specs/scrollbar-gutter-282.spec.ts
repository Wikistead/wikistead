import { test, expect } from "@playwright/test";
import { openDemo, enterEdit, sleep } from "../helpers";

// #282: the editor scroll host reserves a STABLE scrollbar gutter, so a per-keystroke macro RichUI edit
// (whose doc height oscillates across the viewport boundary) can't make a classic vertical scrollbar
// appear/disappear and shift the content width — the right-edge flicker. Headless uses overlay scrollbars,
// so the flicker itself can't be measured here; the load-bearing guard is that the gutter is reserved.
test("#282: the editor scroll host reserves a stable scrollbar gutter", async ({ page }) => {
  await openDemo(page);
  await enterEdit(page);
  await sleep(200);
  const host = page.locator(".lp-editor-host").first();
  await expect(host).toBeVisible();
  const gutter = await host.evaluate((el) => getComputedStyle(el).scrollbarGutter);
  expect(gutter).toContain("stable");
});
