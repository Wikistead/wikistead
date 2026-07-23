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

  // Edit: add publish via the INLINE picker (#445 — a checkbox toggle IS the commit, no
  // form/save). The check must survive a full reload = the PUT really landed, not local state.
  // (publish is space-assignable — comment has NO space-scoped relation and a space assignment
  // of a comment-bearing role is correctly refused whole by the server.)
  const row = page.getByTestId("custom-role-row").filter({ hasText: name });
  await row.getByTestId("custom-cap-publish").click(); // controlled input — assert the state below, not in check()
  await expect(row.getByTestId("custom-cap-publish")).toBeChecked({ timeout: 8000 });
  await sleep(500);
  await page.reload();
  await expect(page.getByTestId("custom-role-row").filter({ hasText: name }).getByTestId("custom-cap-publish"))
    .toBeChecked({ timeout: 10_000 });

  // Assign on the demo space to a throwaway member sub.
  await page.getByTestId("assign-role").click();
  await page.getByRole("option", { name }).click();
  await expect(page.getByRole("option")).toHaveCount(0); // the role listbox is fully closed (radix restores pointer-events)
  await page.getByTestId("assign-space").click();
  await page.getByRole("option").first().click(); // the first real space (no placeholder rows)
  await page.getByTestId("assign-sub").fill(`e2e-holder-${Date.now()}`); // a raw sub is still accepted
  await page.getByTestId("assign-add").click();
  await expect(page.getByTestId("assignment-list")).toContainText(name, { timeout: 8000 });

  // Deleting a role with live assignments is refused (the 409 guard) — the toast explains.
  await row.getByTestId("role-delete").click();
  await page.getByTestId("role-delete-confirm").click(); // #504: delete confirms first
  await expect(page.getByTestId("custom-roles")).toContainText(name); // still there (409)

  // Unassign → then delete succeeds.
  await page.getByTestId("assignment-row").filter({ hasText: name }).getByTestId("assignment-remove").click();
  await expect(page.getByTestId("assignment-list")).not.toContainText(name, { timeout: 8000 });
  await row.getByTestId("role-delete").click();
  await page.getByTestId("role-delete-confirm").click(); // #504: delete confirms first
  await expect(page.getByTestId("custom-roles")).not.toContainText(name, { timeout: 8000 });
});

// #445 the inline picker's guard rails — a role can never lose its LAST capability (the sole
// checked box is disabled, mirroring the server's non-empty validation), and the name keeps a small
// pencil→inline-input affordance now that the full edit form is gone.
test("#445 last capability is locked; rename works via the inline affordance", async ({ page }) => {
  const name = `e2e-lock-${Date.now()}`;
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });

  // Create a role with exactly ONE capability.
  await page.getByTestId("role-create").click();
  await page.getByTestId("role-name-input").fill(name);
  await page.getByTestId("role-cap-view").check();
  await page.getByTestId("role-save").click();
  const row = page.getByTestId("custom-role-row").filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 8000 });

  // The sole checked box is LOCKED (disabled) — the last capability cannot be removed.
  await expect(row.getByTestId("custom-cap-view")).toBeChecked();
  await expect(row.getByTestId("custom-cap-view")).toBeDisabled();

  // Adding a second capability unlocks it (two checked → neither is the last).
  await row.getByTestId("custom-cap-edit").click(); // controlled input — assert below
  await expect(row.getByTestId("custom-cap-edit")).toBeChecked({ timeout: 8000 });
  await expect(row.getByTestId("custom-cap-view")).toBeEnabled({ timeout: 8000 });

  // Rename via the pencil → inline input → Enter; the new name survives a reload (real PUT).
  const renamed = `${name}-r`;
  await row.getByTestId("role-rename").click();
  // while renaming, the row no longer CONTAINS the name as text (the span is replaced by the input),
  // so the hasText-filtered row resolves to nothing — the input is unique on the page, locate it there.
  const rename = page.getByTestId("role-rename-input");
  await rename.fill(renamed);
  await rename.press("Enter");
  await expect(page.getByTestId("custom-role-row").filter({ hasText: renamed })).toBeVisible({ timeout: 8000 });
  await sleep(500);
  await page.reload();
  const renamedRow = page.getByTestId("custom-role-row").filter({ hasText: renamed });
  await expect(renamedRow).toBeVisible({ timeout: 10_000 });

  // Cleanup.
  await renamedRow.getByTestId("role-delete").click();
  await page.getByTestId("role-delete-confirm").click(); // #504: delete confirms first
  await expect(page.getByTestId("custom-roles")).not.toContainText(renamed, { timeout: 8000 });
});

// #445 / ADR-171: tenant-scope roles + the default presets. The member default toggle IS the
// tenant#space_creator wildcard (CE); a custom TENANT role (createSpaces) assigns tenant-wide —
// no space picker appears for it. Behaviour (gate flips, write bind, reference count) is
// anti-tested server-side; this pins the console wiring.
test("#445: tenant defaults toggle + a tenant-scope role assigns tenant-wide (no space picker)", async ({ page }) => {
  const name = `e2e-trole-${Date.now()}`;
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });

  // #469 / #445 the preset lives inside the TENANT role list as a CapabilityPicker cell; the old
  // standalone admin control is gone (admin is now a uniform read-only picker, asserted in roles-ia-469).
  await expect(page.getByTestId("default-admin-create-spaces")).toHaveCount(0);
  const member = page.getByTestId("builtin-tenant-roles").getByTestId("builtin-member-cap-createSpaces");
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
  await page.getByTestId("role-delete-confirm").click(); // #504: delete confirms first
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
