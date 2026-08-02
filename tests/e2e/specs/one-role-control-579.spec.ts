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
  const n = await cells.count();
  expect(n, "the member table rendered at least one row").toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const cell = cells.nth(i);
    await expect(cell.locator(ROLE_CONTROLS), `row ${i}: one control, not two`).toHaveCount(1);
    // and it is the merged one: the tier the member is not on, plus the roles they do not hold
    await expect(cell.getByTestId("member-role-select")).toBeVisible();
  }
});

test("#579: the merged picker changes a tier in place and adds a custom role as a chip", async ({ page }) => {
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 15000 });

  const cell = page.getByTestId("member-roles").first();
  const tierChip = cell.getByTestId("member-tier-chip");
  const before = (await tierChip.innerText()).trim();
  await cell.getByTestId("member-role-select").click();
  const options = await page.getByRole("option").allInnerTexts();
  expect(options.join("|"), "the other tier is IN the list, not in a second control").toMatch(/\b(member|admin)\b/);
  expect(options.join("|"), "and the tier it already has is not offered").not.toContain(`\n${before}\n`);
  await page.keyboard.press("Escape");
});

test("#579: the invite form chooses its role from one dropdown too", async ({ page }) => {
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 15000 });

  const form = page.locator("form, div").filter({ has: page.getByTestId("invite-role") }).last();
  await expect(form.locator(ROLE_CONTROLS), "one role control in the invite form").toHaveCount(1);
  await page.getByTestId("invite-role").click();
  const options = await page.getByRole("option").allInnerTexts();
  await page.keyboard.press("Escape");
  expect(options.join("|"), "tiers are in the same list").toMatch(/\b(member|admin)\b/);
  expect(options.join("|"), 'and the "no custom role" placeholder that only existed to mark the other control is gone')
    .not.toMatch(/no custom role|カスタムロールなし/i);
});
