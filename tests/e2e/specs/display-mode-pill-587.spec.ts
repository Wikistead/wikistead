import { test, expect } from "@playwright/test";
import { openScratch, enterEdit } from "../helpers";

// #587 bounce (user, on the device): do not change the floating display-mode pill.
//
// Adopting the DS radiogroup gave this surface arrow keys, roving focus and real `aria-checked` — all
// of which stay — but it also swapped the shape underneath: the 28x28 round segments became the DS
// rectangle (38x26, 5px radius), because `className` only ever reached the container. The two things
// the bounce asks for are separate defects and get separate cases.
//
// Measured, not asserted from the class list: a Tailwind class that does not exist produces no CSS at
// all and a pin on the class name would pass anyway (the trap #580 hit).

const segment = (page: import("@playwright/test").Page, mode: string) =>
  page.getByTestId(`displaymode-${mode}`);

test("#587 ①: the pill's segments are round again, and the DS behaviour stays", async ({ page }) => {
  await openScratch(page, "#587 pill shape");
  await enterEdit(page); // the floating pill lives on the edit surface
  await expect(segment(page, "live")).toBeVisible({ timeout: 15000 });

  const box = await segment(page, "live").boundingBox();
  expect(box, "the segment is laid out").not.toBeNull();
  // 28x28, the geometry this pill had before the DS move. Allow a sub-pixel of layout rounding.
  expect(Math.round(box!.width), `width was ${box!.width}`).toBe(28);
  expect(Math.round(box!.height), `height was ${box!.height}`).toBe(28);

  const radius = await segment(page, "live").evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  // a circle: the radius is at least half the box (Tailwind's rounded-full resolves to a huge value)
  expect(parseFloat(radius), `radius was ${radius}`).toBeGreaterThanOrEqual(14);

  // the DS behaviour the bounce explicitly said to keep
  await expect(segment(page, "live")).toHaveAttribute("aria-checked", "true");
  await segment(page, "live").focus();
  await page.keyboard.press("ArrowRight");
  await expect(segment(page, "source"), "the first arrow press still moves the selection").toHaveAttribute("aria-checked", "true");
});

test("#587 ②: the checked segment is a tab stop from the first paint", async ({ page }) => {
  await openScratch(page, "#587 pill tab stop");
  await enterEdit(page);
  await expect(segment(page, "live")).toBeVisible({ timeout: 15000 });

  // Radix leaves every item at -1 until something is focused, which read on the device as "I cannot
  // reach the pill with Tab at all". Nothing is clicked in this test on purpose.
  const tabIndexes = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="displaymode-"]')].map((el) => el.getAttribute("tabindex")),
  );
  expect(tabIndexes.length, "the pill is on screen").toBeGreaterThan(1);
  expect(tabIndexes.filter((t) => t === "0"), "exactly one tab stop, before any interaction").toHaveLength(1);
  expect(await segment(page, "live").getAttribute("tabindex"), "and it is the checked one").toBe("0");
});
