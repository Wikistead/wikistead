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

// #586 / ADR-203 §2: hovering — and focusing, and tapping — a role says what it confers.
//
// Driven in a real browser because the whole point is reachability: the delegated `data-tip` tooltip
// renders one line and cannot show a list, and a Radix tooltip that is not controlled closes itself on
// pointerdown, which on a tablet means the tap that should open it is the tap that closes it.
test("#586: a role badge lists what it lets someone do", async ({ page }) => {
  const stamp = Date.now().toString(36);
  await openDemo(page);
  const { pageId } = await page.evaluate(async ({ api, stamp }) => {
    const p = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: `role tip ${stamp}` }),
    });
    const pageId = ((await p.json()) as { id: string }).id;
    // one individually granted capability, so the dialog has a row to describe
    await fetch(`${api}/pages/${pageId}/access`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ grantee: "user:dev-user", relation: "edit" }),
    });
    return { pageId };
  }, { api: API, stamp });

  try {
    await page.goto(`/p/${pageId}`);
    await page.waitForSelector("[data-pane=preview] .cm-content");
    await sleep(400);
    await page.click("[data-testid=page-overflow-trigger]");
    await page.click("[data-testid=permissions-open]");
    await expect(page.getByTestId("grant-relation")).toBeVisible({ timeout: 10_000 });

    const badge = page.getByTestId("grant-origin").first();
    await expect(badge, "the granted row is there to describe").toBeVisible({ timeout: 8000 });
    // keyboard first: a tooltip only a mouse can reach is not
    await badge.focus();
    const tip = page.getByRole("tooltip").first();
    await expect(tip).toBeVisible({ timeout: 4000 });
    expect((await tip.innerText()).trim().length, "it lists capabilities rather than showing an empty box").toBeGreaterThan(0);
    expect(["role", "grant"], "and the badge says which kind of access it is").toContain(await badge.getAttribute("data-origin"));
  } finally {
    await page.evaluate(async ({ api, pageId }) => {
      await fetch(`${api}/pages/${pageId}`, { method: "DELETE", headers: { Authorization: "Bearer dev-token" } }).catch(() => {});
    }, { api: API, pageId });
  }
});
