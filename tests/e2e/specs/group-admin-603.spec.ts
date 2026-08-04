import { test, expect } from "@playwright/test";
import { API } from "../helpers";

// #603 / ADR-207 (overturns ADR-201 §1): a group may hold the tenant tier. Measured in a real browser
// because the complaint was about what the SCREEN offered: the group picker was the one picker in the
// product that hid half its vocabulary, and a note explained the hole instead of the product filling
// it. The FGA side (tuple lands, floor 409 with its reason, revoke never gated) is pinned against a
// real store in group-tier-603.test.ts; this pins the surface that grants it.
test("#603: a group is offered the tiers, granted admin, shown holding it — and the note is gone", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now().toString(36);
  const roleName = `g603-${stamp}`;
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 15_000 });

  // a custom tenant role, so the list's SHAPE is provable: tiers AND custom roles, one list
  await page.evaluate(async ({ api, name }) => {
    await fetch(`${api}/admin/roles`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ name, capabilities: ["createSpaces"], scope: "tenant" }),
    });
  }, { api: API, name: roleName });
  await page.reload();
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 15_000 });

  // the note that explained the tiers' absence went with the absence
  await expect(page.getByTestId("tenant-group-tiers-note"), "the absence-explaining note is gone").toHaveCount(0);

  // the add-form's role list carries the WHOLE vocabulary: both tiers and the custom role
  await page.getByTestId("tenant-grant-group-name").fill(`Adm603-${stamp}`);
  await page.getByTestId("tenant-grant-role").click();
  for (const name of ["member", "admin", roleName]) {
    await expect(page.getByRole("option", { name, exact: true }), `the list offers ${name}`).toBeVisible();
  }
  await page.getByRole("option", { name: "admin", exact: true }).click();
  await page.getByTestId("tenant-grant-add").click();

  // the group comes back as a row whose control READS the tier it holds
  await page.getByTestId("members-filter").fill(`Adm603-${stamp}`);
  const row = page.getByTestId("member-row-group").filter({ hasText: `Adm603-${stamp}` });
  await expect(row, "the group is a row in the member table").toBeVisible({ timeout: 10_000 });
  await expect(row.getByTestId("member-role-select"), "its control shows the tier").toContainText("admin");

  // …and it survives a reload (the row is drawn from the assignments listing — the LEFT-JOIN fix;
  // before it, a built-in row never came back and the screen forgot the grant it had just made)
  await page.reload();
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("members-filter").fill(`Adm603-${stamp}`);
  const rowAfter = page.getByTestId("member-row-group").filter({ hasText: `Adm603-${stamp}` });
  await expect(rowAfter, "the grant is still there after a reload").toBeVisible({ timeout: 10_000 });
  await expect(rowAfter.getByTestId("member-role-select")).toContainText("admin");

  // one role per principal: picking the custom role REPLACES the tier (server convergence)
  await rowAfter.getByTestId("member-role-select").click();
  await page.getByRole("option", { name: roleName, exact: true }).click();
  // the row keeps its NAME across the replacement: the re-assign travels by principal, and the typed
  // name must be inherited from the folded row (measured red before carriedGroupName: the group came
  // back as "unknown group" and vanished from this very filter)
  await expect(rowAfter.getByTestId("member-role-select"), "the pick replaced the tier").toContainText(roleName, { timeout: 10_000 });

  // choosing the placeholder is the revocation. A group's row exists BECAUSE of its assignments
  // (#579: no member row to hang it on), so with the last grant gone the row leaves the table.
  await rowAfter.getByTestId("member-role-select").click();
  await page.getByRole("option", { name: "Select role" }).click();
  await expect(rowAfter, "with no grant left, the group leaves the table").toHaveCount(0, { timeout: 10_000 });
});
