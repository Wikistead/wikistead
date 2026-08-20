import { test, expect } from "@playwright/test";
import { sleep, API } from "../helpers";

// #469 / #445one place answers "what can this role do", and the tenant's member policy is
// configured on that same screen.
//
// RE-AIMED TWICE, both by reviews on #586, and the subject survived both. First: every built-in
// stopped drawing a read-only capability grid — a nine-column lattice per row is the forced-reading shape
// the ruling rejected, so a role at rest is its NAME and hovering it raises the measured window. Then
// the `member` row kept an editable grid, because its boxes were really the TENANT DEFAULTS in a role
// row's clothes — why does only the built-in member row show a permission-editing UI, when built-ins
// are meant to stay fixed and steer customization toward the paid tier? The defaults are their own
// section now. What this still pins: one screen, the
// built-ins listed by scope, and the member preset driving the very same tenant#space_creator wildcard
// through the unchanged endpoint.
test("#469: the roles tab lists built-ins by scope; the member preset is configured on it", async ({ page }) => {
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });

  // 1. the old standalone preset section is gone (the dead admin control with it)
  await expect(page.getByTestId("default-admin-create-spaces")).toHaveCount(0);

  // 2. #536ONE roles list — scope is a section, not a per-row badge. Every built-in row is a
  // name; none of them carries an editing surface (the 2026-08-04 ruling: a built-in has no freedom).
  const tenantList = page.getByTestId("roles-list");
  await expect(tenantList).toBeVisible();
  await expect(page.getByTestId("builtin-tenant-roles")).toHaveCount(0); // the section split stays gone
  await expect(page.getByTestId("builtin-roles")).toHaveCount(0);
  await expect(page.getByTestId("role-tip-admin"), "admin says what it confers by name").toBeVisible();
  await expect(page.getByTestId("role-tip-member"), "and so does member — same shape").toBeVisible();
  for (const row of ["admin", "member"]) {
    const boxes = page.getByTestId(`builtin-role-${row}`).locator("input[type=checkbox]");
    expect(await boxes.count(), `the ${row} row offers no editing surface`).toBe(0);
  }

  // 3. the member preset lives in its own section and actually drives the server preset
  const member = page.getByTestId("member-defaults").getByTestId("member-defaults-cap-createSpaces");
  await expect(member).toBeEnabled({ timeout: 8000 });
  const read = () =>
    page.evaluate(async (api) => {
      const r = await fetch(`${api}/admin/roles/tenant-defaults`, { headers: { Authorization: "Bearer dev-token" } });
      return (await r.json()) as { member: { createSpaces: boolean } };
    }, API);
  const initial = (await read()).member.createSpaces;
  await member.click();
  await expect.poll(() => read().then((d) => d.member.createSpaces), { timeout: 8000 }).toBe(!initial);
  await member.click(); // restore the seeded default
  await expect.poll(() => read().then((d) => d.member.createSpaces), { timeout: 8000 }).toBe(initial);
  await sleep(200);
});

// #578 / ADR-201 slice 7: the group→role MAPPING section is gone from this tab. It was the last place
// the mechanism could be reached (space mappings went in slice 3), and it survived the slice that
// reported the work complete — so its absence is asserted here rather than assumed. A group takes a
// tenant role from the group section on the Members page (#579), which tenant-role-rows-579 covers.
test("#578: the tenant Roles tab no longer maps groups to roles", async ({ page }) => {
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });
  for (const id of ["mapping-form", "mapping-group", "mapping-role", "mapping-add", "mapping-list", "mapping-tenant-note"]) {
    await expect(page.getByTestId(id), `${id} belongs to the retired mapping surface`).toHaveCount(0);
  }
  // and the heading with it — a section whose controls are gone but whose title remains reads as broken
  await expect(page.getByText("Group mappings", { exact: true })).toHaveCount(0);
  await expect(page.getByText("グループマッピング", { exact: true })).toHaveCount(0);
});
