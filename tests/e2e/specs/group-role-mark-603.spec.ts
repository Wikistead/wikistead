import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #603 (user ruling, 2026-08-05): what a group confers is ONE mark beside the control, not a badge
// per role stacked above it.
//
// The badge-per-role shape this replaces was itself a reject: it put the row at 57px against 41px for
// every other row, and got worse with each additional group — "…
// ". So the row height is the assertion, measured
// against the OTHER rows rather than a constant: a table that is uniformly wrong would satisfy a number.
//
// GET /members is stubbed (the #537 pattern: stub the read, keep writes real) because the fixture has no
// member carrying three group-conferred roles, and the shape only breaks once there are several.
const MEMBERS = {
  members: [
    { sub: "none", email: "a@x.test", display_name: "No Groups", picture_url: null, role: "member", groups: null, created_at: "2026-01-01T00:00:00Z", identity_source: "oidc", has_password: false, deactivated_at: null },
    { sub: "one", email: "b@x.test", display_name: "One Group", picture_url: null, role: "member", groups: ["G1"], created_at: "2026-01-02T00:00:00Z", identity_source: "oidc", has_password: false, deactivated_at: null },
    { sub: "three", email: "c@x.test", display_name: "Three Groups", picture_url: null, role: "member", groups: ["G1", "G2", "G3"], created_at: "2026-01-03T00:00:00Z", identity_source: "oidc", has_password: false, deactivated_at: null },
  ],
};

/** Tenant-scope assignments: three groups, three different roles (one principal converges to one role,
 *  so several roles need several groups —). */
const ASSIGNMENTS = [
  { id: "a1", roleId: null, roleName: "admin", builtin: "admin", principal: "group:h1#member", groupName: "G1" },
  { id: "a2", roleId: "r-bbb", roleName: "bbb", principal: "group:h2#member", groupName: "G2" },
  { id: "a3", roleId: "r-ccc", roleName: "ccc", principal: "group:h3#member", groupName: "G3" },
];

async function stub(page: import("@playwright/test").Page) {
  await page.route("**/api/members", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MEMBERS) })
      : r.fallback());
  await page.route("**/api/admin/roles/assignments**", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ASSIGNMENTS) })
      : r.fallback());
}

test("#603: a group-conferred role is one mark, and the row keeps its height", async ({ page }) => {
  await stub(page);
  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByText("Three Groups")).toBeVisible({ timeout: 10_000 });
  await sleep(500);

  const heightOf = (name: string) =>
    page.locator("tr", { hasText: name }).first().evaluate((el) => Math.round(el.getBoundingClientRect().height));

  const [none, one, three] = await Promise.all([heightOf("No Groups"), heightOf("One Group"), heightOf("Three Groups")]);
  expect([...new Set([none, one, three])], `rows must share one height — measured ${none} / ${one} / ${three}`)
    .toHaveLength(1);

  // one mark, whatever the count — and the count is on it, so "how many" is readable before hovering
  const markThree = page.locator("tr", { hasText: "Three Groups" }).getByTestId("group-roles-mark");
  await expect(markThree, "exactly one mark on a member with three").toHaveCount(1);
  await expect(markThree).toContainText("3");
  await expect(page.locator("tr", { hasText: "One Group" }).getByTestId("group-roles-mark")).toContainText("1");
  await expect(page.locator("tr", { hasText: "No Groups" }).getByTestId("group-roles-mark"),
    "nothing conferred → no mark at all").toHaveCount(0);

  // the list opens on hover and names every group with the role it confers — two axes, no capabilities
  await markThree.hover();
  const panel = page.getByTestId("group-roles-list");
  await expect(panel).toBeVisible({ timeout: 3_000 });
  for (const [group, role] of [["G1", "admin"], ["G2", "bbb"], ["G3", "ccc"]] as const) {
    await expect(panel, `${group} and what it confers`).toContainText(group);
    await expect(panel).toContainText(role);
  }

  // the pointer can travel INTO the list (the nested hover the ruling asked for) without it closing
  await panel.getByTestId("group-role-name").first().hover();
  await expect(panel, "the list survives the pointer entering it").toBeVisible();

  // the row's own control still shows the member's own role — the mark never speaks for it
  await expect(page.locator("tr", { hasText: "Three Groups" }).getByTestId("member-role-select")).toBeVisible();
});

// #603 (user ruling, 2026-08-05): "2
//
// Both panels, both axes. The reject measured L2 escaping to the right at a 1000px viewport and L1
// escaping downward at a 420px one — the same root in both: neither asked whether the side it opens on
// has room. So the assertion is not about a panel, it is about EVERY panel that ends up on screen
// collect the live `[role=tooltip]` nodes and require each to be inside the viewport. A third tier added
// later is covered the day it lands, without this file naming it.
async function panelsOnScreen(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role=tooltip]')]
      .map((el) => ({ id: (el as HTMLElement).dataset.testid ?? el.className, ...(el.getBoundingClientRect().toJSON() as DOMRect) }))
      .filter((r) => r.width > 0 && r.height > 0));
}

for (const [w, h] of [[1000, 700], [900, 700], [1280, 420]] as const) {
  test(`#603: neither panel leaves a ${w}×${h} viewport, and the second never covers the first`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await stub(page);
    await openDemo(page);
    await page.goto("/admin/members");
    await expect(page.getByText("Three Groups")).toBeVisible({ timeout: 10_000 });
    await sleep(500);

    const mark = page.locator("tr", { hasText: "Three Groups" }).getByTestId("group-roles-mark");
    await mark.hover();
    const list = page.getByTestId("group-roles-list");
    await expect(list).toBeVisible({ timeout: 3_000 });
    await list.getByTestId("group-role-name").first().hover();
    await expect(page.getByTestId("group-role-caps")).toBeVisible({ timeout: 3_000 });

    for (const p of await panelsOnScreen(page)) {
      expect(p.left, `${p.id} left edge at ${w}×${h}`).toBeGreaterThanOrEqual(0);
      expect(p.top, `${p.id} top edge at ${w}×${h}`).toBeGreaterThanOrEqual(0);
      expect(p.right, `${p.id} right edge at ${w}×${h}`).toBeLessThanOrEqual(w);
      expect(p.bottom, `${p.id} bottom edge at ${w}×${h}`).toBeLessThanOrEqual(h);
    }

    // and the one you opened must not hide the one you opened it from
    const l1 = (await list.boundingBox())!;
    const l2 = (await page.getByTestId("group-role-caps").boundingBox())!;
    const overlaps = l2.x < l1.x + l1.width && l2.x + l2.width > l1.x && l2.y < l1.y + l1.height && l2.y + l2.height > l1.y;
    expect(overlaps, `the capability panel sits on top of the list it came from (${w}×${h})`).toBe(false);
  });
}

test("#603: the list says its role names open further (the nested hover is discoverable)", async ({ page }) => {
  // The ruling's fourth point: the second tier was unreadable because nothing said it was there. An
  // affordance the reader can see BEFORE pointing at it — checked as a rendered mark inside the name,
  // not as a class name, so a refactor that keeps the class and drops the mark still fails.
  await stub(page);
  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByText("Three Groups")).toBeVisible({ timeout: 10_000 });
  await sleep(500);
  await page.locator("tr", { hasText: "Three Groups" }).getByTestId("group-roles-mark").hover();
  const name = page.getByTestId("group-roles-list").getByTestId("group-role-name").first();
  await expect(name).toBeVisible();
  await expect(name.locator("svg"), "a visible cue that this name opens something").toHaveCount(1);
});
