import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";

// Group C motion REGRESSION guard. The first motion pass silently did nothing in the
// browser: CSS-modules hashed `animation-name: wks-pop` to a nonexistent keyframe, so
// menus/dialogs/panels never animated. Class/token EXISTENCE tests missed it. These
// assert the motion actually RESOLVES via computed style — a hashed/missing keyframe
// or a dropped transition fails here.
//
// (Playwright Chromium defaults to prefers-reduced-motion: no-preference, i.e. motion
// ON — so the a11y kill switch is not in effect here.)

test("hover transitions are wired (computed transition-duration is non-zero)", async ({ page }) => {
  await openDemo(page);
  // Any shared Button — the edit toggle is always present in read mode.
  const dur = await page.getByTestId("edit-toggle").evaluate((el) => getComputedStyle(el).transitionDuration);
  // tokens: --dur-fast = 120ms. The button transitions several properties, so the
  // computed value is a list ("0.12s, 0.12s, ..."). It must contain 0.12s and must NOT
  // be the all-zero "0s" a reduce-motion kill or a missing transition would yield.
  expect(dur).toContain("0.12s");
  expect(dur).not.toBe("0s");
});

test("menu open animation resolves to a real keyframe (not a hashed/missing name)", async ({ page }) => {
  await openDemo(page);
  await page.click("[data-testid=space-switcher]");
  const menu = page.locator("[data-testid=space-menu]");
  await menu.waitFor();
  const anim = await menu.evaluate((el) => {
    const s = getComputedStyle(el);
    return { name: s.animationName, duration: s.animationDuration };
  });
  // The menu (now Radix DropdownMenu) animates via shadcn/tw-animate-css `animate-in`.
  // What matters: a REAL keyframe resolves and runs — not "none" (missing/hashed) and
  // not a zero duration (a reduce-motion kill or dropped animation).
  expect(anim.name).not.toBe("none");
  expect(anim.duration).not.toBe("0s");
});
