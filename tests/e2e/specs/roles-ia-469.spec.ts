import { test, expect } from "@playwright/test";
import { sleep } from "../helpers";

// #469: one place answers "what can this role do". The separate "Default tenant roles" section is
// gone — createSpaces is a capability inside the built-in TENANT role list, and admin's is stated
// once as text instead of a permanently disabled checkbox (which read as broken, and repeated a
// fact the body copy and tooltip already carried). UI only: the member toggle still drives the very
// same tenant#space_creator wildcard through the unchanged endpoint.
test("#469: the roles tab lists built-ins by scope; the space-creation preset is a capability in that list", async ({ page }) => {
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });

  // 1. the old standalone preset section is gone (both the container and the dead admin control)
  await expect(page.getByTestId("tenant-defaults")).toHaveCount(0);
  await expect(page.getByTestId("default-admin-create-spaces")).toHaveCount(0);

  // 2. built-ins are grouped by scope, and admin's create-spaces shows ONCE, as text
  const tenantList = page.getByTestId("builtin-tenant-roles");
  await expect(tenantList).toBeVisible();
  await expect(page.getByTestId("builtin-roles")).toBeVisible(); // resource-scope list
  const adminRow = page.getByTestId("builtin-role-admin");
  await expect(adminRow).toBeVisible();
  expect(await adminRow.locator("input").count(), "no control on the admin row").toBe(0);

  // 3. the member toggle lives in that list and actually drives the server preset
  const member = tenantList.getByTestId("default-member-create-spaces");
  await expect(member).toBeEnabled({ timeout: 8000 });
  const read = () =>
    page.evaluate(async () => {
      const r = await fetch("http://dev.localhost:4010/admin/roles/tenant-defaults", { headers: { Authorization: "Bearer dev-token" } });
      return (await r.json()) as { member: { createSpaces: boolean } };
    });
  const initial = (await read()).member.createSpaces;
  await member.click();
  await expect.poll(() => read().then((d) => d.member.createSpaces), { timeout: 8000 }).toBe(!initial);
  await member.click(); // restore the seeded default
  await expect.poll(() => read().then((d) => d.member.createSpaces), { timeout: 8000 }).toBe(initial);
  await sleep(200);
});
