import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #647 (user report): hovering the group names in the first tier leaves several second-tier hover
// panels stacked on top of each other.
//
// Hovering one role name after another left the previous panel up. Not a fading remnant — `data-state`
// said `open` and opacity was 1, and they stacked 95px apart until the whole list unmounted.
//
// The cause was two features meeting: #630 keeps a closing panel mounted so it can animate out, and
// #603's `place()` ended with `setOpen(true)` while being called from a ref callback that runs on every
// render. So hovering a sibling re-rendered the list, re-ran the dying panel's ref, and re-opened it.
//
// Counted by `data-state="open"`, never by how many panels EXIST: one on its way out is mounted and
// correct, so a presence count is red while nothing is wrong — and green in the window between two
// exits, which is the same measurement being wrong in the other direction.
const OPEN_CAPS = '[data-testid="group-role-caps"][data-state="open"]';

const MEMBERS = {
  members: [
    { sub: "two", email: "b@x.test", display_name: "Two Groups", picture_url: null, role: "member", groups: ["wiki Editors", "workspace Users"], created_at: "2026-01-02T00:00:00Z", identity_source: "oidc", has_password: false, deactivated_at: null },
  ],
};
const ASSIGNMENTS = [
  { id: "a1", roleId: null, roleName: "admin", builtin: "admin", principal: "group:h1#member", groupName: "wiki Editors" },
  { id: "a2", roleId: "r-bbb", roleName: "content-reviewer", principal: "group:h2#member", groupName: "workspace Users" },
];

async function stub(page: Page) {
  await page.route("**/api/members", (r) => r.request().method() === "GET"
    ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MEMBERS) })
    : r.fallback());
  await page.route("**/api/admin/roles/assignments**", (r) => r.request().method() === "GET"
    ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ASSIGNMENTS) })
    : r.fallback());
}

test("#647: only the role name under the pointer shows its capabilities", async ({ page }) => {
  test.setTimeout(120_000);
  await stub(page);
  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 20_000 });
  await sleep(500);

  // open the list of what this member's groups confer
  const mark = page.getByTestId("group-roles-mark").first();
  await expect(mark, "the member carries group-conferred roles").toBeVisible({ timeout: 15_000 });
  await mark.hover();
  const names = page.getByTestId("group-role-name");
  await expect(names.first(), "the list opened").toBeVisible({ timeout: 10_000 });
  expect(await names.count(), "…with more than one name, or there is nothing to stack").toBeGreaterThan(1);

  // walk the names. After each, exactly one panel may be OPEN.
  for (let i = 0; i < await names.count(); i++) {
    await names.nth(i).hover();
    await sleep(500); // past the open delay, and past the previous panel's exit
    expect(await page.locator(OPEN_CAPS).count(), `after hovering name ${i}, one panel is open`).toBe(1);
  }

  // …and after a fast walk back and forth, still one. This is the case the report described: quick
  // passes leave more of them behind, because each re-render revives another mid-exit panel.
  for (const i of [0, 1, 0, 1, 0]) {
    await names.nth(i).hover();
    await sleep(120);
  }
  await sleep(700);
  expect(await page.locator(OPEN_CAPS).count(), "a fast walk leaves one panel, not a stack").toBe(1);

  // the keyboard path has the same rule
  await names.first().focus();
  await sleep(400);
  await names.nth(1).focus();
  await sleep(500);
  expect(await page.locator(OPEN_CAPS).count(), "moving focus between names leaves one panel").toBe(1);

  // non-regression (#603): leaving the whole chain closes everything
  await page.mouse.move(4, 4);
  await expect.poll(() => page.locator(OPEN_CAPS).count(), { timeout: 10_000 }).toBe(0);
});
