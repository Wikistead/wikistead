import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";
import postgres from "postgres";
import { E2E } from "../fixtures";

// #513 / #523 (ADR-190): the space Members & Permissions grant list resolves a USER grantee to their
// full name (override ?? OIDC display_name) over the manage-gated set (slice A/D) — so an UN-CUSTOMIZED
// member reads as their IdP name, not a raw sub. And an OIDC member cannot override that name (slice B).
// The original #513 spec pinned this via a display_name OVERRIDE; slice B closes that path for OIDC users,
// so this pins the IdP name directly (set on members.display_name, no override) + the 403 refusal.
const H = { authorization: "Bearer dev-token", "content-type": "application/json" };

test("#523: a granted member shows their OIDC display name (not the sub); the OIDC override is refused", async ({ page }) => {
  const sql = postgres(E2E.pgAdmin);
  const NAME = `Reviewer Aiko ${Date.now().toString(36)}`;
  try {
    await openDemo(page);
    const sub = await page.evaluate(async () =>
      (await (await fetch("/api/auth/me", { headers: { authorization: "Bearer dev-token" } })).json()).sub as string);
    expect(sub).toBe("dev-user");

    // dev-user is an OIDC member whose seeded display_name equals their sub; give them a DISTINCT IdP name
    // (via members.display_name — the login-upsert path, NOT an override) and clear any residue override.
    await sql`UPDATE members SET display_name = ${NAME}, display_name_override = NULL WHERE sub = 'dev-user'`;

    // slice B: an OIDC member cannot override their display name — the account PATCH is refused (403).
    const status = await page.evaluate(async ({ h }) =>
      (await fetch("/api/me/settings", { method: "PATCH", headers: h, body: JSON.stringify({ displayNameOverride: "Impostor" }) })).status, { h: H });
    expect(status, "an OIDC member's override is refused (slice B)").toBe(403);

    // a fresh space, granted to dev-user directly through the API (bypassing the search UI)
    const spaceId = await page.evaluate(async ({ h }) =>
      (await (await fetch("/api/spaces", { method: "POST", headers: h, body: JSON.stringify({ name: `mem523-${Date.now().toString(36)}` }) })).json()).id as string, { h: H });
    await page.evaluate(async ({ id, u, h }) => {
      await fetch(`/api/spaces/${id}/access`, { method: "POST", headers: h, body: JSON.stringify({ grantee: `user:${u}`, relation: "moderate" }) });
    }, { id: spaceId, u: sub, h: H });

    await page.goto(`/spaces/${spaceId}/settings/members`);
    await expect(page.getByTestId("space-members")).toBeVisible();
    const row = page.getByTestId("space-grant-item").filter({ hasText: "moderator" });
    await expect(row, "the grant row resolves to the IdP display name (slice A/D)").toContainText(NAME, { timeout: 10000 });
    await expect(row, "…and not the raw sub").not.toContainText(sub);
  } finally {
    await sql`UPDATE members SET display_name = 'dev-user', display_name_override = NULL WHERE sub = 'dev-user'`; // restore the seed (clears any residue)
    await sql.end();
  }
});
