import { test, expect } from "@playwright/test";

// #497 / ADR-183: the Admin → Roles → "Group mappings" console. Real Chromium over the full loop:
// define a custom role → map an IdP group to it on a space → the mapping lists → delete it (with the
// #504 confirm). The server behaviour (assignment expansion, live group resolution, per-scope
// authority, orphan badge) is anti-tested server-side; this pins the UI wiring.
test("#497: group→role mapping — create a custom role, map a group, list, delete", async ({ page }) => {
  const role = `e2e-maprole-${Date.now()}`;
  const group = `e2e-grp-${Date.now()}`;
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });

  // A space-scope custom role to confer.
  await page.getByTestId("role-create").click();
  await page.getByTestId("role-name-input").fill(role);
  await page.getByTestId("role-cap-view").check();
  await page.getByTestId("role-save").click();
  await expect(page.getByTestId("roles-list")).toContainText(role, { timeout: 8000 });

  // Map an IdP group to the role ON THE SPACE. #514 / ADR-188 §8 moved space-scope mappings off the
  // tenant Roles tab (whose form is tenant-scope only now) and into the space's own Members tab — the
  // space is the page's context, so the row needs no space column (the c50eedbdb naming property now
  // only applies to the tenant tab's own rows, which all say "· Tenant").
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-group-mappings")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("space-mapping-group").fill(group);
  await page.getByTestId("space-mapping-role").click();
  await page.getByRole("option", { name: role }).click();
  await expect(page.getByRole("option")).toHaveCount(0); // the role listbox closed (radix pointer-events restored)
  await page.getByTestId("space-mapping-add").click();

  const row = page.getByTestId("space-mapping-row").filter({ hasText: group });
  await expect(row).toContainText(group, { timeout: 8000 });
  await expect(row).toContainText(role);

  // Delete confirms first (#504 danger), then the row is gone.
  await row.getByTestId("space-mapping-remove").click();
  await page.getByTestId("space-mapping-delete-confirm").click();
  await expect(page.getByTestId("space-mapping-list")).not.toContainText(group, { timeout: 8000 });

  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });

  // Cleanup: the role now has no live assignment, so delete succeeds.
  await page.getByTestId("custom-role-row").filter({ hasText: role }).getByTestId("role-delete").click();
  await page.getByTestId("role-delete-confirm").click();
  await expect(page.getByTestId("roles-list")).not.toContainText(role, { timeout: 8000 });
});

// #497 / ADR-183 §3: the tenant default role setting persists (a tenant-scope custom role becomes the
// default; the choice survives a reload = the PUT landed). The login-time application is anti-tested
// server-side; this pins the console wiring.
test("#497 §3: the default-role setting persists across a reload", async ({ page }) => {
  const role = `e2e-defrole-${Date.now()}`;
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("role-create").click();
  await page.getByTestId("role-name-input").fill(role);
  await page.getByTestId("role-scope-tenant").click(); // #580: the scope is chosen first, then its capabilities show
  await page.getByTestId("role-cap-createSpaces").check();
  await page.getByTestId("role-save").click();
  await expect(page.getByTestId("roles-list")).toContainText(role, { timeout: 8000 });

  // Pick it as the default → reload → still selected (the PUT persisted).
  await page.getByTestId("default-role").click();
  await page.getByRole("option", { name: role }).click();
  await expect(page.getByTestId("default-role")).toContainText(role, { timeout: 8000 });
  await page.reload();
  await expect(page.getByTestId("default-role")).toContainText(role, { timeout: 10_000 });

  // Back to None, then delete the role (no live assignment yet).
  await page.getByTestId("default-role").click();
  await page.getByRole("option", { name: "member (built-in default)" }).click();
  // #536 ③: the CLOSED trigger says the truth too — Radix rendered nothing for the empty-valued
  // option, so "no selection" looked broken exactly where the label matters most.
  await expect(page.getByTestId("default-role"), "the closed select names the member fallback").toContainText("member", { timeout: 8000 });
  await page.getByTestId("custom-role-row").filter({ hasText: role }).getByTestId("role-delete").click();
  await page.getByTestId("role-delete-confirm").click();
  await expect(page.getByTestId("roles-list")).not.toContainText(role, { timeout: 8000 });
});

// A tenant-scope mapping needs no space picker — the target is the tenant itself (the tenant-wide note
// shows, mirroring the assignment form's tenant behaviour).
test("#497: a tenant-scope role maps tenant-wide (no space picker)", async ({ page }) => {
  const role = `e2e-tmaprole-${Date.now()}`;
  const group = `e2e-tgrp-${Date.now()}`;
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("role-create").click();
  await page.getByTestId("role-name-input").fill(role);
  await page.getByTestId("role-scope-tenant").click(); // #580: the scope is chosen first, then its capabilities show
  await page.getByTestId("role-cap-createSpaces").check();
  await page.getByTestId("role-save").click();
  await expect(page.getByTestId("roles-list")).toContainText(role, { timeout: 8000 });

  await page.getByTestId("mapping-group").fill(group);
  await page.getByTestId("mapping-role").click();
  await page.getByRole("option", { name: role }).click();
  await expect(page.getByTestId("mapping-tenant-note")).toBeVisible();
  await expect(page.getByTestId("mapping-space")).toHaveCount(0);
  await page.getByTestId("mapping-add").click();
  const row = page.getByTestId("mapping-row").filter({ hasText: group });
  await expect(row).toContainText(role, { timeout: 8000 });

  // Cleanup.
  await row.getByTestId("mapping-remove").click();
  await page.getByTestId("mapping-delete-confirm").click();
  await expect(page.getByTestId("mapping-list")).not.toContainText(group, { timeout: 8000 });
  await page.getByTestId("custom-role-row").filter({ hasText: role }).getByTestId("role-delete").click();
  await page.getByTestId("role-delete-confirm").click();
  await expect(page.getByTestId("roles-list")).not.toContainText(role, { timeout: 8000 });
});
