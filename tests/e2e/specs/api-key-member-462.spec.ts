import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #462: a member can issue their own API key from their account settings, and the tenant can take
// that away. The e2e session is an admin, so what is pinned here is the SURFACE — the member tab
// exists, issues, lists owner-scoped keys, and honours the tenant policy — while the server-side
// refusals for a non-admin member live in api-key-policy-462.test.ts (real sessions, real FGA).

const setIssuePolicy = (page: import("@playwright/test").Page, policy: "members" | "admins_only") =>
  page.evaluate(async (p) => {
    const r = await fetch("http://dev.localhost:4010/admin/api-policy", {
      method: "PATCH",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ issuePolicy: p }),
    });
    return r.status;
  }, policy);

test.afterEach(async ({ page }) => {
  await setIssuePolicy(page, "members").catch(() => {});
});

test("#462: a member issues and revokes their own key from account settings", async ({ page }) => {
  await openDemo(page);
  expect(await setIssuePolicy(page, "members")).toBe(204);

  await page.goto("/settings/account/api-keys");
  await expect(page.getByTestId("account-api-keys"), "the settings tree has a place for a member's own keys").toBeVisible();
  await expect(page.getByTestId("api-keys-restricted")).toHaveCount(0);

  const name = `member-key-${Date.now()}`;
  await page.getByTestId("api-key-name").fill(name);
  await page.getByTestId("api-key-create").click();
  const plaintext = (await page.getByTestId("api-key-plaintext").locator("code").textContent())!.trim();
  expect(plaintext, "the plaintext is shown once, here").toContain("wks_");

  const row = page.locator("[data-testid=api-key-item]", { hasText: name });
  await expect(row).toBeVisible();

  // it is a real key: it authenticates a request
  const status = await page.evaluate(async (key) => {
    const r = await fetch("http://dev.localhost:4010/spaces", { headers: { Authorization: `Bearer ${key}` } });
    return r.status;
  }, plaintext);
  expect(status).toBeLessThan(400);

  await row.getByTestId("api-key-revoke").click();
  await expect(row, "and the owner can revoke it from the same screen").toHaveCount(0, { timeout: 8000 });
});

test("#462: the admin sets who may issue, and the member surface follows what the SERVER says the caller may do", async ({ page }) => {
  await openDemo(page);

  // The switch lives in the admin console next to the scope ceiling.
  await page.goto("/admin/api");
  await expect(page.getByTestId("admin-api")).toBeVisible();
  await page.getByTestId("api-issue-policy").click();
  await page.getByRole("option", { name: /Administrators only|管理者のみ/ }).click();
  await sleep(500);

  // it persisted — this is the server's answer, not a local toggle
  await page.reload();
  await expect(page.getByTestId("api-issue-policy")).toHaveText(/Administrators only|管理者のみ/);

  // This session is an ADMIN, so under "administrators only" they may still issue — and the member
  // screen keeps offering the form, because it follows `canIssue` (what the server would allow THIS
  // caller) rather than the policy name. A non-admin member gets the refusal and the explanation;
  // that half needs a real non-admin session and is pinned in api-key-policy-462.test.ts.
  const policy = await page.evaluate(async () => {
    const r = await fetch("http://dev.localhost:4010/api-keys/policy", { headers: { Authorization: "Bearer dev-token" } });
    return r.json() as Promise<{ policy: string; canIssue: boolean }>;
  });
  expect(policy).toMatchObject({ policy: "admins_only", canIssue: true });

  await page.goto("/settings/account/api-keys");
  await expect(page.getByTestId("api-keys-restricted"), "an admin is not told they are restricted").toHaveCount(0);
  await expect(page.getByTestId("api-key-create"), "…and they can still issue from their own settings").toBeVisible();
});
