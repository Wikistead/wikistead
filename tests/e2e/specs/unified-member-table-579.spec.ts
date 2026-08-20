import { test, expect } from "@playwright/test";
import { API } from "../helpers";

// #579 ① / ③ (user ruling, 2026-08-03): no separate group-roles section — merge groups into the
// members table, with user names and group names listed side by side, an icon telling the two kinds
// apart, and the member search UI finding users and groups alike.
//
// A group holding a tenant role is a principal with a role, exactly like a person. The screen said
// otherwise with two sections, two shapes and two vocabularies, and that is what made the group half
// read as a different kind of thing under different rules.
//
// Measured in a real browser because the claim is about what is on the page: one table, both kinds in
// it, one control per row, and — the part that is easy to lose in a merge — a group NOBODY carries yet
// can still be given a role, which the retired section could do and a table of existing rows cannot.
test("#579 ①③: people and groups are one table, and a new group is named from the search", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now().toString(36);
  const roleName = `unified-${stamp}`;
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 15_000 });

  // a tenant-scope role to hand out (the group half of the table only carries custom roles — ADR-201)
  await page.evaluate(async ({ api, name }) => {
    await fetch(`${api}/admin/roles`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ name, capabilities: ["createSpaces"], scope: "tenant" }),
    });
  }, { api: API, name: roleName });
  await page.reload();
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 15_000 });

  // the retired section is gone
  await expect(page.getByTestId("tenant-group-roles"), "the group section folded into the table").toHaveCount(0);

  // ③ a group nobody carries yet still gets a role here.
  // RE-AIMED (#578 bounce ④, 2026-08-04): it used to be named in the FILTER field, and the review
  // rejected that — an add route nothing on screen announces, with no completion and no way to tell a
  // confirmed group from a typed one. The shared form does all three, and it is the same form the space
  // screen shows, which is what the ruling asked for.
  const groupName = `Unified-${stamp}`;
  // the form opens on the user half (2026-08-04: both kinds are offered) — flip it to groups
  await page.getByTestId("tenant-grant-type").click();
  await page.getByRole("option", { name: /group/i }).click();
  await page.getByTestId("tenant-grant-group-name").fill(groupName);
  await page.getByTestId("tenant-grant-role").click();
  await page.getByRole("option", { name: roleName }).click();
  await page.getByTestId("tenant-grant-add").click();

  // ① it comes back as an ordinary row in the same table, marked as a group by an ICON
  await page.getByTestId("members-filter").fill(groupName);
  const groupRow = page.getByTestId("member-row-group").filter({ hasText: groupName });
  await expect(groupRow, "the group is a row in the member table").toBeVisible({ timeout: 10_000 });
  await expect(groupRow.getByTestId("row-kind-group"), "its kind is an icon, not a suffix in the name").toBeVisible();
  await expect(groupRow.getByTestId("member-role-select"), "and its role control is the same control").toHaveCount(1);

  // ② one control per row, on every row, both kinds
  await page.getByTestId("members-filter").fill("");
  const cells = page.getByTestId("member-roles");
  const n = await cells.count();
  expect(n, "the table has rows of both kinds").toBeGreaterThan(1);
  for (let i = 0; i < n; i++) {
    await expect(cells.nth(i).locator("[data-testid$='-role-select']"), `row ${i} has exactly one role control`).toHaveCount(1);
  }

  // and nothing anywhere says "add a role" — roles do not stack, so there is no adding
  await expect(page.getByTestId("member-role-add"), "the add control went with the concept").toHaveCount(0);
});
