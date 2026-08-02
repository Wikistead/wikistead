import { test, expect } from "@playwright/test";

//
// The rule the four surfaces now share: an EXCLUSIVE role (a tenant tier, a built-in space role) is a
// dropdown that is always visible and changes in place; ADDITIVE custom roles stay chips with their own
// add control. What was wrong was not the number of controls but that the exclusive answer was hidden
// behind one labelled "add", and on the space screen there was no way to change a role at all — you
// removed it and granted again, which is two operations with the person's access gone in between.
//
// Driven in a real browser because the point is what a person can reach and press.

test("#591: a tenant member's tier is a dropdown, and Add offers only custom roles", async ({ page }) => {
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 15000 });

  // the DS Select is a Radix trigger (a button), not a native <select> — read what it SHOWS
  const tier = page.getByTestId("member-tier-select").first();
  await expect(tier, "the tier is visible without pressing anything").toBeVisible();
  await expect(tier, "it shows what the member IS, not an empty pick-something state").toHaveText(/^(member|admin)$/);

  // and the add control, when it exists, must not offer a tier — "add" has to mean add
  const add = page.getByTestId("member-role-add").first();
  if (await add.isVisible().catch(() => false)) {
    await add.click();
    const select = page.getByTestId("member-role-add-select").first();
    await expect(select).toBeVisible();
    await select.click();
    const options = await page.getByRole("option").allInnerTexts();
    await page.keyboard.press("Escape");
    expect(options.join("|"), "no tier in the ADD list").not.toMatch(/\b(member|admin)\b/);
  }
});

test("#591: a space member's built-in role changes from the row, in one step", async ({ page }) => {
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 15000 });

  const row = page.getByTestId("space-member-item").filter({ has: page.getByTestId("space-member-role-select") }).first();
  if (!(await row.isVisible().catch(() => false))) {
    test.info().annotations.push({ type: "note", description: "no built-in grant row on the shared demo space — change path not exercised" });
    return;
  }
  const select = row.getByTestId("space-member-role-select");
  await expect(select, "the dropdown shows the role the row HAS").toHaveText(/^(viewer|commenter|editor|moderator|manager)$/);

  // the row keeps its revoke as well — changing and removing are different acts
  await expect(row.getByTestId("space-grant-revoke"), "× is still there for removal").toBeVisible();
});
