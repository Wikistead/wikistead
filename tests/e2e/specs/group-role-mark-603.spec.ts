import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #603 (user ruling, 2026-08-05): what a group confers is ONE mark beside the control, not a badge
// per role stacked above it.
//
// The badge-per-role shape this replaces was itself a reject: it put the row at 57px against 41px for
// every other row, and got worse with each additional group — rows keep growing taller, and a user
// can belong to several groups, whose roles must be readable together. So the row height is the
// assertion, measured
// against the OTHER rows rather than a constant: a table that is uniformly wrong would satisfy a number.
//
// GET /members is stubbed (the #537 pattern: stub the read, keep writes real) because the fixture has no
// member carrying three group-conferred roles, and the shape only breaks once there are several.
const MEMBERS = {
  members: [
    { sub: "none", email: "a@x.test", display_name: "No Groups", picture_url: null, role: "member", groups: null, created_at: "2026-01-01T00:00:00Z", identity_source: "oidc", has_password: false, deactivated_at: null },
    { sub: "one", email: "b@x.test", display_name: "One Group", picture_url: null, role: "member", groups: ["wiki Editors"], created_at: "2026-01-02T00:00:00Z", identity_source: "oidc", has_password: false, deactivated_at: null },
    { sub: "three", email: "c@x.test", display_name: "Three Groups", picture_url: null, role: "member", groups: ["wiki Editors", "workspace Users", "calender Users"], created_at: "2026-01-03T00:00:00Z", identity_source: "oidc", has_password: false, deactivated_at: null },
    // #579 the reject asked for 1, 3 and FIVE, and five was never measured. Five is not more of
    // the same — the badge shape it replaced put ~160px of chip on the row per conferring group, so five
    // is where a row that survives three would still break.
    //
    // The names are REAL lengths ("wiki Editors", "content-reviewer"), not G1/r-bbb. With short ones the
    // badges fit and every geometry assertion here passes with the badge shape restored — measured. A
    // degenerate fixture cannot reproduce a defect about width.
    { sub: "five", email: "d@x.test", display_name: "Five Groups", picture_url: null, role: "member", groups: ["wiki Editors", "workspace Users", "calender Users", "support Engineers", "platform Operators"], created_at: "2026-01-04T00:00:00Z", identity_source: "oidc", has_password: false, deactivated_at: null },
  ],
};

/** Tenant-scope assignments: three groups, three different roles (one principal converges to one role,
 *  so several roles need several groups —). */
const ASSIGNMENTS = [
  { id: "a1", roleId: null, roleName: "admin", builtin: "admin", principal: "group:h1#member", groupName: "wiki Editors" },
  { id: "a2", roleId: "r-bbb", roleName: "content-reviewer", principal: "group:h2#member", groupName: "workspace Users" },
  { id: "a3", roleId: "r-ccc", roleName: "space-auditor", principal: "group:h3#member", groupName: "calender Users" },
  { id: "a4", roleId: "r-ddd", roleName: "template-maintainer", principal: "group:h4#member", groupName: "support Engineers" },
  { id: "a5", roleId: "r-eee", roleName: "integration-operator", principal: "group:h5#member", groupName: "platform Operators" },
];

async function stub(page: import("@playwright/test").Page, opts: { assignments?: typeof ASSIGNMENTS } = {}) {
  await page.route("**/api/members", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MEMBERS) })
      : r.fallback());
  await page.route("**/api/admin/roles/assignments**", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(opts.assignments ?? ASSIGNMENTS) })
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

  // #579 ③: the ROLE COLUMN's width as well as the row's height. The defect was a row whose role
  // cell grew with the number of conferring groups (measured then: 3 badges = 494px of content in a 421px
  // column, wrapping to two lines and squeezing the name column). Height alone would pass a row that got
  // wider without getting taller, which is the same defect one axis over.
  const names = ["No Groups", "One Group", "Three Groups", "Five Groups"];
  const heights = await Promise.all(names.map(heightOf));
  expect([...new Set(heights)], `rows must share one height — measured ${heights.join(" / ")}`).toHaveLength(1);

  // The width the reject asked for, measured where the count actually lands. Two shapes were tried first
  // and both were confounded: row-to-row comparison of the role CELL is equal by construction (a table
  // gives every row one column width), and re-rendering with fewer assignments changes what the OTHER
  // columns hold, so the column moved for reasons that had nothing to do with groups (1 group = 257px,
  // 5 groups = 224px — narrower, because less content elsewhere).
  //
  // What no one controls is the COUNT, and what the badge shape did with it was put ~160px on the row per
  // conferring group. So the assertion is that the thing carrying the count has one width whatever the
  // count is: five groups take exactly as much room as one.
  const markWidth = (name: string) =>
    page.locator("tr", { hasText: name }).first().getByTestId("group-roles-mark")
      .evaluate((el) => Math.round(el.getBoundingClientRect().width));
  const [w1, w3, w5] = await Promise.all([markWidth("One Group"), markWidth("Three Groups"), markWidth("Five Groups")]);
  // Three and five are IDENTICAL: the count is on the mark, and past one digit it costs nothing more.
  expect(w5, `five groups took more room than three — ${w3} → ${w5}`).toBe(w3);
  // One is 3px narrower because "1" is one digit and "3" is one digit too — the difference is the digit,
  // not the group. Stated as a bound rather than as equality because a digit is a real, bounded cost,
  // while a badge per group was ~160px each: this number cannot absorb one.
  expect(w5 - w1, `the mark grew with the group count — 1 group ${w1}px, 5 groups ${w5}px`).toBeLessThan(10);

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
  for (const [group, role] of [["wiki Editors", "admin"], ["workspace Users", "content-reviewer"], ["calender Users", "space-auditor"]] as const) {
    await expect(panel, `${group} and what it confers`).toContainText(group);
    await expect(panel).toContainText(role);
  }

  // the pointer can travel INTO the list (the nested hover the ruling asked for) without it closing
  await panel.getByTestId("group-role-name").first().hover();
  await expect(panel, "the list survives the pointer entering it").toBeVisible();

  // the row's own control still shows the member's own role — the mark never speaks for it
  await expect(page.locator("tr", { hasText: "Three Groups" }).getByTestId("member-role-select")).toBeVisible();
});

// #603 (user ruling, 2026-08-05): the nesting is easy to miss, and tier 2 walks off the screen —
// no tier, tier 1 included, may ever leave the viewport.
//
// Both panels, both axes. The reject measured L2 escaping to the right at a 1000px viewport and L1
// escaping downward at a 420px one — the same root in both: neither asked whether the side it opens on
// has room. So the assertion is not about a panel, it is about EVERY panel that ends up on screen:
// collect the live `[role=tooltip]` nodes and require each to be inside the viewport. A third tier added
// later is covered the day it lands, without this file naming it.
async function panelsOnScreen(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role=tooltip]')]
      .map((el) => ({
        id: (el as HTMLElement).dataset.testid ?? el.className,
        opacity: Number(getComputedStyle(el).opacity),
        ...(el.getBoundingClientRect().toJSON() as DOMRect),
      }))
      // A panel at opacity 0 is being MEASURED, not shown: it cannot be placed until it has been
      // rendered, so the first pass necessarily runs without its height. Traced on the device, that
      // pass put the second tier's bottom at 437 in a 420px window before the next one moved it to
      // 412 — correct within a frame, invisible for that frame, and not something a reader can see.
      .filter((r) => r.width > 0 && r.height > 0 && r.opacity > 0));
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
