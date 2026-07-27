import { test, expect } from "@playwright/test";

// #514 / ADR-188 §8: a group→role MAPPING follows the same scope symmetry as an assignment. A mapping
// onto a SPACE role is that space's configuration and is made in its Members tab; a mapping onto a TENANT
// role is made in tenant settings. Before this, every mapping was created on the tenant Roles tab behind a
// space picker — one space's configuration living in a screen only tenant admins can open.
test("#514: the tenant Roles tab maps TENANT roles only (no space picker)", async ({ page }) => {
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("mapping-form"), "the tenant mapping form is still here").toBeVisible();
  await expect(page.getByTestId("mapping-space"), "…but it no longer picks a space").toHaveCount(0);
  await expect(page.getByTestId("mapping-tenant-note"), "and it says the scope is the tenant").toBeVisible();
});

test("#514: a space's own group mappings are configured in its Members tab", async ({ page }) => {
  // the section only appears once the tenant has resource-scope roles to map, so make one first
  const name = `map-role-${Date.now().toString(36)}`;
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("role-create").click();
  await page.getByTestId("role-name-input").fill(name);
  await page.getByTestId("role-cap-view").check();
  await page.getByTestId("role-save").click();
  await expect(page.getByTestId("custom-roles")).toContainText(name, { timeout: 8000 });

  // …and it is NOT offered as a tenant mapping (that form is tenant-scope only now)
  await page.getByTestId("mapping-role").click();
  await expect(page.getByRole("option", { name }), "a space role is not mappable from the tenant tab").toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto("/spaces/demo_space/settings/members");
  const section = page.getByTestId("space-group-mappings");
  await expect(section, "the space configures its own mappings").toBeVisible({ timeout: 10_000 });

  const group = `e2e-group-${Date.now().toString(36)}`;
  await page.getByTestId("space-mapping-group").fill(group);
  await page.getByTestId("space-mapping-role").click();
  await page.getByRole("option", { name }).click();
  await page.getByTestId("space-mapping-add").click();
  await expect(page.getByTestId("space-mapping-list"), "the mapping lands").toContainText(group, { timeout: 8000 });

  // #504: deleting a mapping revokes what it granted — it must confirm first
  await page.getByTestId("space-mapping-row").filter({ hasText: group }).getByTestId("space-mapping-remove").click();
  await expect(page.getByTestId("space-mapping-list"), "not gone until confirmed").toContainText(group);
  await page.getByTestId("space-mapping-delete-confirm").click();
  await expect(page.getByTestId("space-mapping-list")).not.toContainText(group, { timeout: 8000 });

  // clean up the role
  await page.goto("/admin/roles");
  await page.getByTestId("custom-role-row").filter({ hasText: name }).getByTestId("role-delete").click();
  await page.getByTestId("role-delete-confirm").click();
  await expect(page.getByTestId("custom-roles")).not.toContainText(name, { timeout: 8000 });
});
