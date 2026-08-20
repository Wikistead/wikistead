import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #641 slice 1: the browser is told which theme it is drawing into.
//
// In dark mode the calendar icon is hard to see, and the calendar is glaring white. The input itself
// follows the theme perfectly — what does not is everything the BROWSER draws for it: the date
// picker's popup, the
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
  // #641this used to wait for the analytics screen's `input[type="date"]`, which was the only
  // native-chrome control it could find. Those boxes are gone on purpose — they were the entrance to
  // Chrome's own date popup, the shabby-looking one — and no screen in this fixture renders a VISIBLE
  // native-typed control any more (the moderation ones are gated, the file inputs are hidden).
  //
  // Deleting the pin would have been wrong: the declaration still governs scrollbars, the caret, autofill
  // and select chrome, and the claim worth keeping is that it REACHES a control rather than merely
  // existing on the root. So the probe is injected. That is not a weaker subject — inheritance from
  // `:root` is the entire mechanism, and a probe measures it for a type nothing on screen has yet, which
  // is the case this pin was written for ("a `type=color` added next month").
  // any rendered screen will do — what is under test is inheritance from `:root`, which does not depend
  // on which page the control happens to be on
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 20_000 });
  await page.evaluate((types) => {
    const host = document.createElement("div");
    host.id = "scheme-probe";
    for (const t of types) {
      const i = document.createElement("input");
      i.type = t;
      host.appendChild(i);
    }
    document.body.appendChild(host);
  }, NATIVE_TYPES);
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

// #641/the product does not open the browser's own date picker any more.
//
// The boxy corners and white frame were Chrome's date popup, not this product's panel — and while a
// `type="date"` field is on screen, it is one keystroke away (F4, Alt+Down) whether or not its calendar
// icon is hidden. So the assertion is about the TYPE, which is the only thing that closes that door.
//
// Written as a sweep over the analytics surfaces rather than over the two fields that used to be there:
// a `type="date"` added to this screen next month is the same defect returning.
test("#641: no analytics surface carries a native date control", async ({ page }) => {
  test.setTimeout(120_000);
  await openDemo(page);
  for (const url of ["/spaces/demo_space/settings/analytics", "/admin/analytics"]) {
    await page.goto(url);
    await sleep(1200);
    // The fields live INSIDE the panel now, and a Radix popover does not render its content until it is
    // opened — so a sweep of the closed page finds nothing and passes whatever the fields are. Measured:
    // putting `type="date"` back left this green. Open it first.
    const trigger = page.locator("[data-testid$=-trigger]").first();
    if (await trigger.count()) {
      await trigger.click();
      await expect(page.locator("[data-testid$=-panel]").first()).toBeVisible({ timeout: 8_000 });
    }
    const native = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement>("input")]
        .filter((i) => ["date", "datetime-local", "month", "week"].includes(i.type))
        .map((i) => ({ type: i.type, testid: i.getAttribute("data-testid") })));
    expect(native, `${url} still opens the browser's own picker: ${JSON.stringify(native)}`).toEqual([]);
  }
});
