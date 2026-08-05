import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #607 (user ruling, 2026-08-05): "Dev User 2 ".
//
// The roster answers one row per CAPABILITY, and this screen drew them straight through — so the space's
// owner appeared twice, `manager` and `viewer`, on the very screen "1 principal = 1 role" (#536 / #579)
// was settled for. The second row also carried a control offering a role change that could never
// succeed: changing the owner's role is a demotion the ceiling refuses (#607).
//
// The GET is stubbed, and only the GET (#537's pattern). That two-row state cannot be MADE through the
// product any more — the server's convergence answers 409
// `manager_replacement_requires_confirmation` when a second capability is granted to a manager, which is
// why the ruling describes it as pre-existing data. The defect is in how the screen renders what it is
// handed, so what it is handed is what this fixes in place.
//
// The assertion counts rather than naming anybody: rendered rows must equal DISTINCT principals. A pin
// that checked "Dev User appears once" would pass the day the payload changes shape, while a screen that
// multiplies people by what they hold went on shipping.
const ROSTER = [
  { grantee: "user:dev-user", capability: "manage", displayName: "Dev User", revocable: false, changeable: false },
  { grantee: "user:dev-user", capability: "view", displayName: "Dev User", revocable: true, changeable: false },
  { grantee: "user:someone-607", capability: "edit", displayName: "Someone", revocable: true, changeable: true },
  { grantee: "user:someone-607", capability: "comment", displayName: "Someone", revocable: true, changeable: true },
  { grantee: "user:lonely-607", capability: "view", displayName: "Lonely", revocable: true, changeable: true },
];

test("#607: the roster shows each principal once, whatever they hold", async ({ page }) => {
  await page.route("**/api/spaces/demo_space/access", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ROSTER) })
      : r.fallback());
  await openDemo(page);
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-member-list")).toBeVisible({ timeout: 10_000 });
  await sleep(600);

  // the premise, asserted rather than assumed: the payload really does carry a principal more than once
  expect(ROSTER.length, "the fixture must contain the shape under test")
    .toBeGreaterThan(new Set(ROSTER.map((g) => g.grantee)).size);

  const principals = await page.locator('[data-testid="space-member-item"]').evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).dataset.principal ?? ""));
  expect(principals.length, "rows rendered").toBeGreaterThan(0);
  expect(new Set(principals).size, `one row per principal — rendered ${principals.join(", ")}`)
    .toBe(principals.length);
  expect(new Set(principals).size, "and every principal is still present").toBe(3);

  // the surviving row is the strongest thing held, not whichever the server listed last
  const owner = page.locator('[data-testid="space-member-item"][data-principal="user:dev-user"]');
  await expect(owner).toHaveCount(1);
  await expect(owner, "the owner reads as a manager, not a viewer").toContainText(/manager/i);
});

// #607 (user ruling+ review②): after the ceiling narrowed, the screen an access-manager
// sees is NOT "manager alone is a badge". `moderate` is in `ADMIN_CLASS_ROLE_CAPS`, so a moderator is
// beyond this verb too — and viewer/editor rows get their control back, which is what the ruling was
// for. Both halves, because "everything frozen" (the pre-ruling screen) and "nothing frozen" (a lost
// ceiling) each satisfy one of them alone.
//
// Stubbed at the GET again: the signal under test is the server's, and the server's own answer for it is
// pinned in `space-access-manager-607` / `roster-offer-subset-607` against a real store. What this
// measures is that the SCREEN spends that signal correctly, which is where #607 has now been wrong twice.
//
// The frozen rows here are `revocable: true` ON PURPOSE. That is the shape the server actually produces
// for the owner — their plain `view` row IS individually revocable while their ROLE is not — and
// it is the only shape that makes this pin load-bearing: with `revocable: false` the row draws as a badge
// through the `locked` arm, so deleting the `changeable` arm entirely leaves the test green. Measured
// it did.
const NARROWED = [
  { grantee: "user:owner-607", capability: "manage", displayName: "Owner", revocable: true, changeable: false },
  { grantee: "user:mod-607", capability: "moderate", displayName: "Moderator", revocable: true, changeable: false },
  { grantee: "user:reader-607", capability: "view", displayName: "Reader", revocable: true, changeable: true },
  { grantee: "user:writer-607", capability: "edit", displayName: "Writer", revocable: true, changeable: true },
];

test("#607: the rows beyond this verb are badges, and the ones within it keep their control", async ({ page }) => {
  await page.route("**/api/spaces/demo_space/access", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(NARROWED) })
      : r.fallback());
  await openDemo(page);
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-member-list")).toBeVisible({ timeout: 10_000 });
  await sleep(600);

  const row = (p: string) => page.locator(`[data-testid="space-member-item"][data-principal="user:${p}"]`);
  for (const who of ["owner-607", "mod-607"]) {
    await expect(row(who).getByTestId("space-grant-locked"), `${who} is beyond this verb`).toHaveCount(1);
    await expect(row(who).locator("button[role=combobox]"), `${who} offers no control`).toHaveCount(0);
  }
  for (const who of ["reader-607", "writer-607"]) {
    await expect(row(who).getByTestId("space-grant-locked"), `${who} is within it`).toHaveCount(0);
    await expect(row(who).locator("button[role=combobox]"), `${who} keeps its control`).toHaveCount(1);
  }
});
