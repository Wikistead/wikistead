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

// #578 (review rejection, 2026-08-04): the correction to the correction. Taking the note out of flow fixed
// the movement and created an overlap — measured landing ON the member list below, 6px into its first
// row. Both must hold at once, so both are measured here: the row does not move (above) AND nothing
// underneath is covered.
test("#578 ②: the note does not land on the list below it", async ({ page }) => {
  test.setTimeout(120_000);
  await openGroupHalf(page);
  await page.getByTestId(GROUP_ROW.input).fill(`zzz-nobody-carries-${Date.now().toString(36)}`);
  const note = page.getByTestId(GROUP_ROW.note);
  await expect(note).toBeVisible();
  const noteBox = (await note.boundingBox())!;
  const list = (await page.getByTestId("space-member-list").boundingBox())!;
  expect(noteBox.y + noteBox.height, `the note ends above the member list (note bottom ${Math.round(noteBox.y + noteBox.height)}, list top ${Math.round(list.y)})`)
    .toBeLessThanOrEqual(Math.round(list.y));
});

// #578 (review rejection, 2026-08-04, round 3): the room the note needed came from a spacer INSIDE the
// picker's flex column, so the FormRow's vertical centring pushed the role Select and the add button
// 16px below the field whenever the group half was showing — and flipping Member⇄Group made the right
// side of the row jump. The reservation lives OUTSIDE the row now. Three facts must hold at once and
// are measured together: one top edge across the row, nothing moves on a kind flip, and the note still
// stays off the list below (the previous test keeps that one).
test("#578 ②: the group half keeps one top edge, and flipping the kind moves nothing", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 10_000 });
  const role = page.getByTestId(GROUP_ROW.role);
  const add = page.getByTestId(GROUP_ROW.add);
  const member = { role: (await role.boundingBox())!, add: (await add.boundingBox())! };

  await page.getByTestId("space-grant-type").click();
  await page.getByRole("option", { name: /group/i }).click();
  await expect(page.getByTestId(GROUP_ROW.input)).toBeVisible();
  const group = {
    input: (await page.getByTestId(GROUP_ROW.input).boundingBox())!,
    role: (await role.boundingBox())!,
    add: (await add.boundingBox())!,
  };

  expect(Math.round(group.role.y), "the role control has the field's top edge").toBe(Math.round(group.input.y));
  expect(Math.round(group.add.y), "so does the add button").toBe(Math.round(group.input.y));
  expect(Math.round(group.role.y), "and the kind flip moved nothing").toBe(Math.round(member.role.y));
  expect(Math.round(group.add.y)).toBe(Math.round(member.add.y));
});

// #578 (review rejection, 2026-08-04): changing a custom-role row to a built-in replaced it on the SERVER
// and kept both rows on the SCREEN — the mutation invalidated only its own query, and the swept row
// lived in the other one. "1 person, 2 roles" on a screen whose whole ruling is that roles do not
// stack. Measured without a reload, both directions, because each direction goes stale in the other
// mechanism's listing.
test("#578: changing a row's role replaces the row in place — no ghost beside it", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now().toString(36);
  const roleName = `e2e-578ghost-${stamp}`;
  const groupTag = `e2e-group-${roleName}`;
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 10_000 });
  const made = await page.evaluate(async ({ name, group }) => {
    const h = { Authorization: "Bearer dev-token", "content-type": "application/json" };
    const roleRes = await fetch("/api/admin/roles", {
      method: "POST", headers: h,
      body: JSON.stringify({ name, capabilities: ["view", "comment"], scope: "resource" }),
    });
    const role = await roleRes.json();
    const assignRes = await fetch(`/api/admin/roles/${role.id}/assignments`, {
      method: "POST", headers: h,
      body: JSON.stringify({ resourceType: "space", resourceId: "demo_space", groupName: group }),
    });
    return { role: roleRes.status, assign: assignRes.status, roleId: role.id as string };
  }, { name: roleName, group: groupTag });
  expect(made.role, JSON.stringify(made)).toBeLessThan(300);
  expect(made.assign, JSON.stringify(made)).toBeLessThan(300);
  try {
    await page.reload();
    await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 10_000 });

    const rowsFor = page.getByTestId("space-member-item").filter({ hasText: groupTag });
    await expect(rowsFor, "the custom-role row is on screen").toHaveCount(1);

    // custom → built-in: the assignment listing must let go of the swept row
    await rowsFor.getByTestId("space-member-role-select").click();
    await page.getByRole("option", { name: "editor", exact: true }).click();
    await expect(rowsFor.first().getByTestId("space-member-role-select"), "the control reads the new role").toContainText("editor", { timeout: 8000 });
    await expect(rowsFor, "one principal, one row — no reload").toHaveCount(1);

    // built-in → custom: same claim, the grant listing's turn to go stale.
    // Keyboard walk, not a click: the custom role sits at the bottom of the listbox, and once the list
    // outgrows its Radix viewport a click retries forever under the sticky scroll button. Opened the
    // way the #582 sweep proved out (focus + Enter, wait for the options), because arrows pressed
    // before the listbox exists fall through to the page — one run committed "manager" that way.
    const trigger = rowsFor.first().getByTestId("space-member-role-select");
    const highlightedName = () => page.evaluate(() =>
      (document.querySelector("[role=option][data-highlighted]") as HTMLElement | null)?.textContent?.trim() ?? "");
    // Retried whole: a query refetch landing while the listbox is open re-renders the options and
    // resets the highlight to the selected value, which can eat most of a single walk. Escape, let it
    // settle, walk again — and never commit anything but the target (one run committed "manager").
    // TYPEAHEAD, not an arrow walk. The walk worked until #604-C put three more nouns in this picker:
    // the list outgrew its viewport, so a click retries forever under Radix's sticky scroll button, and
    // arrows race a query refetch that resets the highlight to the selected value. Radix's own
    // typeahead jumps straight to the name and does not care how long the list is.
    let committed = false;
    for (let attempt = 0; attempt < 3 && !committed; attempt++) {
      await trigger.focus();
      await page.keyboard.press("Enter");
      await page.waitForSelector("[role=option]", { timeout: 5000 });
      // the options exist before keyboard focus lands in the listbox; keys pressed in that window fall
      // through to the page (the same race the #582 sweep hits) — wait for the focus, not the DOM
      await page.waitForFunction(() => document.activeElement?.closest("[role=listbox]") !== null
        || document.activeElement?.getAttribute("role") === "option", undefined, { timeout: 5000 }).catch(() => {});
      await page.keyboard.type(roleName, { delay: 20 });
      await page.waitForTimeout(150);
      if ((await highlightedName()) === roleName) {
        await page.keyboard.press("Enter");
        committed = true;
      } else {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }
    }
    expect(committed, "typed to the custom role and committed it").toBe(true);
    await expect(rowsFor.first().getByTestId("space-member-role-select")).toContainText(roleName, { timeout: 8000 });
    await expect(rowsFor, "still one row after the return trip").toHaveCount(1);
  } finally {
    // leave nothing on demo_space: leftover roles pile into every picker on this shared fixture and
    // made the #582 reveal sweep order-dependent (its 10-step option walk drowned in e2e-* names).
    // Assignments first — a role that is still worn answers 409 to its own DELETE.
    await page.evaluate(async ({ id, group }) => {
      const auth = { Authorization: "Bearer dev-token" };
      const json = { ...auth, "content-type": "application/json" };
      // content-type ONLY where a body goes: Fastify 400s a bodyless DELETE that claims JSON, which is
      // exactly how this cleanup failed silently for a day and let the residue pile up
      await fetch(`/api/spaces/demo_space/access`, { method: "DELETE", headers: json, body: JSON.stringify({ groupName: group, relation: "edit" }) }).catch(() => {});
      const list = await fetch(`/api/admin/roles/assignments?resourceType=space&resourceId=demo_space`, { headers: auth }).then((r) => r.json()).catch(() => []);
      for (const a of (Array.isArray(list) ? list : []).filter((x: { roleId: string | null }) => x.roleId === id)) {
        await fetch(`/api/admin/roles/assignments/${a.id}`, { method: "DELETE", headers: auth }).catch(() => {});
      }
      await fetch(`/api/admin/roles/${id}`, { method: "DELETE", headers: auth }).catch(() => {});
    }, { id: made.roleId, group: groupTag });
  }
});

// #578 (review rejection ③): every row is changed the same way. A custom role used to be a chip with only
// an × — the one kind of role a tenant writes for itself was the one kind nobody could re-assign — which
// contradicts both the standing ruling that built-in and custom share a picker and #591's "an exclusive
// role is changed in a dropdown".
//
// Discovery, not a list: every row on the screen is asked, so a row shape added later is covered without
// touching this file.
test("#578 ③: every space member row carries the same role control", async ({ page }) => {
  test.setTimeout(120_000);
  // A CUSTOM-role row has to be on the screen or this measures nothing: the built-in rows always had a
  // dropdown, and the defect was that the custom ones did not. So one is made here, assigned, and then
  // looked for by name — the row that used to be a chip with only an ×.
  const stamp = Date.now().toString(36);
  const roleName = `e2e-578row-${stamp}`;
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 10_000 });
  const made = await page.evaluate(async ({ name }) => {
    const h = { Authorization: "Bearer dev-token", "content-type": "application/json" };
    const roleRes = await fetch("/api/admin/roles", {
      method: "POST", headers: h,
      // scope is 'resource' | 'tenant' at creation (ADR-171); a space assignment takes a resource role
      body: JSON.stringify({ name, capabilities: ["view", "comment"], scope: "resource" }),
    });
    const role = await roleRes.json();
    const assignRes = await fetch(`/api/admin/roles/${role.id}/assignments`, {
      method: "POST", headers: h,
      body: JSON.stringify({ resourceType: "space", resourceId: "demo_space", groupName: `e2e-group-${name}` }),
    });
    return { role: roleRes.status, assign: assignRes.status, roleId: role.id as string, body: await assignRes.text() };
  }, { name: roleName });
  expect(made.role, `creating the role: ${JSON.stringify(made)}`).toBeLessThan(300);
  expect(made.assign, `assigning it: ${JSON.stringify(made)}`).toBeLessThan(300);
  try {
    await page.reload();
    await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 10_000 });
    const customRow = page.getByTestId("space-member-item").filter({ hasText: `e2e-group-${roleName}` });
    await expect(customRow, "the custom-role row is on screen").toHaveCount(1);
    await expect(customRow.getByTestId("space-member-role-select"), "and it is changed like every other row").toHaveCount(1);

    await page.goto("/spaces/demo_space/settings/members");
    await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 10_000 });
    const rows = page.getByTestId("space-member-item");
    const n = await rows.count();
    expect(n, "there are rows to measure (an empty list would pass forever)").toBeGreaterThan(0);
    const offenders: string[] = [];
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      // a machine-managed row is read-only BY RULE (ADR-183 §1) — it says so with its own badge
      if (await row.getByTestId("space-grant-managed").count()) continue;
      if (!(await row.getByTestId("space-member-role-select").count())) {
        offenders.push((await row.textContent())?.trim().slice(0, 40) ?? `row ${i}`);
      }
    }
    expect(offenders, "a row whose role cannot be changed").toEqual([]);
  } finally {
    // same hygiene as the ghost test above: this fixture is shared, and leftover e2e-* roles made the
    // #582 sweep order-dependent. Assignments first — a worn role 409s its own DELETE.
    await page.evaluate(async ({ id }) => {
      // no content-type: Fastify 400s a bodyless DELETE that claims JSON (see the ghost test's finally)
      const auth = { Authorization: "Bearer dev-token" };
      const list = await fetch(`/api/admin/roles/assignments?resourceType=space&resourceId=demo_space`, { headers: auth }).then((r) => r.json()).catch(() => []);
      for (const a of (Array.isArray(list) ? list : []).filter((x: { roleId: string | null }) => x.roleId === id)) {
        await fetch(`/api/admin/roles/assignments/${a.id}`, { method: "DELETE", headers: auth }).catch(() => {});
      }
      await fetch(`/api/admin/roles/${id}`, { method: "DELETE", headers: auth }).catch(() => {});
    }, { id: made.roleId });
  }
});
