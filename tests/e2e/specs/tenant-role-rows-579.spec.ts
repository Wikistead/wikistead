import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { sleep } from "../helpers";

/**
 * Narrow the member table, and do not come back until the SERVER has answered.
 *
 * #623 slice 2 (63665f68) made this filter a debounced server query — 250ms, then a fetch, then the
 * table re-renders with what the server matched. Every caller below then acts on a ROW, and typing
 * and acting straight away acts on the PRE-filter page: the response lands mid-interaction and takes
 * the row (and any Select opened on it) with it. Measured here as "option not found" — the dropdown
 * was open, the re-render unmounted it, and the options it was holding stopped existing — and in
 * `admin-roles-420` as the option node detaching mid-click. One race, two faces.
 *
 * Waiting for the response is not enough on its own: the response arriving and the row being redrawn
 * are two moments, so the caller must also wait for the row it wants. Callers below do that with the
 * assertion they were already making.
 */
async function filterMembers(page: Page, q: string): Promise<void> {
  const landed = page.waitForResponse((r) => r.url().includes(`q=${encodeURIComponent(q)}`), { timeout: 15_000 });
  await page.getByTestId("members-filter").fill(q);
  await landed;
}

// #579: /admin/members has ONE place where a tenant role is given or taken — the member's own row.
// The screen used to have two: a Select on the row for the built-in role, and a separate form above
// the table (its own role picker, its own member search) for custom roles. The user found the second
// one by accident: "oh, THAT's what the top half was".
//
// Real Chromium, because what is being pinned is the screen: a chip appears on the right row, a second
// chip appears beside it (custom roles are a SET), removing one leaves the other (removal is per
// assignment — reference counting, not per capability), and the built-in Select still does what
// it always did (it is EXACTLY ONE — a column on the member).
const H = { authorization: "Bearer dev-token", "content-type": "application/json" };
// A bodyless DELETE must NOT announce a JSON body: Fastify answers 400 FST_ERR_CTP_EMPTY_JSON_BODY, which
// is not the 409 this cleanup is about and which the old `.catch` also swallowed.
const H_NO_BODY = { authorization: "Bearer dev-token" };

/**
 * Remove a fixture role — assignments first.
 *
 * `DELETE /admin/roles/:id` answers 409 while the role is still assigned ("unassign first", roles.ts), and
 * Playwright's `request.delete` RESOLVES on 409, so a `.catch()` never fires and the refusal is dropped on
 * the floor. Measured: this file left one role behind per run — 22 of them had collected in the shared
 * tenant, which is what made #582's picker walks order-dependent. The status is asserted now, so the next
 * time cleanup stops working this test says so instead of quietly growing the tenant.
 */
async function removeRole(request: APIRequestContext, ids: string[]): Promise<void> {
  const me = await request.get("/api/auth/me", { headers: H_NO_BODY });
  const tid = me.ok() ? ((await me.json()) as { tenantId?: string }).tenantId ?? "tenant_dev" : "tenant_dev";
  const list = await request.get(`/api/admin/roles/assignments?resourceType=tenant&resourceId=${tid}`, { headers: H_NO_BODY });
  if (list.ok()) {
    const body = (await list.json()) as { assignments?: { id: string; roleId: string | null }[] } | { id: string; roleId: string | null }[];
    const all = Array.isArray(body) ? body : (body.assignments ?? []);
    for (const a of all.filter((x) => x.roleId != null && ids.includes(x.roleId))) {
      await request.delete(`/api/admin/roles/assignments/${a.id}`, { headers: H_NO_BODY });
    }
  }
  for (const id of ids) {
    const res = await request.delete(`/api/admin/roles/${id}`, { headers: H_NO_BODY });
    expect(res.status(), `the fixture role was removed (a 409 here means an assignment outlived it)`).toBeLessThan(300);
  }
}

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
    // OVERRIDDEN (user ruling, 2026-08-04): this used to pin the add flow to groups only ("a person's
    // tenant role is given on their row and nowhere else"), and the review overturned it
    // user/group toggle the space screen has; the ROW still works (below, unchanged), and both doors
    // converge on the server's one-role-per-principal state, so this is a second door, not a second state.
    await expect(page.getByTestId("tenant-grant-type"), "the grantee-kind toggle exists").toHaveCount(1);
    // the role picker never renders as an empty chevron — before a pick it shows its placeholder
    await expect(page.getByTestId("tenant-grant-role"), "the role picker names itself at rest").not.toHaveText("");
    // …and the form is ONE row of its own (the 2026-08-04 screenshot had it wrapped under the filter,
    // with the role Select collapsed): every control shares a top edge
    const topOf = async (id: string) => Math.round((await page.getByTestId(id).boundingBox())!.y);
    const inputY = await topOf("tenant-grant-input");
    expect(await topOf("tenant-grant-type"), "kind toggle on the form's line").toBe(inputY);
    expect(await topOf("tenant-grant-role"), "role picker on the form's line").toBe(inputY);
    expect(await topOf("tenant-grant-add"), "add button on the form's line").toBe(inputY);
    // …and it is VISIBLY a different operation from the filter (the second half of the same reject
    // ). Separated, not merely on two lines
    // the two rows nearly touching is what read as one four-control mess.
    const filterY = await topOf("members-filter");
    expect(Math.abs(filterY - inputY), "the filter is not on the form's line").toBeGreaterThan(24);
    const headings = await page.locator("h3").allInnerTexts();
    expect(headings.length, "each operation says what it is").toBeGreaterThanOrEqual(2);

    // narrow to ONE member with the table filter, then work on that row — the fixture's display name
    // is not something this spec should hard-code (it differs between the dev and e2e seeds)
    await filterMembers(page, "dev");
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
    await filterMembers(page, "dev");
    const after = page.getByTestId("member-roles").first();
    await expect(after.getByTestId("member-role-select"), "and it survives a reload — the server said so").toHaveText(roleA, { timeout: 10_000 });

    // choosing another REPLACES: one role, and the previous one is not beside it
    await after.getByTestId("member-role-select").click();
    await page.getByRole("option", { name: roleB }).click();
    await expect(after.getByTestId("member-role-select")).toHaveText(roleB, { timeout: 8000 });
    await page.reload();
    await filterMembers(page, "dev");
    const reloaded = page.getByTestId("member-roles").first();
    await expect(reloaded.getByTestId("member-role-select"), "the replacement stuck").toHaveText(roleB, { timeout: 10_000 });
    await expect(reloaded.getByTestId("member-role-chip"), "no chips: there is no set to draw").toHaveCount(0);
    await expect(reloaded.getByTestId("member-tier-chip")).toHaveCount(0);

    // The filter narrows the table, and that is ALL it does.
    // RE-AIMED AGAIN (#578 bounce, 2026-08-04): for one round an unmatched name was offered as a group
    // to give a role to, and the review rejected it — the route was invisible (nothing on screen
    // said typing here could create anything) and it had neither completion nor the confirmed/unconfirmed
    // distinction. Adding is now the shared form above the table, so the filter is a filter again.
    await filterMembers(page, "nobody-matches-this");
    await expect(page.getByTestId("member-row-group"), "no existing group matches").toHaveCount(0, { timeout: 8000 });
    await expect(page.getByTestId("member-row-new-group"), "and the filter does not confer roles").toHaveCount(0);
    await filterMembers(page, "dev");
    await expect(page.getByTestId("member-roles").first()).toBeVisible();

    // The ADD FORM is the second door to the same state (2026-08-04 ruling): pick the person, pick a
    // role, add — and the person's ROW control changes, because both doors write the same converged
    // fact. If the form stacked instead of replacing, the row would still read roleB here.
    await page.getByTestId("tenant-grant-input").fill("dev");
    await page.getByTestId("tenant-grant-candidate").first().click();
    await page.getByTestId("tenant-grant-role").click();
    await page.getByRole("option", { name: roleA }).click();
    await page.getByTestId("tenant-grant-add").click();
    await expect(page.getByTestId("member-roles").first().getByTestId("member-role-select"), "the form's grant lands on the row")
      .toHaveText(roleA, { timeout: 8000 });
  } finally {
    await removeRole(request, [idA, idB]);
  }
});

// Groups are not people: they have no row in the member table, so their tenant roles live in their own
// section — the same split the space screen makes. This also exercises GET /admin/groups, the
// tenant-scope name source #579 added (the existing one was space-scoped and needed a space id).
test("#579 ①: a group gets a tenant role from the MEMBER TABLE, by name", async ({ page, request }) => {
  // RE-AIMED, not deleted. The subject was "a group is given a tenant role by NAME, and the screen shows
  // the name rather than the hash" — that still holds; what changed is where it happens. The ruling
  // folded the group section into the member table ("
  // "), so the same act is now: type the name in the table's search,
  // and the row it offers takes a role.
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
    await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("tenant-group-roles"), "the separate section is gone").toHaveCount(0);

    // RE-AIMED AGAIN (#578 bounce ④): the act is the same — a group named by hand is given a tenant role
    // and the screen shows its NAME — but it happens in the shared add form now, the same one the space
    // screen uses, because the filter-field route was invisible on the device.
    const groupName = `e2e-579-group-${stamp}`;
    // the form opens on the user half (2026-08-04: both kinds are offered) — flip it to groups
    await page.getByTestId("tenant-grant-type").click();
    await page.getByRole("option", { name: /group/i }).click();
    await page.getByTestId("tenant-grant-group-name").fill(groupName);
    await page.getByTestId("tenant-grant-role").click();
    await page.getByRole("option", { name: roleName }).click();
    await page.getByTestId("tenant-grant-add").click();

    await filterMembers(page, groupName);
    const row = page.getByTestId("member-row-group").filter({ hasText: groupName });
    await expect(row, "the group appears with its NAME, never a hash").toBeVisible({ timeout: 8000 });
    await expect(row).not.toContainText(/[0-9a-f]{24}/);

    // and the role comes off from the same control that put it on — there is no second affordance
    await row.getByTestId("member-role-select").click();
    await page.getByRole("option").first().click();
    await expect(page.getByTestId("member-row-group").filter({ hasText: groupName }), "removing the role removes the row")
      .toHaveCount(0, { timeout: 8000 });
  } finally {
    await removeRole(request, [roleId]);
  }
});
