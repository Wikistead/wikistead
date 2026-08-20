import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #643 (user ruling): the user noticed this page offers no way to remove a role granted to a group.
//
// It was not missing — it was hidden. Choosing the picker's placeholder ("choose a role") performed the
// revocation, which nobody reads it as, and which put a destructive act in the same list as every
// ordinary choice. Meanwhile the group row was the one row on this screen with no ⋯, so the affordance
// a reader has learned to look for was not there.
//
// Both halves are asserted, because fixing one alone leaves the screen worse than it started: an inert
// placeholder with no menu behind it means the grant genuinely cannot be removed.
//
// The state is SUPPLIED. A tenant may legitimately have no group holding a role, and a spec that skips
// on an empty fixture is a spec that reports green having measured nothing.
const MEMBERS = {
  members: [
    { sub: "u1", email: "a@x.test", display_name: "A Person", picture_url: null, role: "member", groups: ["wiki Editors"], created_at: "2026-01-01T00:00:00Z", identity_source: "oidc", has_password: false, deactivated_at: null },
  ],
};

const ASSIGNMENTS = [
  { id: "a1", roleId: null, roleName: "admin", builtin: "admin", principal: "group:h1#member", groupName: "wiki Editors" },
  // a machine-held grant, which the console must NOT offer to remove (ADR-183 §1: what a directory
  // writes, the directory takes back). Its row is the non-regression half of this spec.
  { id: "a2", roleId: "r-bbb", roleName: "content-reviewer", principal: "group:h2#member", groupName: "workspace Users", managed: true },
];

async function stub(page: Page) {
  await page.route("**/api/members", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MEMBERS) })
      : r.fallback());
  await page.route("**/api/admin/roles/assignments**", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ASSIGNMENTS) })
      : r.fallback());
}

// by the row's OWN testid and its own label: a person can be IN "wiki Editors", so a text match on the
// table finds their row too, and `.first()` then measures whichever happens to be higher.
const groupRow = (page: Page, name: string) =>
  page.locator('[data-testid="member-row-group"]').filter({ hasText: name }).first();

test("#643: a group's role is removed from the row's ⋯, and the placeholder no longer does it", async ({ page }) => {
  test.setTimeout(120_000);
  await stub(page);
  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByText("wiki Editors").first()).toBeVisible({ timeout: 20_000 });
  await sleep(500);

  const row = groupRow(page, "wiki Editors");

  // 1. the affordance is where this screen keeps every other destructive action
  await expect(row.getByTestId("group-actions-trigger"), "the group row wears the same ⋯ a person's row does")
    .toBeVisible();

  // 2. …and the placeholder is inert. This is the path that used to revoke, so a reader opening the list
  // to see what was on offer could take the grant away by choosing the thing that says "choose".
  const before = (await row.getByTestId("member-role-select").innerText()).trim();
  await row.getByTestId("member-role-select").click();
  const placeholder = page.locator('[data-testid="member-role-select-"]').first();
  await expect(placeholder, "the placeholder is still listed").toBeVisible({ timeout: 10_000 });
  await expect(placeholder, "…and cannot be chosen").toHaveAttribute("data-disabled", "");
  await page.keyboard.press("Escape");
  await sleep(300);
  expect((await row.getByTestId("member-role-select").innerText()).trim(), "the role is untouched").toBe(before);

  // 3. a machine-held grant is not offered at all — a menu whose only item could not work is #606's
  // always-failing button, and this console does not undo what a directory wrote.
  await expect(groupRow(page, "workspace Users").getByTestId("group-actions-trigger"),
    "a machine-held group has no removal to offer").toHaveCount(0);

  // 4. the menu really removes it: the DELETE reaches the server for the assignment this row holds
  const deleted: string[] = [];
  await page.route("**/api/admin/roles/assignments/**", (r) => {
    if (r.request().method() === "DELETE") {
      deleted.push(r.request().url().split("/").pop()!);
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ removed: true }) });
    }
    return r.fallback();
  });

  await row.getByTestId("group-actions-trigger").click();
  await page.getByTestId("group-unassign").click();
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm, "a destructive action confirms first").toBeVisible({ timeout: 10_000 });
  await expect(confirm, "…and says whose access changes").toContainText(/wiki Editors/);
  await page.getByTestId("members-confirm").click();

  await expect.poll(() => deleted, { timeout: 15_000 }).toEqual(["a1"]);
});

// #643 (acceptance 4): every row of this table keeps its destructive actions in the ⋯, and none of them
// hides one inside an ordinary control.
//
// Written about ROWS rather than about people and groups: a third kind of row (a service account, an
// invited-but-unseated principal) would otherwise arrive with its own arrangement and nobody would
// notice until somebody revoked something by browsing a list.
test("#643: no row of the member table hides a destructive action in a picker", async ({ page }) => {
  test.setTimeout(120_000);
  await stub(page);
  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 20_000 });
  await sleep(600);

  const rows = await page.evaluate(() => {
    const out: { kind: string; label: string; hasMenu: boolean; pickerOptions: string[] }[] = [];
    for (const tr of [...document.querySelectorAll<HTMLElement>("table tbody tr")]) {
      const picker = tr.querySelector<HTMLElement>('[data-testid="member-role-select"]');
      if (!picker) continue; // a row with no role control has nothing this test is about
      out.push({
        kind: tr.dataset.testid ?? "member-row",
        label: (tr.textContent ?? "").trim().slice(0, 40),
        // the trigger, not the menu: the panel only exists once opened
        hasMenu: !!tr.querySelector('[data-testid$="-actions-trigger"]'),
        pickerOptions: [],
      });
    }
    return out;
  });

  expect(rows.length, "the fixture rendered rows with a role control").toBeGreaterThan(1);
  const kinds = new Set(rows.map((r) => r.kind));
  expect(kinds.size, `both kinds of row are on screen (saw ${[...kinds].join(", ")})`).toBeGreaterThan(1);

  // …and every one of them offers its destructive action where the reader looks for it. A row that can
  // revoke through its picker instead is the defect this ticket removed.
  // …and every one of them offers its destructive action where the reader looks for it. A row that can
  // revoke through its picker instead is the defect this ticket removed.
  //
  // Pickers are walked by INDEX rather than by matching their row's text: two rows can legitimately
  // contain the same words (a person listed in the group whose row sits below them), and a text locator
  // then either resolves to the wrong row or to none.
  const pickers = page.getByTestId("member-role-select");
  const count = await pickers.count();
  expect(count, "there are role pickers to inspect").toBe(rows.length);
  for (let i = 0; i < count; i++) {
    await pickers.nth(i).click();
    const items = await page.locator("[data-option-value]").evaluateAll((els) =>
      els.map((el) => ({ value: el.getAttribute("data-option-value"), disabled: el.hasAttribute("data-disabled") })));
    await page.keyboard.press("Escape");
    await sleep(200);
    // the placeholder is the option that used to destroy a grant; wherever it appears it must be inert
    const placeholder = items.find((it) => it.value === "");
    if (placeholder) {
      expect(placeholder.disabled, `${rows[i].kind} (${rows[i].label}): the placeholder is a label, not an action`).toBe(true);
    }
  }
});
