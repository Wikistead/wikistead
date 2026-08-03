import { test, expect } from "@playwright/test";
import { sleep } from "../helpers";

// #579: /admin/members has ONE place where a tenant role is given or taken — the member's own row.
// The screen used to have two: a Select on the row for the built-in role, and a separate form above
// the table (its own role picker, its own member search) for custom roles. The user found the second
// one by accident: "oh, THAT's what the top half was".
//
// Real Chromium, because what is being pinned is the screen: a chip appears on the right row, a second
// chip appears beside it (custom roles are a SET), removing one leaves the other (removal is per
// assignment — reference counting, not per capability), and the built-in Select still does what
// it always did (it is EXACTLY ONE — a column on the member).
test("#579: tenant roles live on the member row, and only there", async ({ page, request }) => {
  const stamp = Date.now();
  const roleA = `e2e-579a-${stamp}`;
  const roleB = `e2e-579b-${stamp}`;
  const mk = async (name: string) => {
    const res = await request.post("/api/admin/roles", {
      headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
      data: { name, capabilities: ["createSpaces"], scope: "tenant" },
    });
    expect(res.status(), `create ${name}`).toBe(201);
    return (await res.json()).id as string;
  };
  const idA = await mk(roleA);
  const idB = await mk(roleB);

  try {
    await page.goto("/admin/members");
    await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 10_000 });

    // the old surface is gone — not hidden, GONE
    await expect(page.getByTestId("tenant-assign-form")).toHaveCount(0);
    await expect(page.getByTestId("tenant-assignment-list")).toHaveCount(0);

    // narrow to ONE member with the table filter, then work on that row — the fixture's display name
    // is not something this spec should hard-code (it differs between the dev and e2e seeds)
    await page.getByTestId("members-filter").fill("dev");
    await expect(page.getByTestId("member-roles").first()).toBeVisible({ timeout: 8000 });
    const rowRoles = page.getByTestId("member-roles").first();

    // RE-AIMED by #579 (2026-08-03 ruling): . This used to add roleA, then add
    // roleB beside it, then remove one and check the other survived — the additive model. The server now
    // converges a tenant principal to ONE role, so that sequence describes a state the mechanism does not
    // produce. What replaces it is the property a person can see: the control SHOWS the role they have,
    // and choosing another REPLACES it (across a reload, so it is the server's answer and not local
    // state). The per-assignment removal it used to prove has moved to where stacking still happens
    // the space composite's two arms, in builtin-grant-equivalence-514.
    await rowRoles.getByTestId("member-role-select").click();
    await expect(page.getByRole("option", { name: roleA }), "every tenant role is offered, held or not").toBeVisible();
    await page.getByRole("option", { name: roleA }).click();
    await expect(rowRoles.getByTestId("member-role-select"), "the control now shows what they have").toHaveText(roleA, { timeout: 8000 });

    await page.reload();
    await page.getByTestId("members-filter").fill("dev");
    const after = page.getByTestId("member-roles").first();
    await expect(after.getByTestId("member-role-select"), "and it survives a reload — the server said so").toHaveText(roleA, { timeout: 10_000 });

    // choosing another REPLACES: one role, and the previous one is not beside it
    await after.getByTestId("member-role-select").click();
    await page.getByRole("option", { name: roleB }).click();
    await expect(after.getByTestId("member-role-select")).toHaveText(roleB, { timeout: 8000 });
    await page.reload();
    await page.getByTestId("members-filter").fill("dev");
    const reloaded = page.getByTestId("member-roles").first();
    await expect(reloaded.getByTestId("member-role-select"), "the replacement stuck").toHaveText(roleB, { timeout: 10_000 });
    await expect(reloaded.getByTestId("member-role-chip"), "no chips: there is no set to draw").toHaveCount(0);
    await expect(reloaded.getByTestId("member-tier-chip")).toHaveCount(0);

    // the filter narrows the table — the search that used to live inside the assign form
    await page.getByTestId("members-filter").fill("nobody-matches-this");
    await expect(page.getByTestId("member-roles")).toHaveCount(0, { timeout: 8000 });
    await page.getByTestId("members-filter").fill("dev");
    await expect(page.getByTestId("member-roles").first()).toBeVisible();
  } finally {
    for (const id of [idA, idB]) {
      await request.delete(`/api/admin/roles/${id}`, { headers: { authorization: "Bearer dev-token" } }).catch(() => {});
    }
  }
});

// Groups are not people: they have no row in the member table, so their tenant roles live in their own
// section — the same split the space screen makes. This also exercises GET /admin/groups, the
// tenant-scope name source #579 added (the existing one was space-scoped and needed a space id).
test("#579: a group gets a tenant role from its own section, by NAME", async ({ page, request }) => {
  const stamp = Date.now();
  const roleName = `e2e-579g-${stamp}`;
  const res = await request.post("/api/admin/roles", {
    headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
    data: { name: roleName, capabilities: ["createSpaces"], scope: "tenant" },
  });
  expect(res.status()).toBe(201);
  const roleId = (await res.json()).id as string;

  try {
    await page.goto("/admin/members");
    const section = page.getByTestId("tenant-group-roles");
    await expect(section).toBeVisible({ timeout: 10_000 });

    // #578 bounce ②: ONE input with completion, not a Select stacked on an Input. The e2e tenant has no
    // IdP groups, so this drives the half that used to be impossible here — a name nobody carries yet,
    // which the screen must keep (bounce ①) and mark rather than turning into "unknown group".
    const groupName = `e2e-579-group-${stamp}`;
    await section.getByTestId("tenant-group-assign-group-name").fill(groupName);
    await expect(
      section.getByTestId("tenant-group-assign-group-unconfirmed"),
      "a name the directory has not produced says so",
    ).toBeVisible();
    await section.getByTestId("tenant-group-assign-role").click();
    await page.getByRole("option", { name: roleName }).click();
    await section.getByTestId("tenant-group-assign-add").click();

    const row = section.getByTestId("tenant-group-role-row").filter({ hasText: groupName });
    await expect(row, "the group appears with its NAME, never a hash").toBeVisible({ timeout: 8000 });
    await expect(row).not.toContainText(/[0-9a-f]{24}/);
    await row.getByTestId("tenant-group-role-remove").first().click();
    await expect(section.getByTestId("tenant-group-role-row").filter({ hasText: groupName })).toHaveCount(0, { timeout: 8000 });
  } finally {
    await request.delete(`/api/admin/roles/${roleId}`, { headers: { authorization: "Bearer dev-token" } }).catch(() => {});
  }
});
