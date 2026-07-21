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
  await page.getByTestId("assign-sub").fill(`e2e-holder-${Date.now()}`); // a raw sub is still accepted
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

// #420 the console's vocabulary. A built-in role is shown as the SAME capability grid used to
// build a custom one (checked, disabled) rather than a run-on line of names; the two dropdowns in the
// assignment row say which is which; and the member field is a name search rather than a request for
// an internal "sub".
test("#420 built-ins render as read-only capability checkboxes, and members are picked by name", async ({ page }) => {
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });

  // built-in `manager` shows its capabilities as checked, disabled checkboxes
  const managerView = page.getByTestId("builtin-manager-cap-view");
  await expect(managerView).toBeVisible();
  await expect(managerView).toBeChecked();
  await expect(managerView).toBeDisabled();
  // …and a capability it does NOT have is present but unchecked (the grid is the whole vocabulary)
  const viewerDelete = page.getByTestId("builtin-viewer-cap-delete");
  await expect(viewerDelete).toBeVisible();
  await expect(viewerDelete).not.toBeChecked();
  await expect(page.getByTestId("builtin-roles"), "the cap · cap · cap text is gone").not.toContainText(" · ");

  // the assignment controls carry visible labels, not just aria ones
  const form = page.getByTestId("assign-form");
  await expect(form.locator("label", { hasText: /./ }).first()).toBeVisible();
  const labels = (await form.locator("label").allInnerTexts()).join("|");
  expect(labels.length, `the assignment row is labelled (got "${labels}")`).toBeGreaterThan(0);

  // the member field searches by name: typing offers candidates, picking one fills the field
  await page.getByTestId("assign-sub").fill("e");
  const item = page.getByTestId("assign-sub-item").first();
  await expect(item, "a tenant member matched the search").toBeVisible({ timeout: 8000 });
  const picked = (await item.innerText()).split("\n")[0]!.trim();
  await item.click();
  await expect(page.getByTestId("assign-sub")).toHaveValue(picked);
  await expect(page.getByTestId("assign-sub-list"), "the list closes once a member is chosen").toHaveCount(0);
});
