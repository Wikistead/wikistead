import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #513: the space Members & Permissions grant list showed the raw sub for user grantees, while the
// search that created them showed the display name — a granted member read as a hash. The list now
// resolves user subs through the same #379 member-identity path. Pinned with a member whose display
// name (an override) differs from their sub: the grant row must show the NAME, not the sub.
const H = { authorization: "Bearer dev-token", "content-type": "application/json" };

test("#513: a granted member shows their display name, not the sub", async ({ page }) => {
  await openDemo(page);

  // the dev member's own sub, and a display-name override distinct from it
  const sub = await page.evaluate(async () => {
    const me = await (await fetch("/api/auth/me", { headers: { authorization: "Bearer dev-token" } })).json();
    return me.sub as string;
  });
  expect(sub).toBeTruthy();
  const NAME = `Reviewer ${Date.now().toString(36)}`;
  await page.evaluate(async ({ name, h }) => {
    await fetch("/api/me/settings", { method: "PATCH", headers: h, body: JSON.stringify({ displayNameOverride: name }) });
  }, { name: NAME, h: H });

  // a fresh space, granted to that member directly through the API (bypassing the search UI)
  const spaceId = await page.evaluate(async ({ h }) => {
    const r = await fetch("/api/spaces", { method: "POST", headers: h, body: JSON.stringify({ name: `mem513-${Date.now().toString(36)}` }) });
    return (await r.json()).id as string;
  }, { h: H });
  await page.evaluate(async ({ id, u, h }) => {
    await fetch(`/api/spaces/${id}/access`, { method: "POST", headers: h, body: JSON.stringify({ grantee: `user:${u}`, relation: "moderate" }) });
  }, { id: spaceId, u: sub, h: H });

  await page.goto(`/spaces/${spaceId}/settings/members`);
  await expect(page.getByTestId("space-members")).toBeVisible();
  const row = page.getByTestId("space-grant-item").filter({ hasText: "moderator" });
  await expect(row, "the grant row resolves to the display name").toContainText(NAME, { timeout: 10000 });
  await expect(row, "…and not the raw sub").not.toContainText(sub);

  // cleanup: drop the override so the shared dev member isn't left renamed
  await page.evaluate(async ({ h }) => {
    await fetch("/api/me/settings", { method: "PATCH", headers: h, body: JSON.stringify({ displayNameOverride: null }) });
  }, { h: H });
  await sleep(100);
});
