import { test, expect } from "@playwright/test";
import { openDemo, sleep, API } from "../helpers";

// #617 ②(b): the confirm dialog's message must stay inside the dialog. Measured, because the defect was
// geometry: a string with no break opportunity (a sub, a token, a URL) did not wrap and ran 115px past
// the right edge — reported from the SSO exemption screen, but the container is shared by 18 callers.
//
// The pin is on the CONTAINER, through whichever caller is cheapest to reach with a long string. It
// asserts a relation between two rects, not a constant: a dialog that is wrong at every width would
// pass a hard-coded number.
// 60 chars (the server caps a role name at 64) with no break opportunity — the same shape as the sub
// that was reported, and well past the 400px dialog at any readable font size.
const LONG = "wlocal" + "0123456789abcdef".repeat(3) + "0123";

test("#617: a message with no break opportunity stays inside the dialog", async ({ page }) => {
  await openDemo(page);

  // a real caller with a long string in its message: a custom role named with an unbroken token.
  const roleId = await page.evaluate(async ({ api, name }) => {
    const r = await fetch(`${api}/admin/roles`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ name, capabilities: ["view"], scope: "resource" }),
    });
    return r.ok ? ((await r.json()) as { id: string }).id : null;
  }, { api: API, name: LONG });
  expect(roleId, "the fixture role was created").toBeTruthy();

  try {
    await page.goto("/admin/roles");
    await expect(page.getByTestId("roles-list-resource")).toBeVisible({ timeout: 10_000 });
    await sleep(400);

    // open that role's delete confirmation
    const row = page.locator("tr,li,div").filter({ hasText: LONG }).last();
    await row.getByTestId("role-delete").first().click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible({ timeout: 5_000 });
    await sleep(200);

    const geom = await page.evaluate(() => {
      const dialog = document.querySelector("[data-testid=confirm-dialog]")!.getBoundingClientRect();
      const msg = document.querySelector("[data-testid=confirm-message]")!.getBoundingClientRect();
      return { dialogRight: dialog.right, dialogLeft: dialog.left, msgRight: msg.right, msgLeft: msg.left };
    });

    // the whole point: the text is inside its container. A pixel of tolerance for sub-pixel rounding.
    expect(geom.msgRight, `the message runs ${Math.round(geom.msgRight - geom.dialogRight)}px past the dialog`)
      .toBeLessThanOrEqual(geom.dialogRight + 1);
    expect(geom.msgLeft, "and does not escape to the left either").toBeGreaterThanOrEqual(geom.dialogLeft - 1);
  } finally {
    await page.evaluate(async ({ api, id }) => {
      if (id) await fetch(`${api}/admin/roles/${id}`, { method: "DELETE", headers: { Authorization: "Bearer dev-token" } });
    }, { api: API, id: roleId });
  }
});
