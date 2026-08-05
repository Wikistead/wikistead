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
  // #578 (2026-08-04, flake hunt): the options EXIST before keyboard focus has moved into the listbox,
  // and arrows pressed in that window fall through — the walk then collects only the selected option and
  // the sweep reads as "one role offered".
  //
  // That wait used to end in `.catch( => {})`, which made the precondition ADVISORY: when focus never
  // arrived the walk ran anyway and produced a one-item answer, so the test failed with "the picker
  // offered 1 role" — a sentence about the product for what is really a harness timing miss. Measured
  // green alone, red inside a batch, on identical code and data. The open is retried now, and if focus
  // never lands the failure SAYS SO instead of blaming the picker.
  let inList = false;
  for (let attempt = 0; attempt < 3 && !inList; attempt++) {
    await control.focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector("[role=option]", { timeout: 5000 });
    inList = await page.waitForFunction(() => document.activeElement?.closest("[role=listbox]") !== null
      || document.activeElement?.getAttribute("role") === "option", undefined, { timeout: 3000 })
      .then(() => true, () => false);
    if (!inList) { await page.keyboard.press("Escape"); await page.waitForTimeout(200); }
  }
  if (!inList) throw new Error(`${trigger}: keyboard focus never entered the listbox — the walk below would collect one option and read as a product defect`);
  const out: { name: string; revealed: string; insideRow?: boolean }[] = [];
  // Start from the TOP, not from wherever the value happens to be. Radix opens with the highlight on the
  // selected item, so a walk that only goes down never revisits anything above it: with the first row
  // already `admin`, this sweep collected one option and passed, and the built-ins it exists to check
  // were never pointed at (measured in the #582 review). ArrowUp rather than Home because it needs no
  // assumption about which keys the listbox implements, and it stops at the first item on its own.
  for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowUp");
  // Read, THEN move — the first item is already highlighted after the rewind, and a loop that pressed
  // first would skip it (the same off-by-one that hid the built-ins before).
  for (let i = 0; i < 12; i++) {
    if (i > 0) await page.keyboard.press("ArrowDown");
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

// #582 (review rejection,/): . The reveal
// was bound to the open list, so the closed row — the thing a reader looks at when they want to know what
// someone can do, before deciding whether to change it — stayed silent. Both states are the acceptance, so
// both are measured here, and the panel raised by the closed control must be the SAME element as the one
// the open list raises (a second implementation is what every round of this ticket has refused).
async function panelOnHover(page: Page, trigger: string): Promise<{ text: string; testId: string | null }> {
  const control = page.getByTestId(trigger).first();
  await control.scrollIntoViewIfNeeded();
  await control.hover();
  // the panel is raised from a pointer event, so give the frame that paints it a moment
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("[data-testid$='-hint'], [data-testid=select-hint]");
    const visible = panel && getComputedStyle(panel).visibility !== "hidden" && panel.getBoundingClientRect().width > 0;
    return { text: visible ? (panel!.textContent ?? "").trim() : "", testId: panel?.getAttribute("data-testid") ?? null };
  });
}

for (const [where, url, ready, trigger] of [
  ["the space members row", "/spaces/demo_space/settings/members", "space-members", "space-member-role-select"],
  ["the tenant members row", "/admin/members", "members-filter", "member-role-select"],
] as const) {
  test(`#582: ${where} says what the current role confers WITHOUT being opened`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(url);
    await expect(page.getByTestId(ready)).toBeVisible({ timeout: 15_000 });

    const closed = await panelOnHover(page, trigger);
    expect(closed.text, `hovering the closed control raised nothing :: ${JSON.stringify(closed)}`).not.toBe("");

    // Counted WHILE the pointer is on the control — that is when the reader is looking. The old count ran
    // after the list had been opened and closed again, when nothing is showing, so it could only ever have
    // passed. (Measured on this master before the fix: hovering one row raised THREE panels — the select's
    // own, and RoleTip's twice.)
    const whileHovering = await visibleDisclosures(page);
    expect(whileHovering, `one hover, one panel — saw ${JSON.stringify(whileHovering)}`).toHaveLength(1);

    // …and opening it still works, from the same element, with the same panel (not a second one that
    // happens to look similar)
    const open = await optionsOf(page, trigger);
    expect(open.some((o) => o.revealed.length > 0), `the open list stopped revealing: ${JSON.stringify(open)}`).toBe(true);
  });
}

// What the READER sees, not what one implementation calls itself.
//
// The count above used to look for `-hint` alone — the panel `ui/Select` raises — so the SECOND panel it
// exists to forbid (RoleTip's Radix tooltip, `-content`) was never counted, and one hover showing two
// windows passed green. That was found on the device, not here. Both families are counted now, and
// "visible" is measured as geometry: a tooltip that has closed stays in the DOM.
async function visibleDisclosures(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-testid$='-hint'], [data-testid=select-hint], [data-testid$='-content']"))
      .filter((el) => {
        const r = (el as HTMLElement).getBoundingClientRect()
        return r.width > 0 && r.height > 0 && getComputedStyle(el as HTMLElement).visibility !== "hidden"
      })
      .map((el) => el.getAttribute("data-testid") ?? "?"))
}

// " — measured on the device as member and
// admin staying silent while the custom roles explained themselves.
//
// The tenant picker gets the same walk as the space one, and the assertion is over EVERY option it
// offers rather than over the two that were silent that day: a picker that grows a third mechanism
// without a capability source fails here.
test("#579: every option in the TENANT picker reveals what it confers", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 15_000 });
  const options = await optionsOf(page, "member-role-select");
  expect(options.length, `the picker offered roles to walk :: ${JSON.stringify(options)}`).toBeGreaterThan(1);
  const silent = options.filter((o) => o.revealed.length === 0).map((o) => o.name);
  expect(silent, "a name offered with no way to ask what it does").toEqual([]);
  for (const o of options) {
    expect(o.insideRow ?? false, `"${o.name}" draws its capabilities inside the option`).toBe(false);
    expect(o.name.split(/\s+/).length, `"${o.name}" reads as a name, not a list`).toBeLessThan(4);
  }
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
