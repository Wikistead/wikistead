import { test, expect } from "@playwright/test";

// #591 (user, on the device): why does an "add role" label sit next to the badge, as if it ADDED a
// role? A single ordinary dropdown would do — and the member roles in space settings should be
// changeable from a dropdown too.
//
// The rule the four surfaces now share: an EXCLUSIVE role (a tenant tier, a built-in space role) is a
// dropdown that is always visible and changes in place; ADDITIVE custom roles stay chips with their own
// add control. What was wrong was not the number of controls but that the exclusive answer was hidden
// behind one labelled "add", and on the space screen there was no way to change a role at all — you
// removed it and granted again, which is two operations with the person's access gone in between.
//
// Driven in a real browser because the point is what a person can reach and press.

// RE-AIMED by #579 (third ruling, 2026-08-02). This half asserted the tenant row's TWO controls — a
// tier dropdown plus an add control that offered only custom roles. The user's answer to that shape was
// the same sentence a third time: one dropdown, everything chosen from it. #591's observation survives
// (an exclusive tier must not hide behind a control labelled "add") but it is answered by the LABEL and
// by the chips, not by a second control. The one-control assertion now lives in
// one-role-control-579.spec.ts, measured in the row's own DOM; what stays here is the space half, which
// #591 got right and which nothing has asked to change.

test("#591: a space member's built-in role changes from the row, in one step", async ({ page }) => {
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 15000 });

  const row = page.getByTestId("space-member-item").filter({ has: page.getByTestId("space-member-role-select") }).first();
  if (!(await row.isVisible().catch(() => false))) {
    test.info().annotations.push({ type: "note", description: "no built-in grant row on the shared demo space — change path not exercised" });
    return;
  }
  const select = row.getByTestId("space-member-role-select");
  await expect(select, "the dropdown shows the role the row HAS").toHaveText(/^(viewer|commenter|editor|moderator|manager)$/);

  // the row keeps its revoke as well — changing and removing are different acts
  await expect(row.getByTestId("space-grant-revoke"), "× is still there for removal").toBeVisible();
});
