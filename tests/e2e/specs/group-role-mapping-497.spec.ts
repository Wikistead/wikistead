import { test, expect } from "@playwright/test";

// #497 / ADR-183: the Admin → Roles → "Group mappings" console. Real Chromium over the full loop:
// define a custom role → map an IdP group to it on a space → the mapping lists → delete it (with the
// #504 confirm). The server behaviour (assignment expansion, live group resolution, per-scope
// authority, orphan badge) is anti-tested server-side; this pins the UI wiring.
// RETIRED by #578 / ADR-201 rev3 slice 3: the SPACE group-mapping console is gone. Its job — conferring
// a role on an IdP group for a space — is the group grant on the space Members tab, and the one thing
// it could do that the grant could not (naming a group nobody carries yet) moved into the grant picker
// in slice 1. Both are pinned: group-grant-freetext-578.spec.ts drives the picker, and
// space-mapping-retired-578.test.ts pins the closed door plus the migration that converted what
// already existed. Removed rather than left driving a surface that answers 410 — a spec whose subject
// is gone reports nothing, loudly.
// RETIRED by #578 / ADR-201 rev3 slice 5: the tenant DEFAULT ROLE is gone. It said the same thing as
// the every-member toggles on the same screen (the tenant vocabulary is createSpaces and issueApiKeys,
// and both have one), so one of the two had to go and the toggles stayed. What this spec proved — a
// tenant-wide default surviving a reload — is now the toggles' own behaviour, pinned server-side in
// default-role-retired-578.test.ts together with both halves of the conversion. Removed rather than
// left clicking a control that no longer exists.
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
