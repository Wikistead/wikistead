import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #641 / ADR-218 slice 2: the analytics range is picked from a calendar this product draws.
//
// Measured in a real browser because the two claims that matter cannot be measured anywhere else:
// keyboard reachability needs focus delegation and layout (happy-dom has neither), and "drawn by the
// app rather than by the browser" is a question about computed colour.
const PANEL = "[data-testid$=-panel]";

async function openAnalytics(page: import("@playwright/test").Page, lang = "en") {
  await page.addInitScript((l) => { try { localStorage.setItem("wks.lang", l); } catch { /* private */ } }, lang);
  await openDemo(page);
  await page.goto("/spaces/demo_space/settings/analytics");
  await sleep(1200);
}

test("#641: the calendar is the app's, and a keyboard can reach every day", async ({ page }) => {
  test.setTimeout(180_000);
  await openAnalytics(page);

  const trigger = page.locator("[data-testid$=-trigger]").first();
  test.skip(!(await trigger.count()), "analytics is not entitled on this tenant");
  await trigger.click();
  await expect(page.locator(PANEL)).toBeVisible({ timeout: 8_000 });

  // drawn by the app: the panel wears the product's surface tokens rather than a browser default. A
  // native date popup is not in the document at all, so its very presence in the DOM is the claim.
  const painted = await page.locator(PANEL).evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, border: cs.borderTopWidth, radius: cs.borderTopLeftRadius };
  });
  expect(painted.bg, `the panel has a surface :: ${JSON.stringify(painted)}`).not.toBe("rgba(0, 0, 0, 0)");
  expect(parseFloat(painted.radius), "…with the product's rounding").toBeGreaterThan(0);

  // a keyboard reaches the grid and moves within it. The grid is ONE tab stop (a roving cell), so what
  // is measured is that arrows move focus between days rather than that forty-two tab stops exist.
  const first = page.locator("[data-day]").first();
  await first.focus();
  const before = await page.evaluate(() => document.activeElement?.getAttribute("data-day"));
  expect(before, "a day holds focus").toBeTruthy();
  await page.keyboard.press("ArrowRight");
  await sleep(200);
  const after = await page.evaluate(() => document.activeElement?.getAttribute("data-day"));
  expect(after, `ArrowRight moved to another day (${before} → ${after})`).not.toBe(before);
  expect(new Date(after!).getTime() - new Date(before!).getTime(), "…exactly one day").toBe(86_400_000);

  await page.keyboard.press("ArrowDown");
  await sleep(200);
  const week = await page.evaluate(() => document.activeElement?.getAttribute("data-day"));
  expect(new Date(week!).getTime() - new Date(after!).getTime(), "ArrowDown moves a week").toBe(7 * 86_400_000);

  // and choosing with the keyboard sets the range
  await page.keyboard.press("Enter");
  await sleep(400);
  const fromValue = await page.locator("[data-testid$=-from]").first().inputValue();
  expect(fromValue, `Enter picked the focused day (${week})`).toBe(week);
});

test("#641: a range is two clicks in one open panel", async ({ page }) => {
  test.setTimeout(180_000);
  // The ruling was "the first click starts, the second closes". On a device it was one click per open:
  // picking a date changes the query key, the row of controls lived inside the loading branch, and so the
  // calendar the reader was clicking in was unmounted underneath them. What is measured is therefore not
  // the panel's own state machine — that was always right — but that the ROW SURVIVES a refetch.
  await openAnalytics(page);
  const trigger = page.locator("[data-testid$=-trigger]").first();
  test.skip(!(await trigger.count()), "analytics is not entitled on this tenant");

  // watch for the controls being torn out, for as long as the interaction lasts
  await page.evaluate(() => {
    (window as unknown as { __ctrlGone: number }).__ctrlGone = 0;
    const seen = document.querySelector("[data-testid$=-controls]");
    new MutationObserver(() => {
      if (seen && !seen.isConnected) (window as unknown as { __ctrlGone: number }).__ctrlGone++;
    }).observe(document.body, { childList: true, subtree: true });
  });

  await trigger.click();
  await expect(page.locator(PANEL)).toBeVisible({ timeout: 8_000 });
  const days = page.locator("[data-day]");
  const start = (await days.nth(8).getAttribute("data-day"))!;
  const end = (await days.nth(12).getAttribute("data-day"))!;

  await days.nth(8).click();
  await sleep(1200); // long enough for the refetch that used to take the panel with it
  await expect(page.locator(PANEL), `the panel closed after the first click of a range (${start})`)
    .toBeVisible();

  await days.nth(12).click();
  await sleep(800);
  await expect(page.locator(PANEL), "…and the second click closes it").toBeHidden({ timeout: 4_000 });

  // #641the typed fields moved INSIDE the panel (the row now has one entrance, and the two
  // `type="date"` boxes that opened Chrome's own picker are gone). The panel is closed at this point, so
  // reading them means opening it again — the range they hold is the assertion, not where they live.
  await trigger.click();
  await expect(page.locator(PANEL)).toBeVisible({ timeout: 8_000 });
  const [from, to] = await Promise.all([
    page.locator("[data-testid$=-from]").first().inputValue(),
    page.locator("[data-testid$=-to]").first().inputValue(),
  ]);
  expect({ from, to }, "two clicks made one range").toEqual({ from: start, to: end });
  expect(await page.evaluate(() => (window as unknown as { __ctrlGone: number }).__ctrlGone),
    "the controls were never unmounted while the reader was using them").toBe(0);
});

test("#641: the month and weekday names follow the app's language", async ({ page }) => {
  test.setTimeout(180_000);
  // Not "a name appears" — that is true of any language and stays true if the formatter is deleted and
  // replaced with a constant. The claim is that the names CHANGE with the language.
  await openAnalytics(page, "en");
  const trigger = page.locator("[data-testid$=-trigger]").first();
  test.skip(!(await trigger.count()), "analytics is not entitled on this tenant");
  await trigger.click();
  await expect(page.locator(PANEL)).toBeVisible({ timeout: 8_000 });
  const en = await page.locator("[data-testid$=-month]").first().textContent();
  const enDays = await page.locator(PANEL).evaluate((el) =>
    [...el.querySelectorAll("span")].slice(0, 7).map((s) => s.textContent).join(","));

  await page.context().clearCookies();
  await openAnalytics(page, "ja");
  await page.locator("[data-testid$=-trigger]").first().click();
  await expect(page.locator(PANEL)).toBeVisible({ timeout: 8_000 });
  const ja = await page.locator("[data-testid$=-month]").first().textContent();
  const jaDays = await page.locator(PANEL).evaluate((el) =>
    [...el.querySelectorAll("span")].slice(0, 7).map((s) => s.textContent).join(","));

  expect(ja, `the month name changed with the language (en: ${en} / ja: ${ja})`).not.toBe(en);
  expect(jaDays, `and so did the weekday names (en: ${enDays} / ja: ${jaDays})`).not.toBe(enDays);
});
