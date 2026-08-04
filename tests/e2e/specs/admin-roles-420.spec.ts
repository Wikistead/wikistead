import { test, expect } from "@playwright/test";
import { sleep } from "../helpers";

// #420 / ADR-164 increment 5: the Admin → Roles console. Real Chromium over the full loop
// define a custom role → edit it → assign it to a member on a space (the server expands to FGA
// tuples — behaviour anti-tested server-side; this pins the UI wiring + provenance display) →
// unassign → delete. Built-ins always listed (every plan).
test("#420: role manager — create, edit, assign on a space, unassign, delete", async ({ page }) => {
  const name = `e2e-role-${Date.now()}`;
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("roles-list")).toContainText("manager"); // built-ins on every plan

  // Create: name + delete/view capabilities.
  await page.getByTestId("role-create").click();
  await page.getByTestId("role-name-input").fill(name);
  await page.getByTestId("role-cap-delete").check();
  await page.getByTestId("role-cap-view").check();
  await page.getByTestId("role-save").click();
  await expect(page.getByTestId("roles-list")).toContainText(name, { timeout: 8000 });

  // Edit: add publish via the INLINE picker (#445— a checkbox toggle IS the commit, no
  // form/save). The check must survive a full reload = the PUT really landed, not local state.
  // (publish is space-assignable — comment has NO space-scoped relation and a space assignment
  // of a comment-bearing role is correctly refused whole by the server.)
  // #586②: at rest a row is its NAME — the grid opens behind the edit affordance now.
  const row = page.getByTestId("custom-role-row").filter({ hasText: name });
  await row.getByTestId("role-edit-caps").click();
  await row.getByTestId("custom-cap-publish").click(); // controlled input — assert the state below, not in check()
  await expect(row.getByTestId("custom-cap-publish")).toBeChecked({ timeout: 8000 });
  await sleep(500);
  await page.reload();
  const rowAfter = page.getByTestId("custom-role-row").filter({ hasText: name });
  await expect(rowAfter).toBeVisible({ timeout: 10_000 });
  await rowAfter.getByTestId("role-edit-caps").click();
  await expect(rowAfter.getByTestId("custom-cap-publish")).toBeChecked({ timeout: 10_000 });

  // Assign on the demo space. #514 / ADR-188 slice 4 moved this control OFF the Roles tab (which now only
  // DEFINES roles) and into the space's own Members tab, so the role's lifecycle is exercised where the
  // grant actually lives now.
  await page.goto("/spaces/demo_space/settings/members");
  // #536 §6: assignment goes through the MERGED picker (one control for built-ins and custom roles);
  // the old space-role-select/-member-input/-add form is gone.
  await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("space-grant-input").fill("dev");
  await page.getByTestId("space-grant-candidate").first().click();
  await page.getByTestId("space-grant-capability").click();
  await page.getByRole("option", { name }).click();
  await expect(page.getByRole("option")).toHaveCount(0); // the listbox is fully closed (radix restores pointer-events)
  await page.getByTestId("space-grant-add").click();
  // #536②: adding over an existing different role opens the replace confirm (1 principal = 1
  // role). Residue rows on the shared demo space make this conditional.
  {
    const replaceConfirm = page.getByTestId("space-role-replace-confirm");
    if (await replaceConfirm.isVisible({ timeout: 1500 }).catch(() => false)) await replaceConfirm.click();
  }
  await expect(page.getByTestId("space-member-list")).toContainText(name, { timeout: 8000 });

  // Deleting a role with live assignments is refused (the 409 guard) — the toast explains.
  await page.goto("/admin/roles");
  const row2 = page.getByTestId("custom-role-row").filter({ hasText: name });
  await row2.getByTestId("role-delete").click();
  await page.getByTestId("role-delete-confirm").click(); // #504: delete confirms first
  await expect(page.getByTestId("roles-list")).toContainText(name); // still there (409)

  // Unassign (again where the grant lives) → then delete succeeds.
  await page.goto("/spaces/demo_space/settings/members");
  await page.getByTestId("space-member-item").filter({ hasText: name }).getByTestId("space-role-assign-revoke").click();
  await expect(page.getByTestId("space-member-list")).not.toContainText(name, { timeout: 8000 });
  await page.goto("/admin/roles");
  const row3 = page.getByTestId("custom-role-row").filter({ hasText: name });
  await row3.getByTestId("role-delete").click();
  await page.getByTestId("role-delete-confirm").click(); // #504: delete confirms first
  await expect(page.getByTestId("roles-list")).not.toContainText(name, { timeout: 8000 });
});

// #445the inline picker's guard rails — a role can never lose its LAST capability (the sole
// checked box is disabled, mirroring the server's non-empty validation), and the name keeps a small
// pencil→inline-input affordance now that the full edit form is gone.
test("#445last capability is locked; rename works via the inline affordance", async ({ page }) => {
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
  await row.getByTestId("role-edit-caps").click(); // #586②: the grid opens behind the edit affordance

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
  await expect(page.getByTestId("roles-list")).not.toContainText(renamed, { timeout: 8000 });
});

// #445 / ADR-171: tenant-scope roles + the default presets. The member default toggle IS the
// tenant#space_creator wildcard (CE); a custom TENANT role (createSpaces) assigns tenant-wide
// no space picker appears for it. Behaviour (gate flips, write bind, reference count) is
// anti-tested server-side; this pins the console wiring.
test("#445: tenant defaults toggle + a tenant-scope role assigns tenant-wide (no space picker)", async ({ page }) => {
  const name = `e2e-trole-${Date.now()}`;
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });

  // #469 / #445the preset is configured on this screen; the old standalone admin control is gone.
  // #586 (2026-08-04): it moved OUT of the member role row into its own section — a built-in role carries
  // no editing surface, and those boxes were the tenant policy wearing a role row's clothes.
  await expect(page.getByTestId("default-admin-create-spaces")).toHaveCount(0);
  const member = page.getByTestId("member-defaults").getByTestId("member-defaults-cap-createSpaces");
  await expect(member).toBeEnabled({ timeout: 8000 });
  const initial = await member.isChecked();
  await member.click();
  await expect(member).toBeChecked({ checked: !initial, timeout: 8000 });
  await member.click(); // restore the seeded default
  await expect(member).toBeChecked({ checked: initial, timeout: 8000 });

  // A TENANT-scope custom role. #580: the scope is CHOSEN first (segments) and the capability list
  // follows it — before that, checking a tenant capability WAS the scope (#536's derivation),
  // which left you unable to tell what you were building until you had ticked something.
  await page.getByTestId("role-create").click();
  await page.getByTestId("role-name-input").fill(name);
  await page.getByTestId("role-scope-tenant").click();
  await page.getByTestId("role-cap-createSpaces").check();
  await page.getByTestId("role-save").click();
  await expect(page.getByTestId("roles-list")).toContainText(name, { timeout: 8000 });

  // #514 / ADR-188 slice 4: a TENANT role is an attribute of a member, so it is granted on the Members
  // page — no space picker anywhere, because the scope is the tenant itself.
  // #579: and it is granted ON THE MEMBER'S ROW. The separate assign form (its own role picker, its own
  // member search) is gone; finding the person is a filter over the table.
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("members-filter").fill("dev");
  const roleCell = page.getByTestId("member-roles").first();
  await expect(roleCell).toBeVisible({ timeout: 8000 });
  // remember what this member IS: the cleanup below puts them back, and it must be their own tier
  // dev-user is the tenant's admin, and "demote the last admin" is refused by the server (correctly)
  const originalRole = (await roleCell.getByTestId("member-role-select").innerText()).trim();
  await roleCell.getByTestId("member-role-select").click();
  await page.getByRole("option", { name }).click();
  // #579 (2026-08-03): the row shows ONE role in its control — chips are gone with the additive model.
  await expect(roleCell.getByTestId("member-role-select")).toHaveText(name, { timeout: 8000 });

  // Put them back on a tier and delete the role (leave the board clean). #579 (2026-08-03): there is no
  // per-chip ×, because there are no chips — you move them to another value, which replaces.
  await roleCell.getByTestId("member-role-select").click();
  await page.getByRole("option", { name: originalRole, exact: true }).click();
  await expect(roleCell.getByTestId("member-role-select")).toHaveText(originalRole, { timeout: 8000 });
  await page.goto("/admin/roles");
  await page.getByTestId("custom-role-row").filter({ hasText: name }).getByTestId("role-delete").click();
  await page.getByTestId("role-delete-confirm").click(); // #504: delete confirms first
  await expect(page.getByTestId("roles-list")).not.toContainText(name, { timeout: 8000 });
});

// #420, RE-AIMED by #586②: whatbanned was the run-on "cap · cap · cap" line, and
// what replaced it has changed shape once more — at rest a built-in is its NAME, and hovering the name
// raises the measured "what it can do" window (the read-only grid rows left the list with the ruling
// ). What this keeps: the vocabulary rules — no run-on line,
// members picked by name, definitions tab defines only.
test("#420a built-in explains itself from its name, and members are picked by name", async ({ page }) => {
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });

  // hovering (here: tapping — the same controlled toggle) `manager` raises the measured list
  await page.getByTestId("role-tip-manager").click();
  // Radix renders the content twice (the floating tooltip + an offscreen aria copy) — read the one
  // inside the tooltip role, which is the one a person sees
  const tip = page.getByRole("tooltip").getByTestId("role-tip-manager-content");
  await expect(tip, "the manager name raises its capability window").toBeVisible({ timeout: 5000 });
  await expect(tip, "…including the verb the declared bundle omits (the store confers moderate)").toContainText(/Moderate|モデレート/);
  await page.getByTestId("role-tip-manager").click(); // fold it again
  await expect(page.getByTestId("roles-list"), "the cap · cap · cap text is gone").not.toContainText(" · ");

  // Theruling was about VOCABULARY — "never ask for an internal sub, search by name" — not about
  // which screen shows it. #514 slice 4 moved assignment to where each grant lives, so the property is
  // pinned there: the space Members tab still picks a person by name and resolves the principal itself.
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("space-grant-input").fill("e");
  const item = page.getByTestId("space-grant-candidate").first();
  await expect(item, "a tenant member matched the search").toBeVisible({ timeout: 8000 });
  const picked = (await item.innerText()).split("\n")[0]!.trim();
  await item.click();
  await expect(page.getByTestId("space-grant-input"), "the field now holds the person's NAME, not a sub").toHaveValue(picked);
  await expect(page.getByTestId("space-grant-candidates"), "the list closes once a member is chosen").toHaveCount(0);

  // …and the Roles tab no longer offers any assignment control at all (it DEFINES roles now).
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("assign-form"), "assignment left the definitions tab").toHaveCount(0);
});
