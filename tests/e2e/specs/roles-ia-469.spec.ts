import { test, expect } from "@playwright/test";
import { sleep, API } from "../helpers";

// #469 / #445 one place answers "what can this role do", and every built-in role reads the SAME
// way — a bold name + a CapabilityPicker. createSpaces is a capability inside the built-in TENANT list.
// admin's picker is read-only with createSpaces CHECKED (overturns #469's earlier "admin as plain text"
// choice — now that every built-in is a uniform read-only picker, a disabled admin cell reads as consistent,
// not broken). UI only: the member toggle still drives the very same tenant#space_creator wildcard through
// the unchanged endpoint.
test("#469: the roles tab lists built-ins by scope; the space-creation preset is a capability in that list", async ({ page }) => {
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });

  // 1. the old standalone preset section is gone (both the container and the dead admin control)
  await expect(page.getByTestId("tenant-defaults")).toHaveCount(0);
  await expect(page.getByTestId("default-admin-create-spaces")).toHaveCount(0);

  // 2. #536 ONE roles list — scope is a row badge, not a section split. admin stays a uniform
  // read-only picker with createSpaces checked+disabled.
  const tenantList = page.getByTestId("roles-list");
  await expect(tenantList).toBeVisible();
  await expect(page.getByTestId("builtin-tenant-roles")).toHaveCount(0); // the section split stays gone
  await expect(page.getByTestId("builtin-roles")).toHaveCount(0);
  const adminCap = page.getByTestId("builtin-admin-cap-createSpaces");
  await expect(adminCap).toBeVisible();
  await expect(adminCap).toBeChecked();
  await expect(adminCap).toBeDisabled();

  // 3. the member capability lives in that list and actually drives the server preset
  const member = tenantList.getByTestId("builtin-member-cap-createSpaces");
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
