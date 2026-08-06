import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #649: while a second endpoint is being chosen, the days between it and the start are faintly filled.
//
// Measured in a real browser and by COLOUR, not by class names. A grep for the tint class would pass
// against a build where the class exists and nothing renders it, and `getComputedStyle` on the specified
// value would not tell a `color-mix` apart from what it mixes — #632 lost two rounds to exactly that.
// So the predicate is: how many day cells are painted with a fill that is neither transparent nor the
// solid accent of a committed endpoint. That set is the preview.
const PANEL = "[data-testid$=-panel]";

async function openCalendar(page: import("@playwright/test").Page) {
  await page.addInitScript(() => { try { localStorage.setItem("wks.lang", "en"); } catch { /* private mode */ } });
  await openDemo(page);
  await page.goto("/spaces/demo_space/settings/analytics");
  await sleep(1200);
  const trigger = page.locator("[data-testid$=-trigger]").first();
  if (!(await trigger.count())) return false;
  await trigger.click();
  await expect(page.locator(PANEL)).toBeVisible({ timeout: 8_000 });
  return true;
}

/** The days wearing a fill that is neither empty nor the solid endpoint colour. */
async function faintlyFilled(page: import("@playwright/test").Page): Promise<string[]> {
  return page.$$eval("[data-day]", (els) =>
    els
      .filter((el) => {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") return false;
        // a committed endpoint is filled solid; the band is mixed with the surface, so it is not opaque
        const alpha = /rgba?\([^)]*?,\s*([\d.]+)\s*\)$/.exec(bg);
        const opaque = !alpha || parseFloat(alpha[1]!) >= 0.95;
        return !(opaque && el.getAttribute("data-selected") === "true");
      })
      .map((el) => el.getAttribute("data-day")!)
      .sort(),
  );
}

test("#649: choosing the second day shows the range it would make", async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(!(await openCalendar(page)), "analytics is not entitled on this tenant");

  const days = await page.locator("[data-day]").evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-day")!).filter(Boolean));
  expect(days.length, "the grid drew a month").toBeGreaterThan(27);
  // two days a week apart, both inside the drawn month, with room on either side
  const start = days[10]!;
  const later = days[17]!;
  const earlier = days[3]!;

  // nothing is promised before a start is chosen: pointing at a day paints only that day's hover
  await page.hover(`[data-day="${later}"]`);
  await sleep(150);
  const beforeStart = await faintlyFilled(page);
  expect(beforeStart.length, `nothing to preview yet :: ${beforeStart.join(",")}`).toBeLessThanOrEqual(1);

  // choose a start, then point at a LATER day
  await page.click(`[data-day="${start}"]`);
  await sleep(150);
  await page.hover(`[data-day="${later}"]`);
  await sleep(200);
  const forwards = await faintlyFilled(page);
  expect(forwards, `the band covers start→pointer :: ${forwards.join(",")}`).toContain(later);
  expect(
    forwards.filter((d) => d > start && d <= later).length,
    `every day between is painted :: ${forwards.join(",")}`,
  ).toBe(days.filter((d) => d > start && d <= later).length);

  // …and at an EARLIER day: the band runs the other way rather than disappearing
  await page.hover(`[data-day="${earlier}"]`);
  await sleep(200);
  const backwards = await faintlyFilled(page);
  expect(backwards, `pointing before the start still promises a range :: ${backwards.join(",")}`).toContain(earlier);
  expect(backwards, "…and does not keep painting the days after it").not.toContain(later);

  // the band is a promise, not a selection: clicking the earlier day KEEPS both ends
  await page.click(`[data-day="${earlier}"]`);
  await sleep(400);
  const label = await page.locator("[data-testid$=-trigger]").first().innerText();
  expect(label, `both ends survived the backwards pick :: ${label}`).toContain(earlier);
  expect(label, "…and the first click is the other end").toContain(start);
});

test("#649: a keyboard sees the same preview a pointer does", async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(!(await openCalendar(page)), "analytics is not entitled on this tenant");

  const days = await page.locator("[data-day]").evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-day")!).filter(Boolean));
  const start = days[10]!;
  await page.click(`[data-day="${start}"]`);
  await sleep(150);

  // move focus off the pointer's path entirely, then walk with the keyboard
  await page.mouse.move(0, 0);
  await page.locator(`[data-day="${start}"]`).focus();
  for (let i = 0; i < 3; i++) { await page.keyboard.press("ArrowRight"); await sleep(80); }
  await sleep(150);

  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-day"));
  expect(focused, "arrows moved to another day").not.toBe(start);
  const painted = await faintlyFilled(page);
  expect(painted, `the focused day is previewed too :: ${painted.join(",")}`).toContain(focused!);
});
