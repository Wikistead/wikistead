import { test, expect, type Page } from "@playwright/test";

// #582 (final acceptance): wherever a role NAME is offered, pointing at it says what the role
// can do — and the option itself stays one line.
//
// The implementation is #586's (the option reveals on hover and on the arrow-key highlight, because
// Radix drives its list with `data-highlighted` rather than focus). This measures the OTHER half of the
// ruling: that the surfaces THIS ticket is about actually get it. Three rounds of "one screen fixed,
// green" is why the sweep walks the pickers it finds instead of asserting one of them.
async function optionsOf(page: Page, trigger: string): Promise<{ name: string; revealed: string; insideRow?: boolean }[]> {
  const control = page.getByTestId(trigger).first();
  await control.scrollIntoViewIfNeeded();
  await control.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector("[role=option]", { timeout: 5000 });
  // #578 (2026-08-04, flake hunt): the options EXIST before keyboard focus has moved into the listbox,
  // and arrows pressed in that window fall through — the walk then collects only the selected option
  // and the sweep reads as "one role offered". Wait for the focus, not just the DOM.
  await page.waitForFunction(() => document.activeElement?.closest("[role=listbox]") !== null
    || document.activeElement?.getAttribute("role") === "option", undefined, { timeout: 5000 }).catch(() => {});
  const out: { name: string; revealed: string; insideRow?: boolean }[] = [];
  // walk with the arrow keys: that is the highlight the reveal follows, and it is the path a keyboard
  // user takes — a mouse-only measurement would miss a reveal bound to focus alone
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("ArrowDown");
    // RE-AIMED by #582 (2026-08-04): the reveal is a FLOATING panel now, not text inside the option, so
    // it is read from the panel and the option is read for its name alone. Which is also the assertion
    // the ruling cares about: nothing capability-shaped is left in the row.
    const seen = await page.evaluate(() => {
      const item = document.querySelector("[role=option][data-highlighted]") as HTMLElement | null;
      if (!item) return null;
      const panel = document.querySelector("[data-testid$='-hint'], [data-testid='select-hint']") as HTMLElement | null;
      const visible = panel && getComputedStyle(panel).visibility !== "hidden" && panel.getBoundingClientRect().width > 0;
      return {
        name: (item.textContent ?? "").trim(),
        revealed: visible ? (panel!.textContent ?? "").trim() : "",
        insideRow: item.querySelector(".wks-role-caps") !== null,
      };
    });
    if (seen && !out.some((o) => o.name === seen.name)) out.push(seen);
  }
  await page.keyboard.press("Escape");
  return out;
}

test("#582: a role picker offers names, and points at what they confer", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 15_000 });

  // the row's own picker: it is on screen without opening the add flow, and it is the control this
  // ticket's rounds kept coming back to
  const options = await optionsOf(page, "space-member-role-select");
  expect(options.length, `the picker offered roles to walk :: ${JSON.stringify(options)}`).toBeGreaterThan(1);
  // every option is a NAME: no capability list printed into the label itself
  for (const o of options) {
    expect(o.insideRow ?? false, `"${o.name}" draws its capabilities inside the option`).toBe(false);
    expect(o.name.split(/\s+/).length, `"${o.name}" reads as a name, not a list`).toBeLessThan(4);
  }
  // …and at least one of them said what it confers while highlighted (the built-ins all have a
  // measured table; a tenant tier deliberately has none — see role-option-tips.tsx)
  expect(options.some((o) => o.revealed.length > 0), `no option raised a panel: ${JSON.stringify(options)}`).toBe(true);
  // the panel is the SAME one the row badges raise: it names where the capabilities come from and then
  // lists them, rather than being a second design that says the same thing differently
  const withPanel = options.find((o) => o.revealed.length > 0)!;
  expect(withPanel.revealed.length, `the panel carries a heading and the capabilities :: ${withPanel.revealed}`).toBeGreaterThan(4);
});

// #582 (review rejection ②, 2026-08-04): the list was 305–361px wide because the hidden capability text
// reserved room for itself. With the panel floating, the list only needs the names — measured here so
// the width cannot creep back the next time something is put inside an option.
test("#582: the list is as wide as its names, not as wide as an explanation", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 15_000 });
  const control = page.getByTestId("space-member-role-select").first();
  await control.scrollIntoViewIfNeeded();
  await control.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector("[role=option]", { timeout: 5000 });
  const { list, longest } = await page.evaluate(() => {
    const box = document.querySelector("[data-slot=select-content]") as HTMLElement;
    const names = [...document.querySelectorAll("[role=option]")].map((o) => (o.textContent ?? "").trim());
    return { list: Math.round(box.getBoundingClientRect().width), longest: Math.max(...names.map((n) => n.length)) };
  });
  // a generous allowance for padding, the check mark and the font: what this catches is a list sized by
  // a sentence rather than by a word (the reject measured 305px for names of ~9 characters)
  expect(list, `the list is ${list}px for names of at most ${longest} characters`).toBeLessThan(longest * 12 + 80);
  await page.keyboard.press("Escape");
});
