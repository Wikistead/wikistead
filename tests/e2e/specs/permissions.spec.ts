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
  // the creator (dev-user) has manage → Permissions is offered in the ••• menu
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=permissions-open]");
  await expect(page.locator("[data-testid=permissions-dialog]")).toBeVisible();

  // the creator's own grant is listed
  await expect(page.locator("[data-testid=grant-list]")).toContainText("dev-user");

  // grant alice-perm view → appears in the list
  await page.fill("[data-testid=grant-sub]", "alice-perm");
  await page.getByTestId("grant-relation").click();
  await page.getByTestId("grant-relation-view").click();
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

// #109 / ADR-098: the PRIVATE (allowlist) toggle in the Permissions dialog. Turning it on makes the
// page private on the server (only the allow list can access); turning it off clears it. Verified in a
// real browser against the e2e server.
test("manager toggles a page private (allowlist) via the Permissions dialog", async ({ page }) => {
  await openDemo(page);
  const pageId = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "private page" }),
    });
    return (await r.json()).id as string;
  }, API);

  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=permissions-open]");
  await expect(page.locator("[data-testid=permissions-dialog]")).toBeVisible();

  const toggle = page.locator("[data-testid=private-toggle]");
  await expect(toggle).not.toBeChecked(); // starts non-private

  const isPrivate = async () => page.evaluate(async ({ api, pageId }) =>
    (await (await fetch(`${api}/pages/${pageId}/private`, { headers: { Authorization: "Bearer dev-token" } })).json()).private as boolean,
    { api: API, pageId });

  // turn private ON → the controlled checkbox re-checks once the server round-trip completes.
  await toggle.click();
  await expect(toggle).toBeChecked(); // retries until the mutation + refetch land
  expect(await isPrivate()).toBe(true);
  await expect(page.locator("[data-testid=permissions-dialog]")).toContainText(/Allow list|許可リスト/);

  // turn private OFF → server clears it
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(await isPrivate()).toBe(false);
});
