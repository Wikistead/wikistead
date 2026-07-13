import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";
import { assertConstantChipRatio } from "../avatar-ratio";

const API = "http://dev.localhost:4010";

// #288: a space avatar's initials chip must be a STABLE, single-glyph square — a digit-led CJK name like
// "246 " used to render "2" (mixed half+full-width) which stretched the chip and, without
// whitespace-nowrap, wrapped to two stacked rows that overflow-hidden then clipped. Real Chromium (a layout
// concern happy-dom can't measure).
test("#288: a digit+CJK space name renders a single-glyph, square, non-wrapping chip", async ({ page }) => {
  await openDemo(page);
  const name = `246 被リンク警告の確認 ${Date.now().toString(36)}`;
  await page.evaluate(async ({ api, name }) => {
    await fetch(`${api}/spaces`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
  }, { api: API, name });
  await page.reload();
  await page.waitForSelector("[data-testid=space-switcher]");
  await sleep(400);

  await page.click("[data-testid=space-switcher]");
  await expect(page.getByTestId("space-menu")).toBeVisible();
  const option = page.getByTestId("space-option").filter({ hasText: "被リンク警告" }).first();
  await expect(option).toBeVisible();
  const chip = option.locator('[role=img]').first();

  // the monogram is ONE glyph (the meaningful CJK), not the mixed-width "2".
  expect((await chip.innerText()).trim()).toBe("被");
  // the chip is (near-)square — the initials never stretched it wide.
  const box = (await chip.boundingBox())!;
  expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(2);
  // the glyph is on ONE line — no wrap overflow (scrollHeight within the box height).
  const wrapped = await chip.evaluate((el) => el.scrollHeight > el.clientHeight + 2);
  expect(wrapped).toBe(false);
});

// #284 → a space chip must be a clean proportional scale at every call-site size — the VISUAL font/
// box ratio (rendered glyph size ÷ box) must be constant so the same space looks identical at 14px (pin row) and
// 18/20px (switcher). removed Math.round; draws the glyph at a fixed 16px and shrinks it with a
// transform so the browser minimum-font-size floor can't re-clamp it. The floor-enforced counterpart is in
// space-avatar-floor-1625.spec.ts (a `test.use({ launchOptions })` font floor forces a new worker, which
// Playwright only allows at file top level). The shared ratio assertion lives in ../avatar-ratio.
test("#284 space chip visual font/box ratio is constant across sizes", async ({ page }) => {
  await openDemo(page);
  await assertConstantChipRatio(page);
});
// The floor-enforced (#284) counterpart lives in space-avatar-floor-1625.spec.ts — a `test.use({ launchOptions })`
// for the font floor forces a new worker and Playwright only allows it at file top level, so it needs its own file.
