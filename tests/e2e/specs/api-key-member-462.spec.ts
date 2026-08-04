import { test, expect } from "@playwright/test";
import { openDemo, API } from "../helpers";

// #462, updated for #496 / ADR-181: a member can issue their own API key from their account settings,
// and the tenant can take that away. What changed is WHERE the tenant says so: the two-choice
// `/admin/api` policy selector is gone, and issuance is the `issueApiKeys` tenant capability configured
// on the Roles tab (the built-in `member` toggle here; a custom tenant role for specific people).
// The e2e session is an admin, so what is pinned here is the SURFACE — the member tab exists, issues,
// lists owner-scoped keys, and follows what the server says THIS caller may do — while the server-side
// refusals for a real non-admin member live in api-key-issue-capability-496.test.ts (real sessions, real FGA).

// The member toggle, driven through the same endpoint the Roles tab uses.
const setMemberIssue = (page: import("@playwright/test").Page, on: boolean) =>
  page.evaluate(async ({ v, api }) => {
    const r = await fetch(`${api}/admin/roles/tenant-defaults`, {
      method: "PUT",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ memberIssueApiKeys: v }),
    });
    return r.status;
  }, { v: on, api: API });

test.afterEach(async ({ page }) => {
  // Back to the model default (admin-only): provisioning seeds no member tuple.
  await setMemberIssue(page, false).catch(() => {});
});

test("#462: a member issues and revokes their own key from account settings", async ({ page }) => {
  await openDemo(page);
  expect(await setMemberIssue(page, true)).toBe(200);

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
  const status = await page.evaluate(async ({ key, api }) => {
    const r = await fetch(`${api}/spaces`, { headers: { Authorization: `Bearer ${key}` } });
    return r.status;
  }, { key: plaintext, api: API });
  expect(status).toBeLessThan(400);

  await row.getByTestId("api-key-revoke").click();
  await page.getByTestId("api-key-revoke-confirm").click(); // #504: revoke confirms first
  await expect(row, "and the owner can revoke it from the same screen").toHaveCount(0, { timeout: 8000 });
});

test("#496: the Roles tab is where issuance is granted, and the member surface follows what the SERVER says", async ({ page }) => {
  await openDemo(page);
  await setMemberIssue(page, false); // start from the default so the checkbox has somewhere to go

  // The control lives with every other capability now — not in /admin/api.
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible();
  // #586 (2026-08-04): the toggle lives in the tenant's "member defaults" section now — a built-in role
  // row has no editing surface, and this switch was never the role's anyway (it is a tenant policy).
  const memberIssue = page.getByTestId("member-defaults-cap-issueApiKeys");
  await expect(memberIssue, "the tenant's member policy carries the capability checkbox").toBeVisible();
  await expect(memberIssue).not.toBeChecked();
  // click(), not check(): the box is CONTROLLED by the server's answer, so it flips only after the PUT
  // and the refetch land. check() asserts the state changed synchronously and would fail on the round-trip.
  await memberIssue.click();
  await expect(memberIssue, "the toggle reflects the tuple the server wrote").toBeChecked();

  // it persisted — this is the server's answer (an FGA tuple), not a local toggle
  await page.reload();
  await expect(page.getByTestId("member-defaults-cap-issueApiKeys")).toBeChecked();

  // …and the old two-choice selector is gone from the API console (one authority, one screen).
  await page.goto("/admin/api");
  await expect(page.getByTestId("admin-api")).toBeVisible();
  await expect(page.getByTestId("api-issue-policy"), "#496 retired the policy enum and its selector").toHaveCount(0);

  // The member surface follows `canIssue` — what the server would allow THIS caller — with no policy
  // name in the payload any more. A non-admin member's refusal is pinned server-side (496 suite).
  const policy = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/api-keys/policy`, { headers: { Authorization: "Bearer dev-token" } });
    return r.json() as Promise<{ canIssue: boolean; policy?: string }>;
  }, API);
  expect(policy.canIssue).toBe(true);
  expect(policy.policy, "the retired enum field is not served any more").toBeUndefined();

  await page.goto("/settings/account/api-keys");
  await expect(page.getByTestId("api-keys-restricted"), "an admin is not told they are restricted").toHaveCount(0);
  await expect(page.getByTestId("api-key-create"), "…and they can still issue from their own settings").toBeVisible();
});
