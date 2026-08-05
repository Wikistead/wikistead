import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #641 slice 1: the browser is told which theme it is drawing into.
//
// the theme perfectly — what does not is everything the BROWSER draws for it: the date picker's popup, the
// spinner on a number field, the file-chooser button, scrollbars, the autofill yellow, the caret. Those
// obey `color-scheme`, and with it left at `normal` the browser draws them light no matter what the app
// looks like.
//
// Measured before this: `normal` on `:root` and on every input, in both themes.

/** Every control whose chrome the browser draws itself. Not a list of today's screens — the assertion is
 *  about the TYPE, so a `type="color"` added next month is covered the day it lands. */
const NATIVE_TYPES = ["date", "datetime-local", "month", "week", "time", "number", "file", "color", "range"];

async function schemeOf(page: import("@playwright/test").Page) {
  return page.evaluate((types) => {
    const sel = types.map((t) => `input[type="${t}"]`).join(",");
    const found = [...document.querySelectorAll<HTMLInputElement>(sel)].map((el) => ({
      type: el.type,
      // the COMPUTED value on the control: `color-scheme` inherits, so declaring it on the root is what
      // reaches a control nested anywhere — reading the root alone would not prove it arrived
      scheme: getComputedStyle(el).colorScheme,
    }));
    return { root: getComputedStyle(document.documentElement).colorScheme, found };
  }, NATIVE_TYPES);
}

test("#641: the theme reaches the chrome the browser draws", async ({ page }) => {
  test.setTimeout(120_000);
  await openDemo(page);
  // a screen that actually has native controls — the assertion below refuses to pass without one
  await page.goto("/spaces/demo_space/settings/analytics");
  await page.waitForSelector('input[type="date"]', { timeout: 15_000 });
  await sleep(400);

  // 1. explicit dark, the way the theme switcher sets it
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await sleep(200);
  const dark = await schemeOf(page);
  expect(dark.found.length, "the fixture has native controls to measure").toBeGreaterThan(0);
  expect(dark.root, "the root declares the dark scheme").toBe("dark");
  for (const c of dark.found) expect(c.scheme, `the ${c.type} control draws its chrome dark`).toBe("dark");

  // 2. explicit light
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await sleep(200);
  const light = await schemeOf(page);
  expect(light.root, "…and light when the theme is light").toBe("light");
  for (const c of light.found) expect(c.scheme, `the ${c.type} control draws its chrome light`).toBe("light");

  // 3. following the OS, which is the DEFAULT setting — a fix that only handles `data-theme="dark"`
  // leaves every reader on "system" with the white popup they complained about
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "system"));
  await page.emulateMedia({ colorScheme: "dark" });
  await sleep(200);
  expect((await schemeOf(page)).root, "following the OS into dark").toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await sleep(200);
  expect((await schemeOf(page)).root, "…and back out of it").toBe("light");

  // 4. print stays light whatever the screen is doing — paper is white, and print.css says so already
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.emulateMedia({ media: "print" });
  await sleep(200);
  expect((await schemeOf(page)).root, "print is light even from a dark screen").toBe("light");
  await page.emulateMedia({ media: null, colorScheme: null });
});
