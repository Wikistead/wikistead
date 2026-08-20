import { test, expect } from "@playwright/test";
import { openDemo, sleep, API } from "../helpers";

// #603 (review rejection 2026-08-05): so only admin gets a badge? — a group conferring a CUSTOM
// tenant role left its members holding the capability with nothing on screen saying where it came from.
// Only `admin` was shown.
//
// That statement outlived the shape that first answered it. The per-role badge is retracted (ruling
//, see group-role-mark-603) and what a group confers now lives behind one mark — so this asks the
// same question of the new surface: open the mark, and a CUSTOM role is named there exactly as admin is.
// Kept as its own spec because the sibling stubs /members to build a three-group member, and this one
// must go through a REAL grant: the path from "a group holds a custom tenant role" to "the row knows"
// runs through the server, and a stub would pin the component while leaving that path unmeasured.
//
// The fixture is made and removed here — a leftover tenant role piles into every picker on this shared
// dev tenant (the #582 sweep drowned in exactly that debris).
const STAMP = Date.now().toString(36);
const ROLE = `e2e603-${STAMP}`;
const GROUP = "wiki Editors"; // the group the e2e fixture's dev-user carries

test("#603: a group's CUSTOM tenant role is named on the member's row, like admin is", async ({ page }) => {
  await openDemo(page);

  const roleId = await page.evaluate(async ({ api, name }) => {
    const r = await fetch(`${api}/admin/roles`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ name, capabilities: ["createSpaces"], scope: "tenant" }),
    });
    return r.ok ? ((await r.json()) as { id: string }).id : null;
  }, { api: API, name: ROLE });
  expect(roleId, "the fixture role was created").toBeTruthy();

  try {
    const tenantId = await page.evaluate(async ({ api }) => {
      const r = await fetch(`${api}/auth/me`, { headers: { Authorization: "Bearer dev-token" } });
      return r.ok ? ((await r.json()) as { tenantId?: string }).tenantId ?? "tenant_dev" : "tenant_dev";
    }, { api: API });
    const granted = await page.evaluate(async ({ api, id, group, tid }) => {
      const r = await fetch(`${api}/admin/roles/${id}/assignments`, {
        method: "POST",
        headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
        body: JSON.stringify({ resourceType: "tenant", resourceId: tid, groupName: group }),
      });
      return r.ok;
    }, { api: API, id: roleId, group: GROUP, tid: tenantId });
    expect(granted, "the group was given the custom tenant role").toBe(true);

    await page.goto("/admin/members");
    await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 10_000 });
    await sleep(600);

    // the member carrying that group has a mark; opening it names the custom ROLE and the GROUP it came
    // from — the same two axes admin gets, which is the whole complaint
    const mark = page.getByTestId("group-roles-mark").first();
    await expect(mark, "a group conferring a custom role puts a mark on the row").toBeVisible({ timeout: 8_000 });
    await mark.hover();
    const list = page.getByTestId("group-roles-list");
    await expect(list).toBeVisible({ timeout: 3_000 });
    await expect(list, "a group's custom role is named, not only admin").toContainText(ROLE);
    await expect(list, "and the group it came from").toContainText(GROUP);

    // and the row's own control still shows the member's OWN role — the mark is beside it, never inside
    const row = page.locator("tr").filter({ has: page.getByTestId("group-roles-mark") }).first();
    await expect(row.getByTestId("member-role-select"), "the control is untouched by what a group confers")
      .toBeVisible();
  } finally {
    await page.evaluate(async ({ api, id }) => {
      if (!id) return;
      const me = await fetch(`${api}/auth/me`, { headers: { Authorization: "Bearer dev-token" } });
      const tid = me.ok ? ((await me.json()) as { tenantId?: string }).tenantId ?? "tenant_dev" : "tenant_dev";
      const list = await fetch(`${api}/admin/roles/assignments?resourceType=tenant&resourceId=${tid}`, { headers: { Authorization: "Bearer dev-token" } });
      if (list.ok) {
        const body = (await list.json()) as { assignments?: { id: string; roleId: string | null }[] } | { id: string; roleId: string | null }[];
        const all = Array.isArray(body) ? body : (body.assignments ?? []);
        for (const a of all.filter((x) => x.roleId === id)) {
          await fetch(`${api}/admin/roles/assignments/${a.id}`, { method: "DELETE", headers: { Authorization: "Bearer dev-token" } });
        }
      }
      await fetch(`${api}/admin/roles/${id}`, { method: "DELETE", headers: { Authorization: "Bearer dev-token" } });
    }, { api: API, id: roleId });
  }
});
