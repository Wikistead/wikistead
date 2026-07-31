import { test, expect } from "@playwright/test";

// #580: the create form asks which KIND of role first, and shows only that scope's capabilities.
//
// #536 removed a scope <Select> nobody could find and derived the scope from the ticked boxes; the
// user then hit the other half of the problem — with both vocabularies in one grid you cannot tell
// what you are building until you have already ticked something. Segments, visible from the start.
//
// Real Chromium because the point IS the form: what is on screen before you touch anything, and what
// the switch does to the boxes.
test("#580: the scope is chosen first, and the capability list follows it", async ({ page, request }) => {
  const name = `e2e-580-${Date.now()}`;
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("role-create").click();

  // the choice is READABLE without opening anything, and one side is already selected — the form
  // always says what it is building
  const segments = page.getByTestId("role-scope-segments");
  await expect(segments).toBeVisible();
  await expect(page.getByTestId("role-scope-resource")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("role-scope-tenant")).toHaveAttribute("aria-checked", "false");

  // space/page vocabulary only
  await expect(page.getByTestId("role-cap-view")).toBeVisible();
  await expect(page.getByTestId("role-cap-createSpaces"), "the other scope's words are not on screen").toHaveCount(0);

  // switching swaps the whole vocabulary — this is what makes a mixed role unbuildable
  await page.getByTestId("role-scope-tenant").click();
  await expect(page.getByTestId("role-scope-tenant")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("role-cap-createSpaces")).toBeVisible();
  await expect(page.getByTestId("role-cap-view")).toHaveCount(0);
  await expect(page.getByTestId("role-cap-issueApiKeys")).toBeVisible();

  // a tick does not survive the switch: keeping it would rebuild the mix this removes
  await page.getByTestId("role-cap-createSpaces").check();
  await page.getByTestId("role-scope-resource").click();
  await page.getByTestId("role-scope-tenant").click();
  await expect(page.getByTestId("role-cap-createSpaces")).not.toBeChecked();

  // and it saves as a TENANT role — the segment is what decides, no derivation
  await page.getByTestId("role-name-input").fill(name);
  await page.getByTestId("role-cap-issueApiKeys").check();
  await page.getByTestId("role-save").click();
  const row = page.getByTestId("custom-role-row").filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 8000 });
  // it landed in the tenant section (the list's own scope split, #536 ④ — non-regression)
  const tenantList = page.getByTestId("roles-list-tenant");
  await expect(tenantList.getByTestId("custom-role-row").filter({ hasText: name })).toBeVisible();

  // TWO LAYERS: the UI cannot compose a mix, and the server refuses one anyway (#445/ADR-171)
  const mixed = await request.post("/api/admin/roles", {
    headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
    data: { name: `${name}-mixed`, capabilities: ["view", "createSpaces"], scope: "tenant" },
  });
  expect(mixed.status(), "the API is the fortress, not the form").toBe(400);

  // clean up
  const list = await request.get("/api/admin/roles", { headers: { authorization: "Bearer dev-token" } });
  const created = ((await list.json()).custom as { id: string; name: string }[]).find((r) => r.name === name);
  if (created) await request.delete(`/api/admin/roles/${created.id}`, { headers: { authorization: "Bearer dev-token" } });
});
