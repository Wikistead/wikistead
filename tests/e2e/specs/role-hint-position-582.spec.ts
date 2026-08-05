import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #582 (review rejection, 2026-08-04): the "what this role can do" panel does not keep one rule. Two
// symptoms were reported and both are geometry, so both are measured here rather than described.
//
// - hovering an option low on the screen sent the panel UP, away from the option: the placement
// clamped to a FIXED `innerHeight - 120`, so past that line the panel stopped tracking the row.
// - at a short viewport the panel did not appear at all.
//
// Assertions relate the panel to the option it belongs to (not to constants): a placement that is
// wrong at every size would satisfy a hard-coded number.
// The space grant picker: the longest role list in the product (every built-in noun plus the tenant's
// custom roles), which is what makes the bottom of the list reachable — the tenant row picker offers
// two tiers and never gets near the clamp, which is exactly why the reject said .
async function openRolePicker(page: Page): Promise<void> {
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 10_000 });
  await sleep(400);
  await page.getByTestId("space-grant-capability").click();
  await expect(page.locator("[data-slot=select-content]")).toBeVisible({ timeout: 5_000 });
  await sleep(200);
}

/** The panel's rect and the hovered option's rect, together. */
async function measure(page: Page): Promise<{ panelTop: number; panelH: number; rowTop: number; rowBottom: number } | null> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("[data-testid$='-hint'], [data-testid=select-hint]");
    const item = document.querySelector<HTMLElement>("[data-slot=select-content] [data-highlighted]")
      ?? document.querySelector<HTMLElement>("[data-slot=select-content] [role=option]:hover");
    if (!panel || !item) return null;
    const p = panel.getBoundingClientRect();
    const r = item.getBoundingClientRect();
    return { panelTop: p.top, panelH: p.height, rowTop: r.top, rowBottom: r.bottom };
  });
}

// Both heights, because the clamp only bites once an option sits below `innerHeight - 120`: at 720 the
// list never reaches that line (which is why the defect read as "only some screens"), at 450 it does.
for (const height of [720, 450]) {
test(`#582: the panel stays beside the option it describes (viewport ${height}px)`, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height });
  await openDemo(page);
  await openRolePicker(page);

  // walk every option with the keyboard; each one must be described BESIDE itself
  const count = await page.locator("[data-slot=select-content] [role=option]").count();
  expect(count, "the list has options").toBeGreaterThan(2);
  for (let i = 0; i < count; i++) {
    await page.keyboard.press("ArrowDown");
    await sleep(120);
    const m = await measure(page);
    if (!m) continue; // an option with no hint (the placeholder) describes nothing
    // adjacent = the panel's top is within one panel height of the option's own band. That is the
    // loosest honest reading of "beside it": a panel that has been pushed up to fit is still beside,
    // a panel clamped to a fixed line halfway up the screen is not.
    const drift = Math.min(Math.abs(m.panelTop - m.rowTop), Math.abs(m.panelTop - m.rowBottom));
    expect(drift, `option ${i}: the panel is ${Math.round(drift)}px from the option (panel ${Math.round(m.panelH)}px)`)
      .toBeLessThanOrEqual(m.panelH + 8);
  }
});
}

// #582 ①: the tier options explain themselves too now. `admin` always (structural); `member` only what
// THIS tenant's switches actually confer — the panel's content is read, not assumed, so a tenant that
// turned both switches off would show an empty-but-honest member rather than a false "can create spaces".
test("#582 ①: the tenant tiers raise a panel of their own", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 10_000 });
  await sleep(400);
  await page.getByTestId("member-role-select").first().click();
  await expect(page.locator("[data-slot=select-content]")).toBeVisible({ timeout: 5_000 });
  await sleep(200);

  // Rewind to the first option before walking. Radix opens with the highlight on the SELECTED item, so
  // walking only downwards never reaches a tier that sits above it — with dev-user already `admin` this
  // test could not reach `tier:admin` at all and was red on master for that reason, not for a missing
  // panel (measured in the #582 review; the panel was there the whole time).
  for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowUp");
  await sleep(120);

  // walk to the admin tier and read its panel
  let adminPanel = "";
  for (let i = 0; i < 12 && !adminPanel; i++) {
    if (i > 0) await page.keyboard.press("ArrowDown");
    await sleep(120);
    const seen = await page.evaluate(() => {
      const item = document.querySelector<HTMLElement>("[data-slot=select-content] [data-highlighted]");
      const panel = document.querySelector<HTMLElement>("[data-testid$='-hint'], [data-testid=select-hint]");
      return item?.dataset.optionValue === "tier:admin" && panel ? panel.textContent ?? "" : "";
    });
    if (seen) adminPanel = seen;
  }
  expect(adminPanel, "the admin tier raises a panel").toBeTruthy();
  // its content is the measured closure — five verbs, not the two the row used to hard-code
  expect(adminPanel.toLowerCase(), "and it lists what admin really confers").toContain("audit");
});

test("#582: a short viewport still gets the panel", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 450 });
  await openDemo(page);
  await openRolePicker(page);

  // the first hintful option must produce a panel — "no room" is not an answer, the panel is 220px wide
  // and the screen is 1280 wide
  let seen = false;
  const count = await page.locator("[data-slot=select-content] [role=option]").count();
  for (let i = 0; i < count && !seen; i++) {
    await page.keyboard.press("ArrowDown");
    await sleep(150);
    if (await measure(page)) seen = true;
  }
  expect(seen, "at 1280x450 no option ever showed its panel").toBe(true);
});
