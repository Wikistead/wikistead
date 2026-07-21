import { test, expect } from "@playwright/test";
import { sleep } from "../helpers";

// #420 / ADR-164 increment 5: the Admin → Roles console. Real Chromium over the full loop:
// define a custom role → edit it → assign it to a member on a space (the server expands to FGA
// tuples — behaviour anti-tested server-side; this pins the UI wiring + provenance display) →
// unassign → delete. Built-ins always listed (every plan).
test("#420: role manager — create, edit, assign on a space, unassign, delete", async ({ page }) => {
  const name = `e2e-role-${Date.now()}`;
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("builtin-roles")).toContainText("manager"); // built-ins on every plan

  // Create: name + delete/view capabilities.
  await page.getByTestId("role-create").click();
  await page.getByTestId("role-name-input").fill(name);
  await page.getByTestId("role-cap-delete").check();
  await page.getByTestId("role-cap-view").check();
  await page.getByTestId("role-save").click();
  await expect(page.getByTestId("custom-roles")).toContainText(name, { timeout: 8000 });

  // Edit: add publish (space-assignable — comment has NO space-scoped relation and a space
  // assignment of a comment-bearing role is correctly refused whole by the server).
  const row = page.getByTestId("custom-role-row").filter({ hasText: name });
  await row.getByTestId("role-edit").click();
  await page.getByTestId("role-cap-publish").check();
  await page.getByTestId("role-save").click();
  await expect(page.getByTestId("custom-roles")).toContainText("publish", { timeout: 8000 });

  // Assign on the demo space to a throwaway member sub.
  await page.getByTestId("assign-role").click();
  await page.getByRole("option", { name }).click();
  await page.getByTestId("assign-space").click();
  await page.getByRole("option").first().click(); // the first real space (no placeholder rows)
  await page.getByTestId("assign-sub").fill(`e2e-holder-${Date.now()}`);
  await page.getByTestId("assign-add").click();
  await expect(page.getByTestId("assignment-list")).toContainText(name, { timeout: 8000 });

  // Deleting a role with live assignments is refused (the 409 guard) — the toast explains.
  await row.getByTestId("role-delete").click();
  await expect(page.getByTestId("custom-roles")).toContainText(name); // still there (409)

  // Unassign → then delete succeeds.
  await page.getByTestId("assignment-row").filter({ hasText: name }).getByTestId("assignment-remove").click();
  await expect(page.getByTestId("assignment-list")).not.toContainText(name, { timeout: 8000 });
  await row.getByTestId("role-delete").click();
  await expect(page.getByTestId("custom-roles")).not.toContainText(name, { timeout: 8000 });
});

// #445 / ADR-171: tenant-scope roles + the default presets. The member default toggle IS the
// tenant#space_creator wildcard (CE); a custom TENANT role (createSpaces) assigns tenant-wide —
// no space picker appears for it. Behaviour (gate flips, write bind, reference count) is
// anti-tested server-side; this pins the console wiring.
test("#445: tenant defaults toggle + a tenant-scope role assigns tenant-wide (no space picker)", async ({ page }) => {
  const name = `e2e-trole-${Date.now()}`;
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });

  // #469 (owner ruling, supersedes the "locked admin checkbox" pin): the preset lives inside the
  // TENANT role list; admin's createSpaces is stated as text, not a permanently disabled control.
  await expect(page.getByTestId("default-admin-create-spaces")).toHaveCount(0);
  const member = page.getByTestId("builtin-tenant-roles").getByTestId("default-member-create-spaces");
  await expect(member).toBeEnabled({ timeout: 8000 });
  const initial = await member.isChecked();
  await member.click();
  await expect(member).toBeChecked({ checked: !initial, timeout: 8000 });
  await member.click(); // restore the seeded default
  await expect(member).toBeChecked({ checked: initial, timeout: 8000 });

  // A TENANT-scope custom role: the scope select narrows the capability vocabulary.
  await page.getByTestId("role-create").click();
  await page.getByTestId("role-name-input").fill(name);
  await page.getByTestId("role-scope").click();
  await page.getByRole("option", { name: "Tenant" }).click();
  await page.getByTestId("role-cap-createSpaces").check();
  await page.getByTestId("role-save").click();
  await expect(page.getByTestId("custom-roles")).toContainText(name, { timeout: 8000 });

  // Selecting the tenant role in the assignment panel hides the space picker (tenant-wide note).
  await page.getByTestId("assign-role").click();
  await page.getByRole("option", { name }).click();
  await expect(page.getByTestId("assign-tenant-note")).toBeVisible();
  await expect(page.getByTestId("assign-space")).toHaveCount(0);
  await page.getByTestId("assign-sub").fill(`e2e-tholder-${Date.now()}`);
  await page.getByTestId("assign-add").click();
  await expect(page.getByTestId("assignment-list")).toContainText(name, { timeout: 8000 });

  // Unassign + delete (leave the board clean).
  await page.getByTestId("assignment-row").filter({ hasText: name }).getByTestId("assignment-remove").click();
  await expect(page.getByTestId("assignment-list")).not.toContainText(name, { timeout: 8000 });
  await page.getByTestId("custom-role-row").filter({ hasText: name }).getByTestId("role-delete").click();
  await expect(page.getByTestId("custom-roles")).not.toContainText(name, { timeout: 8000 });
});
