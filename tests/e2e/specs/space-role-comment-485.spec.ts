import { test, expect } from "@playwright/test";
import { createScratchSpace } from "../helpers";

// #485 review bounce: the space Members tab offered custom roles that the server then refused —
// a role carrying `comment` 400'd with `capability "comment" is not assignable at space scope`, because
// space commenting was an audience wildcard with no per-principal relation. #529/ADR-193 gave `comment`
// a real per-principal leaf (`space#commenter`), so the refusal is gone at the root rather than papered
// over in the picker. This pins the bounced case end to end: define a role WITH comment, assign it on a
// space, and see it land.
test("#485: a role carrying `comment` assigns at space scope (the bounce is gone)", async ({ page }) => {
  const name = `cmt-role-${Date.now().toString(36)}`;
  // ⚠️ #890 (2026-08-23): the second member of the family the fixture reporter caught. This assign /
  // revoke loop used to run on `demo_space`, and the console enforces one role per principal — so
  // assigning REPLACED `user:dev-user#manager@space:demo_space` (the replace-confirm below is the
  // deletion) and the revoke at the end left nothing. The reporter names only the FIRST break in a
  // run, so a second spec doing the same thing is invisible until the first is fixed; this one was
  // found by counting the family rather than by running again.
  const space = await createScratchSpace(page, `role-485 ${Date.now().toString(36)}`);
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("role-create").click();
  await page.getByTestId("role-name-input").fill(name);
  await page.getByTestId("role-cap-view").check();
  await page.getByTestId("role-cap-comment").check(); // the capability that used to make the assign 400
  await page.getByTestId("role-save").click();
  await expect(page.getByTestId("roles-list")).toContainText(name, { timeout: 8000 });

  // assign it where a space role now lives (#514 slice 4) — on a space this test made
  await page.goto(`/spaces/${space}/settings/members`);
  await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 10_000 });
  // #536 §6: the merged picker (one control for built-ins and custom roles)
  await page.getByTestId("space-grant-input").fill("dev");
  await page.getByTestId("space-grant-candidate").first().click();
  await page.getByTestId("space-grant-capability").click();
  await page.getByRole("option", { name }).click();
  await expect(page.getByRole("option")).toHaveCount(0);
  await page.getByTestId("space-grant-add").click();
  // #536 ②: adding over an existing different role opens the replace confirm (1 principal = 1
  // role). It fires here because creating a space makes its creator its manager — which is exactly the
  // grant this used to take from the shared fixture. Conditional because the dialog is skipped when
  // the principal held nothing.
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
