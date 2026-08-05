import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #625: in one table, a person's name and a group's name must start at the same x.
//
// Measured on the device (2026-08-05): the leading visuals share a left edge at 268, but a person's is a
// 24px avatar and a group's a 16px lucide icon, so with the same 8px gap the group's name begins 8px to
// the left of every person's. Same table, same column, two rules.
//
// The assertion is EQUALITY BETWEEN THE ROWS, never a constant: a column that drifted as a whole would
// satisfy any number this file could name, and the complaint is about the rows disagreeing with each
// other. The leading edge is asserted too — it is already right, and widening the group's box is a fix
// that could easily break it.
//
// GET /members is stubbed (the #537 pattern: stub the read, keep writes real) for the one case the shared
// fixture cannot produce — a member carrying a `picture_url`. An <img> and a drawn initial must occupy
// the same box, and that is exactly the kind of difference a fixture without avatars hides.
const WITH_PICTURE = {
  members: [
    { sub: "pic", email: "pic@x.test", display_name: "Has Picture", picture_url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", role: "member", groups: ["wiki Editors"], created_at: "2026-01-01T00:00:00Z", identity_source: "oidc", has_password: false, deactivated_at: null },
    { sub: "noimg", email: "noimg@x.test", display_name: "No Picture", picture_url: null, role: "member", groups: ["wiki Editors"], created_at: "2026-01-02T00:00:00Z", identity_source: "oidc", has_password: false, deactivated_at: null },
  ],
};

/** Left edge of an element, rounded — the axis this ticket is about. */
const leftOf = (l: import("@playwright/test").Locator) =>
  l.evaluate((el) => Math.round(el.getBoundingClientRect().left));

test("#625: a group's name starts where a person's name starts", async ({ page }) => {
  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByTestId("member-row-group").first()).toBeVisible({ timeout: 10_000 });
  await sleep(400);

  const personName = page.getByTestId("member-name").first();
  const groupName = page.getByTestId("group-name").first();
  await expect(groupName, "a group row names itself in a measurable element").toBeVisible();

  const [person, group] = await Promise.all([leftOf(personName), leftOf(groupName)]);
  expect(group, `name left edges must agree — person ${person}, group ${group}`).toBe(person);

  // non-regression: the leading visuals were ALREADY aligned, and giving the icon a wider box is the
  // obvious way to break that
  // whatever the leading visual IS — the first element in the identity cell — asked structurally, so the
  // check does not have to be rewritten alongside the markup it guards
  const firstInCell = (row: import("@playwright/test").Locator) =>
    row.locator("td").first().locator("> span > *").first();
  const [pLead, gLead] = await Promise.all([
    leftOf(firstInCell(page.locator("tr").filter({ has: page.getByTestId("member-name") }).first())),
    leftOf(firstInCell(page.getByTestId("member-row-group").first())),
  ]);
  expect(gLead, `leading edges must stay together — person ${pLead}, group ${gLead}`).toBe(pLead);
});

test("#625: an avatar image and a drawn initial occupy the same box", async ({ page }) => {
  await page.route("**/api/members", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WITH_PICTURE) })
      : r.fallback());
  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByText("Has Picture")).toBeVisible({ timeout: 10_000 });
  await sleep(400);

  const nameIn = (who: string) => page.locator("tr", { hasText: who }).getByTestId("member-name").first();
  const [withPic, without] = await Promise.all([leftOf(nameIn("Has Picture")), leftOf(nameIn("No Picture"))]);
  expect(withPic, `a picture must not move the name — ${withPic} vs ${without}`).toBe(without);
});
