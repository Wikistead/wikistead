import { test, expect } from "@playwright/test";

// #579 (third ruling): " UI " — one control per row,
// and everything is chosen from it.
//
// Measured in the real DOM rather than from the source, because the thing that kept going wrong is what
// a person SEES in one row: a Select beside a button, or two Selects side by side, each of which reads
// as "there are two decisions here". The source pin (one-role-control-579.test.ts) catches the shape by
// testid; this one counts what actually renders inside the row element, which is the number the reviewer
// re-measures.
const ROLE_CONTROLS = '[data-testid$="-role-select"], [data-testid$="-tier-select"], [data-testid$="-role-add"], [data-testid$="-role-add-select"], [data-testid="invite-role"], [data-testid="invite-role-id"]';

test("#579: a member row offers exactly one way to choose a role", async ({ page }) => {
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 15000 });

  const cells = page.getByTestId("member-roles");
  // wait for the table, do not race it: `count` answers 0 while the member query is still in flight,
  // which reads as "the screen has no rows" and is really "the screen has not answered yet"
  await expect(cells.first()).toBeVisible({ timeout: 15000 });
  const n = await cells.count();
  expect(n, "the member table rendered at least one row").toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const cell = cells.nth(i);
    await expect(cell.locator(ROLE_CONTROLS), `row ${i}: one control, not two`).toHaveCount(1);
    // and it is the merged one: the tier the member is not on, plus the roles they do not hold
    await expect(cell.getByTestId("member-role-select")).toBeVisible();
  }
});

// RE-AIMED by #579 (2026-08-03): the row no longer draws chips beside the control — the control IS the
// role. So what is measured is that its VALUE is the member's role and that the list offers the whole
// vocabulary, including the value already shown (a picker that hides what you have is what made chips
// necessary).
test("#579: the row's control shows the member's role and offers every role", async ({ page }) => {
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 15000 });

  const cell = page.getByTestId("member-roles").first();
  await expect(cell).toBeVisible({ timeout: 15000 });
  await expect(cell.getByTestId("member-role-chip"), "chips went with the set they drew").toHaveCount(0);
  await expect(cell.getByTestId("member-tier-chip")).toHaveCount(0);
  const shown = (await cell.getByTestId("member-role-select").innerText()).trim();
  expect(shown.length, "the control shows a value, not an empty prompt").toBeGreaterThan(0);

  await cell.getByTestId("member-role-select").click();
  const options = await page.getByRole("option").allInnerTexts();
  await page.keyboard.press("Escape");
  expect(options.join("|"), "both tiers are in the same list").toMatch(/member/);
  expect(options.join("|")).toMatch(/admin/);
  expect(options.some((o) => o.trim() === shown), "including the one it is showing").toBe(true);
});

test("#579: the invite form chooses its role from one dropdown too", async ({ page }) => {
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 15000 });

  const form = page.locator("form, div").filter({ has: page.getByTestId("invite-role") }).last();
  await expect(form.locator(ROLE_CONTROLS), "one role control in the invite form").toHaveCount(1);
  // Opened from the KEYBOARD rather than by clicking: the invite row sits at the bottom of a table that
  // is still settling, and Playwright's click waits for the element to stop moving — measured, it never
  // did, and the test spent its whole minute waiting to press a button that was right there. Focus and
  // Enter is the same act for this control (and the one a keyboard user performs).
  await page.getByTestId("invite-role").scrollIntoViewIfNeeded();
  await page.getByTestId("invite-role").focus();
  await page.keyboard.press("Enter");
  const options = await page.getByRole("option").allInnerTexts();
  await page.keyboard.press("Escape");
  expect(options.join("|"), "tiers are in the same list").toMatch(/\b(member|admin)\b/);
  expect(options.join("|"), 'and the "no custom role" placeholder that only existed to mark the other control is gone')
    .not.toMatch(/no custom role|カスタムロールなし/i);
});
