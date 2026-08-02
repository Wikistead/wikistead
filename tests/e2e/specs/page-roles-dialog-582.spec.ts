import { test, expect } from "@playwright/test";
import { API, openDemo, sleep } from "../helpers";

// #582 / ADR-202 §1: the page permissions dialog offers custom roles in the SAME picker as the five
// capabilities, and a role-conferred grant is its own row, revoked by unassigning.
//
// The row kind matters for a reason that is not cosmetic: revoking a role-owned capability through the
// grant path answers success, writes an audit entry and fires a webhook while changing nothing in FGA.
// A row offering that button would be a button that lies.
test("#582: the page dialog offers custom roles beside the capabilities, and role rows unassign", async ({ page }) => {
  const stamp = Date.now().toString(36);
  const roleName = `e2e-pagerole-${stamp}`;
  await openDemo(page);

  const { pageId, roleId } = await page.evaluate(async ({ api, roleName }) => {
    const p = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: `page roles ${roleName}` }),
    });
    const r = await fetch(`${api}/admin/roles`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ name: roleName, capabilities: ["view", "comment"], scope: "resource" }),
    });
    return { pageId: ((await p.json()) as { id: string }).id, roleId: ((await r.json()) as { id: string }).id };
  }, { api: API, roleName });

  try {
    await page.goto(`/p/${pageId}`);
    await page.waitForSelector("[data-pane=preview] .cm-content");
    await sleep(400);
    await page.click("[data-testid=page-overflow-trigger]");
    await page.click("[data-testid=permissions-open]");
    await expect(page.getByTestId("grant-relation")).toBeVisible({ timeout: 10_000 });

    // ONE picker: the five capabilities AND the tenant's resource-scope custom roles
    await page.getByTestId("grant-relation").click();
    await expect(page.getByRole("option", { name: roleName }), "the custom role is in the same list").toBeVisible({ timeout: 8000 });
    await page.getByRole("option", { name: roleName }).click();

    // grant it to a member, and the row reads as the ROLE rather than as its capabilities
    await page.getByTestId("grant-sub").fill("dev-user");
    await sleep(400);
    const candidate = page.getByTestId("grant-candidate").first();
    if (await candidate.count()) await candidate.click();
    await page.getByTestId("grant-add").click();

    const roleRow = page.getByTestId("grant-role-item").filter({ hasText: roleName });
    await expect(roleRow, "a role is one row, not its expansion").toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId("grant-item").filter({ hasText: "comment" }), "the role's capabilities are not enumerated as grants").toHaveCount(0);

    // and it is revoked by unassigning, not by the capability ×
    await roleRow.getByTestId("grant-role-revoke").click();
    await expect(page.getByTestId("grant-role-item").filter({ hasText: roleName })).toHaveCount(0, { timeout: 8000 });
  } finally {
    await page.evaluate(async ({ api, roleId, pageId }) => {
      await fetch(`${api}/admin/roles/${roleId}`, { method: "DELETE", headers: { Authorization: "Bearer dev-token" } }).catch(() => {});
      await fetch(`${api}/pages/${pageId}`, { method: "DELETE", headers: { Authorization: "Bearer dev-token" } }).catch(() => {});
    }, { api: API, roleId, pageId });
  }
});
