import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #646 (user ruling: unify them): one secret, one name — whichever door it came through.
//
// The invite link is produced from two places: the form at the top of the screen, and a pending row's
// menu. #638 gave the row's dialog a proper heading and left the form's using the old key, which was a
// LABEL printed above a value ("Invite link (share if email is off):"). So the same link was called two
// different things, and one of them ended in a colon because a label introduces the thing beneath it.
//
// Measured by opening both doors and comparing the rendered heading, because that is the only place the
// difference showed — the two call sites each looked reasonable on its own.
test("#646: the invite link dialog is called the same thing from either door", async ({ page }) => {
  test.setTimeout(120_000);
  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 20_000 });
  await sleep(600);

  // door 1: the form. Creating an invite raises the dialog with the link it just minted.
  const addr = `title646-${Date.now().toString(36)}@e2e.test`;
  await page.getByLabel(/invite email|招待するメール/i).fill(addr);
  await page.getByRole("button", { name: /send invite|招待を送/i }).first().click();
  const dialog = page.getByTestId("invite-link-dialog");
  await expect(dialog, "the form's dialog opened").toBeVisible({ timeout: 20_000 });
  const fromForm = (await dialog.getByRole("heading").first().innerText()).trim();
  const noteFromForm = (await dialog.getByTestId("invite-link-note").innerText()).trim();
  await page.getByTestId("secret-dialog-done").click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });

  // door 2: the pending row's menu, which opens the same kind of secret
  const row = page.locator('[data-testid="invite-row"]').filter({ hasText: addr }).first();
  await expect(row, "the invitation is listed").toBeVisible({ timeout: 20_000 });
  await row.getByTestId("invite-link-open").click();
  await expect(dialog, "the row's dialog opened").toBeVisible({ timeout: 10_000 });
  const fromRow = (await dialog.getByRole("heading").first().innerText()).trim();

  expect(fromForm, `the two doors name the secret differently: "${fromForm}" vs "${fromRow}"`).toBe(fromRow);
  // …and a heading is not a label: it does not introduce a value beneath it
  expect(fromForm, "a title does not end in a colon").not.toMatch(/[:：]\s*$/);

  // #646 (reviewer): fixing the TITLE moved the same defect into the body. The hand-it-over
  // guidance was added at one call site and not the other, so the same secret still said different
  // things depending on which door produced it — the very shape this ticket exists to remove, and one
  // the title-only assertion above stays green through.
  //
  // Compared in the SAME state, because the note is allowed to depend on whether the link was emailed
  // both doors here attempt mail, so a difference can only come from the door.
  await dialog.getByTestId("invite-link-mint-mail").click();
  await expect(dialog.getByTestId("invite-link-value"), "the row minted a link").toBeVisible({ timeout: 15_000 });
  const noteFromRow = (await dialog.getByTestId("invite-link-note").innerText()).trim();
  expect(noteFromRow, `the same secret says different things by door:\n  form: "${noteFromForm}"\n  row:  "${noteFromRow}"`)
    .toBe(noteFromForm);

  await page.keyboard.press("Escape");
  await sleep(300);
  // clean up: this spec's invitation, so the next walk of this list is not wading through them
  await row.getByTestId("invite-revoke").click();
  await page.getByTestId("members-confirm").click();
  await sleep(500);
});
