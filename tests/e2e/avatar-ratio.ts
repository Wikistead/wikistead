import { expect, type Page } from "@playwright/test";
import { sleep } from "./helpers";

// #284 → shared assertions for the space-avatar initials chip's proportionality. A chip must be a
// clean proportional scale at every call-site size (14px pin row, 18/20px switcher), so the same space looks
// identical everywhere. The VISUAL font/box ratio must be constant. draws the glyph at a fixed 16px and
// shrinks it with `transform: scale()` (floor-exempt), so a browser minimum-font-size floor can't re-break it.
//
// Lives in a non-spec module because Playwright forbids one test file importing another, and the no-floor
// (space-avatar-288) and floor-enforced (space-avatar-floor-1625) specs both need this.

// The visual ratio is read from the inner glyph <span> (fixed font-size + transform scale), not the outer chip
// (which no longer carries a font-size). rendered glyph px = inner font-size × the transform's scaleX.
export const VISUAL_RATIOS = (els: Element[]): number[] =>
  els
    .filter((el) => (el.textContent ?? "").trim().length > 0)
    .map((el) => {
      const inner = el.querySelector("span");
      if (!inner) return NaN;
      const cs = getComputedStyle(inner);
      const scaleX = new DOMMatrix(cs.transform === "none" ? "" : cs.transform).a || 1;
      const visualFont = parseFloat(cs.fontSize) * scaleX; // rendered glyph px (fixed 16px × the shrink scale)
      return visualFont / el.getBoundingClientRect().height; // ÷ the box
    })
    .filter((r) => isFinite(r) && r > 0);

export async function assertConstantChipRatio(page: Page): Promise<void> {
  await page.waitForSelector("[data-testid=space-switcher]");
  await page.click("[data-testid=space-switcher]");
  await expect(page.getByTestId("space-menu")).toBeVisible();
  await sleep(200);
  // Every initials chip (role=img with text — not an uploaded <img>) across the switcher (trigger size vs
  // option-row size are different) must share ONE visual font/box ratio.
  const ratios = await page.locator("[role=img]").evaluateAll(VISUAL_RATIOS);
  expect(ratios.length, "at least two initials chips are on screen").toBeGreaterThanOrEqual(2);
  const spread = Math.max(...ratios) - Math.min(...ratios);
  expect(spread, `visual font/box ratios [${ratios.map((r) => r.toFixed(3)).join(", ")}] must be constant`).toBeLessThan(0.01);
}
