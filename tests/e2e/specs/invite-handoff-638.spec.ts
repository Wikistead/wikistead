import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #638 (user ruling): an admin can hand a pending invitation over again, from the row it is on.
//
// The scenario the ruling asks the product to survive: a self-hosted tenant with no mail configured, where
// the link that appeared once on the screen that made the invite is the only copy of it. Losing that link
// used to mean revoking and inviting again — a different invitation to anyone reading the ledger, and a
// second chance to mistype the address.
//
// Driven through the screen rather than the API, because the ruling is about reach: the act existing on
// the server is not the same as an admin being able to perform it from where they are looking.
test("#638: a pending invitation can be handed over again from its own row", async ({ page }) => {
  test.setTimeout(120_000);
  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 20_000 });

  // an invitation to work with, created the way an admin creates one
  const addr = `handoff638-${Date.now().toString(36)}@e2e.test`;
  await page.getByLabel(/invite email|招待するメール/i).fill(addr);
  await page.getByRole("button", { name: /send invite|招待を送/i }).first().click();
  const firstLink = page.getByTestId("invite-link");
  await expect(firstLink).toBeVisible({ timeout: 20_000 });
  const before = (await firstLink.textContent())!.trim();
  expect(before, "the create flow produced a link").toMatch(/\/invite\?token=/);

  const row = page.locator('[data-testid="invite-row"]').filter({ hasText: addr });
  await expect(row, "the invitation is listed as pending").toBeVisible({ timeout: 20_000 });

  // …and it says whether anybody has been mailed. Sending is best-effort, so "invited" and "reached"
  // are different facts — .
  await expect(row.getByTestId("invite-mailed"), "the row reports its delivery").toBeVisible();

  // the hand-off itself: from the row, not from somewhere else on the page
  await row.getByTestId("invite-reissue").click();
  const confirm = page.getByTestId("members-confirm");
  await expect(confirm, "the confirm appears").toBeVisible({ timeout: 10_000 });
  // and it says the previous link dies — an admin who is not told will hand out a link they have just
  // invalidated for the person they already mailed
  const warning = (await page.locator('[role="dialog"], [data-testid*="confirm"]').first().textContent()) ?? "";
  expect(warning, `the confirm warns that the old link stops working: ${warning.slice(0, 200)}`)
    .toMatch(/stop working|使えなくなります/);
  await confirm.click();

  await expect
    .poll(async () => (await firstLink.textContent())?.trim(), { timeout: 20_000 })
    .not.toBe(before);
  const after = (await firstLink.textContent())!.trim();
  expect(after, "a usable link, not a confirmation message").toMatch(/\/invite\?token=/);

  // ONE invitation still — a second row is how #606 put one person on two seats
  await expect(page.locator('[data-testid="invite-row"]').filter({ hasText: addr }), "still one invitation")
    .toHaveCount(1);

  // clean up: the invitation is this spec's, and leaving it pending would drown the next walk of this list
  await row.getByTestId("invite-revoke").click();
  await page.getByTestId("members-confirm").click();
  await sleep(500);
});
