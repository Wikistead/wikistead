import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

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

// #284 a space chip must be a clean proportional scale at every call-site size. The Avatar font size
// was Math.round(size*0.42), so the font/box ratio drifted (0.40–0.444) and the same space's chip looked
// different at 14px (pin row) vs 18/20px (switcher). Removing the round makes the ratio EXACTLY constant.
test("#284 space chip font/box ratio is constant across sizes (no rounding drift)", async ({ page }) => {
  await openDemo(page);
  await page.waitForSelector("[data-testid=space-switcher]");
  await page.click("[data-testid=space-switcher]");
  await expect(page.getByTestId("space-menu")).toBeVisible();
  await sleep(200);
  // Every initials chip (role=img with text — not an uploaded <img>) across the switcher (trigger size vs
  // option-row size are different) must share ONE font/box ratio.
  const ratios = await page.locator("[role=img]").evaluateAll((els) =>
    els
      .filter((el) => (el.textContent ?? "").trim().length > 0)
      .map((el) => { const cs = getComputedStyle(el); return parseFloat(cs.fontSize) / parseFloat(cs.height); })
      .filter((r) => isFinite(r) && r > 0),
  );
  expect(ratios.length, "at least two initials chips are on screen").toBeGreaterThanOrEqual(2);
  const spread = Math.max(...ratios) - Math.min(...ratios);
  expect(spread, `font/box ratios [${ratios.map((r) => r.toFixed(3)).join(", ")}] must be constant`).toBeLessThan(0.01);
});
