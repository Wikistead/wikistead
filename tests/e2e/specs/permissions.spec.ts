import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// Phase 4c: the per-page Permissions dialog (manager only). Grant a member access
// (this is also how you invite someone to a draft) and revoke it.
const API = "http://dev.localhost:4010";

test("manager grants and revokes page access via the Permissions dialog", async ({ page }) => {
  await openDemo(page);
  const pageId = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "perms page" }),
    });
    return (await r.json()).id as string;
  }, API);

  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  // the creator (dev-user) has manage → the Permissions control is offered
  await page.waitForSelector("[data-testid=permissions-open]");
  await page.click("[data-testid=permissions-open]");
  await expect(page.locator("[data-testid=permissions-dialog]")).toBeVisible();

  // the creator's own grant is listed
  await expect(page.locator("[data-testid=grant-list]")).toContainText("dev-user");

  // grant alice-perm view → appears in the list
  await page.fill("[data-testid=grant-sub]", "alice-perm");
  await page.selectOption("[data-testid=grant-relation]", "view");
  await page.click("[data-testid=grant-add]");
  const row = page.locator("[data-testid=grant-item]", { hasText: "alice-perm" });
  await expect(row).toBeVisible();

  // revoke → disappears
  await row.locator("[data-testid=grant-revoke]").click();
  await expect(page.locator("[data-testid=grant-item]", { hasText: "alice-perm" })).toHaveCount(0);

  // server reflects the revoke (no alice-perm grant remains)
  await sleep(200);
  const grants = await page.evaluate(async ({ api, pageId }) => {
    return (await (await fetch(`${api}/pages/${pageId}/access`, { headers: { Authorization: "Bearer dev-token" } })).json()) as { grantee: string }[];
  }, { api: API, pageId });
  expect(grants.some((g) => g.grantee === "user:alice-perm")).toBe(false);
});
