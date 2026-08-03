import { test, expect, type Page } from "@playwright/test";

// #578 (review rejection ②): a hint must not move the control it is hinting about.
//
// Measured on the device: typing a name the directory does not carry made the note appear as a SIBLING
// of the input inside a flex column, so the column took the note's width — the field went 199px → 405px,
// the row grew, and the vertical centring pushed the role select and the add button 11px down. The
// completion list is positioned `top: 100%`, which resolved against that column rather than the field,
// so it drifted away from the input it belongs to. And a half-typed "wiki" was called unconfirmed while
// the list was still offering "wiki Editors" to complete it: two contradictory answers at once.
//
// Real browser and real geometry, because every one of those is a rect. The numbers are compared
// against THEMSELVES (before vs after the note) rather than to constants — a layout that is wrong in
// both states would pass a constant, and the defect was a difference.
const GROUP_ROW = { input: "space-grant-group-name", list: "space-grant-group-list", note: "space-grant-group-unconfirmed", role: "space-grant-capability", add: "space-grant-add" };

async function openGroupHalf(page: Page): Promise<void> {
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("space-grant-type").click();
  await page.getByRole("option", { name: /group/i }).click();
  await expect(page.getByTestId(GROUP_ROW.input)).toBeVisible();
}

test("#578 ②: the unconfirmed note does not resize the field or move the row", async ({ page }) => {
  test.setTimeout(120_000);
  await openGroupHalf(page);
  const input = page.getByTestId(GROUP_ROW.input);
  const role = page.getByTestId(GROUP_ROW.role);
  const add = page.getByTestId(GROUP_ROW.add);

  const before = {
    input: (await input.boundingBox())!,
    role: (await role.boundingBox())!,
    add: (await add.boundingBox())!,
  };

  await input.fill(`zzz-nobody-carries-${Date.now().toString(36)}`);
  await expect(page.getByTestId(GROUP_ROW.note), "the note is the state under test").toBeVisible();

  const after = {
    input: (await input.boundingBox())!,
    role: (await role.boundingBox())!,
    add: (await add.boundingBox())!,
  };

  expect(Math.round(after.input.width), "the field keeps its width when the note appears").toBe(Math.round(before.input.width));
  expect(Math.round(after.role.y), "the role control does not move").toBe(Math.round(before.role.y));
  expect(Math.round(after.add.y), "the add button does not move").toBe(Math.round(before.add.y));
  expect(Math.round(after.input.y), "and neither does the field itself").toBe(Math.round(before.input.y));
});

test("#578 ②: the completion list hangs off the field, not off whatever else is in the column", async ({ page }) => {
  test.setTimeout(120_000);
  // "wiki Editors" is carried by the seeded member (infra/db/seed.ts), so the directory really has
  // produced it — the same path a real group takes. Completion reads `members.groups`, so a name that
  // was only ever typed into a grant is NOT offered here, and using one would measure the wrong thing.
  await openGroupHalf(page);
  const input = page.getByTestId(GROUP_ROW.input);
  await input.fill("wiki"); // a prefix: still being completed, not yet an answer
  const list = page.getByTestId(GROUP_ROW.list);
  await expect(list, "a prefix of a group the directory carries offers completion").toBeVisible({ timeout: 5000 });

  const box = (await input.boundingBox())!;
  const listBox = (await list.boundingBox())!;
  expect(Math.abs(listBox.y - (box.y + box.height) - 2), "the list sits just under the field").toBeLessThan(3);

  await expect(
    page.getByTestId(GROUP_ROW.note),
    "a name still being completed is not yet an unconfirmed name — the two answers contradict",
  ).toHaveCount(0);
});
