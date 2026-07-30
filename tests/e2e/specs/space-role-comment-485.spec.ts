import { test, expect } from "@playwright/test";

// #485 review bounce: the space Members tab offered custom roles that the server then refused —
// a role carrying `comment` 400'd with `capability "comment" is not assignable at space scope`, because
// space commenting was an audience wildcard with no per-principal relation. #529/ADR-193 gave `comment`
// a real per-principal leaf (`space#commenter`), so the refusal is gone at the root rather than papered
// over in the picker. This pins the bounced case end to end: define a role WITH comment, assign it on a
// space, and see it land.
test("#485: a role carrying `comment` assigns at space scope (the bounce is gone)", async ({ page }) => {
  const name = `cmt-role-${Date.now().toString(36)}`;
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("role-create").click();
  await page.getByTestId("role-name-input").fill(name);
  await page.getByTestId("role-cap-view").check();
  await page.getByTestId("role-cap-comment").check(); // the capability that used to make the assign 400
  await page.getByTestId("role-save").click();
  await expect(page.getByTestId("roles-list")).toContainText(name, { timeout: 8000 });

  // assign it where a space role now lives (#514 slice 4)
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 10_000 });
  // #536 §6: the merged picker (one control for built-ins and custom roles)
  await page.getByTestId("space-grant-input").fill("dev");
  await page.getByTestId("space-grant-candidate").first().click();
  await page.getByTestId("space-grant-capability").click();
  await page.getByRole("option", { name }).click();
  await expect(page.getByRole("option")).toHaveCount(0);
  await page.getByTestId("space-grant-add").click();
  // #536②: adding over an existing different role opens the replace confirm (1 principal = 1
  // role). Residue rows on the shared demo space make this conditional.
  {
    const replaceConfirm = page.getByTestId("space-role-replace-confirm");
    if (await replaceConfirm.isVisible({ timeout: 1500 }).catch(() => false)) await replaceConfirm.click();
  }

  // it landed — no 400, no generic failure toast
  await expect(page.getByTestId("space-member-list"), "the comment-bearing role assigned").toContainText(name, { timeout: 8000 });

  // clean up: revoke, then delete the role (a role with live assignments is refused by the 409 guard)
  await page.getByTestId("space-member-item").filter({ hasText: name }).getByTestId("space-role-assign-revoke").click();
  await expect(page.getByTestId("space-member-list")).not.toContainText(name, { timeout: 8000 });
  await page.goto("/admin/roles");
  await page.getByTestId("custom-role-row").filter({ hasText: name }).getByTestId("role-delete").click();
  await page.getByTestId("role-delete-confirm").click();
  await expect(page.getByTestId("roles-list")).not.toContainText(name, { timeout: 8000 });
});
