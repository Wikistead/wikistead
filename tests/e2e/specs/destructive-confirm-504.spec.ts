import { test, expect, type Page } from "@playwright/test";
import { openDemo, openScratch, sleep, API } from "../helpers";

// #504: the destructive-operation policy, pinned on the flows the ticket names. A destructive
// trigger is RED AT REST (not only on hover), clicking it opens a ConfirmDialog, CANCEL is a no-op,
// and only the confirm runs the operation. Space delete and trash purge take the type-to-confirm
// bar (page delete-forever parity). Real Chromium; colours read from computed style.
// the shared danger foreground — resolve var(--danger) once per page and compare computed colours to it
async function dangerColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--danger)";
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
}
const colorOf = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => getComputedStyle(el).color);

test("#504: member remove + DSAR erase — red at rest, confirm dialog, cancel is a no-op", async ({ page }) => {
  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByTestId("member-remove").first()).toBeVisible({ timeout: 10_000 });

  const danger = await dangerColor(page);
  expect(await colorOf(page, "[data-testid=member-remove]"), "remove is red AT REST").toBe(danger);
  expect(await colorOf(page, "[data-testid=member-erase-analytics]"), "DSAR erase is red AT REST").toBe(danger);

  // remove → dialog → cancel → the member is still there (nothing ran)
  const rows = await page.getByTestId("member-remove").count();
  await page.getByTestId("member-remove").first().click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-dialog").getByRole("button", { name: /cancel|キャンセル/i }).click();
  await expect(page.getByTestId("confirm-dialog")).toBeHidden();
  await expect(page.getByTestId("member-remove")).toHaveCount(rows); // no one was removed

  // DSAR erase → dialog → cancel (never actually erase the shared dev member's history)
  await page.getByTestId("member-erase-analytics").first().click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-dialog").getByRole("button", { name: /cancel|キャンセル/i }).click();
  await expect(page.getByTestId("confirm-dialog")).toBeHidden();
});

test("#504: custom role delete — red at rest, cancel keeps it, confirm deletes it", async ({ page }) => {
  const name = `e2e-504-role-${Date.now()}`;
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("role-create").click();
  await page.getByTestId("role-name-input").fill(name);
  await page.getByTestId("role-cap-view").check();
  await page.getByTestId("role-save").click();
  const row = page.getByTestId("custom-role-row").filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 8000 });

  const danger = await dangerColor(page);
  expect(await row.getByTestId("role-delete").evaluate((el) => getComputedStyle(el).color), "delete × is red AT REST").toBe(danger);

  await row.getByTestId("role-delete").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await expect(page.getByTestId("confirm-dialog"), "the confirm names the role").toContainText(name);
  await page.getByTestId("confirm-dialog").getByRole("button", { name: /cancel|キャンセル/i }).click();
  await expect(row, "cancel keeps the role").toBeVisible();

  await row.getByTestId("role-delete").click();
  await page.getByTestId("role-delete-confirm").click();
  await expect(page.getByTestId("custom-roles"), "confirm really deletes").not.toContainText(name, { timeout: 8000 });
});

test("#504: attachment delete — red at rest, cancel keeps the file, confirm removes it", async ({ page }) => {
  await openScratch(page, `del504-${Date.now()}`);
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=attachments-toggle]");
  await expect(page.getByTestId("attachments-panel")).toBeVisible();
  await sleep(200);
  await page.setInputFiles("[data-testid=attachments-panel] input[type=file]", {
    name: "delete-me-504.txt", mimeType: "text/plain", buffer: Buffer.from("504"),
  });
  const item = page.getByTestId("attach-item").filter({ hasText: "delete-me-504.txt" });
  await expect(item).toBeVisible({ timeout: 8000 });

  const danger = await dangerColor(page);
  expect(await item.getByTestId("attach-delete").evaluate((el) => getComputedStyle(el).color), "delete is red AT REST").toBe(danger);

  await item.getByTestId("attach-delete").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await expect(page.getByTestId("confirm-dialog"), "the confirm names the file").toContainText("delete-me-504.txt");
  await page.getByTestId("confirm-dialog").getByRole("button", { name: /cancel|キャンセル/i }).click();
  await expect(item, "cancel keeps the file").toBeVisible();

  await item.getByTestId("attach-delete").click();
  await page.getByTestId("attach-delete-confirm").click();
  await expect(item, "confirm really deletes").toHaveCount(0, { timeout: 8000 });
});

test("#504: space delete requires typing the space name (delete-forever parity)", async ({ page }) => {
  const name = `e2e-504-space-${Date.now().toString(36)}`;
  await openDemo(page);
  const spaceId = await page.evaluate(async ({ api, name }) => {
    const r = await fetch(`${api}/spaces`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return ((await r.json()) as { id: string }).id;
  }, { api: API, name });

  await page.goto(`/spaces/${spaceId}/settings`);
  await expect(page.getByTestId("space-delete")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("space-delete").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  // the confirm stays disabled until the exact name is typed
  await expect(page.getByTestId("space-delete-confirm"), "disabled before typing").toBeDisabled();
  await page.getByTestId("typed-confirm-input").fill("wrong-name");
  await expect(page.getByTestId("space-delete-confirm"), "still disabled on a wrong name").toBeDisabled();
  await page.getByTestId("typed-confirm-input").fill(name);
  await expect(page.getByTestId("space-delete-confirm")).toBeEnabled();
  await page.getByTestId("space-delete-confirm").click();
  // deleted → navigated away; the space is gone from the API
  await expect.poll(() => page.evaluate(async ({ api, id }) => {
    const r = await fetch(`${api}/spaces`, { headers: { Authorization: "Bearer dev-token" } });
    return ((await r.json()) as { id: string }[]).some((s) => s.id === id);
  }, { api: API, id: spaceId }), { timeout: 8000 }).toBe(false);
});

test("#504: trash purge requires typing the page title", async ({ page }) => {
  const title = `purge504-${Date.now().toString(36)}`;
  const id = await openScratch(page, title);
  // trash it through the API (the UI flow is pinned elsewhere; this pins the PURGE bar)
  await page.evaluate(async ({ api, id }) => {
    await fetch(`${api}/pages/${id}`, { method: "DELETE", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, id });

  await page.goto(`/spaces/demo_space/settings/trash`);
  const row = page.getByTestId(`trash-purge-${id}`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await expect(page.getByTestId("trash-purge-confirm"), "disabled before typing").toBeDisabled();
  await page.getByTestId("typed-confirm-input").fill(title);
  await expect(page.getByTestId("trash-purge-confirm")).toBeEnabled();
  await page.getByTestId("trash-purge-confirm").click();
  await expect(row, "purged").toHaveCount(0, { timeout: 8000 });
});
