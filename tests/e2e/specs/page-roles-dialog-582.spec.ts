import { test, expect } from "@playwright/test";
import { API, openDemo, sleep } from "../helpers";

// #582 / ADR-202 §1: the page permissions dialog offers custom roles in the SAME picker as the five
// capabilities, and a role-conferred grant is its own row, revoked by unassigning.
//
// The row kind matters for a reason that is not cosmetic: revoking a role-owned capability through the
// grant path answers success, writes an audit entry and fires a webhook while changing nothing in FGA.
// A row offering that button would be a button that lies.
test("#582: the page dialog offers custom roles beside the capabilities, and role rows unassign", async ({ page }) => {
  const stamp = Date.now().toString(36);
  const roleName = `e2e-pagerole-${stamp}`;
  await openDemo(page);

  const { pageId, roleId } = await page.evaluate(async ({ api, roleName }) => {
    const p = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: `page roles ${roleName}` }),
    });
    const r = await fetch(`${api}/admin/roles`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ name: roleName, capabilities: ["view", "comment"], scope: "resource" }),
    });
    return { pageId: ((await p.json()) as { id: string }).id, roleId: ((await r.json()) as { id: string }).id };
  }, { api: API, roleName });

  try {
    await page.goto(`/p/${pageId}`);
    await page.waitForSelector("[data-pane=preview] .cm-content");
    await sleep(400);
    await page.click("[data-testid=page-overflow-trigger]");
    await page.click("[data-testid=permissions-open]");
    await expect(page.getByTestId("grant-relation")).toBeVisible({ timeout: 10_000 });

    // ONE picker: the five capabilities AND the tenant's resource-scope custom roles
    await page.getByTestId("grant-relation").click();
    await expect(page.getByRole("option", { name: roleName }), "the custom role is in the same list").toBeVisible({ timeout: 8000 });
    await page.getByRole("option", { name: roleName }).click();

    // grant it to a member, and the row reads as the ROLE rather than as its capabilities
    await page.getByTestId("grant-sub").fill("dev-user");
    await sleep(400);
    const candidate = page.getByTestId("grant-candidate").first();
    if (await candidate.count()) await candidate.click();
    await page.getByTestId("grant-add").click();

    const roleRow = page.getByTestId("grant-role-item").filter({ hasText: roleName });
    await expect(roleRow, "a role is one row, not its expansion").toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId("grant-item").filter({ hasText: "comment" }), "the role's capabilities are not enumerated as grants").toHaveCount(0);

    // and it is revoked by unassigning, not by the capability ×
    await roleRow.getByTestId("grant-role-revoke").click();
    await expect(page.getByTestId("grant-role-item").filter({ hasText: roleName })).toHaveCount(0, { timeout: 8000 });
  } finally {
    await page.evaluate(async ({ api, roleId, pageId }) => {
      await fetch(`${api}/admin/roles/${roleId}`, { method: "DELETE", headers: { Authorization: "Bearer dev-token" } }).catch(() => {});
      await fetch(`${api}/pages/${pageId}`, { method: "DELETE", headers: { Authorization: "Bearer dev-token" } }).catch(() => {});
    }, { api: API, roleId, pageId });
  }
});

// #586 / ADR-203 §2: hovering — and focusing, and tapping — a role says what it confers.
//
// Driven in a real browser because the whole point is reachability: the delegated `data-tip` tooltip
// renders one line and cannot show a list, and a Radix tooltip that is not controlled closes itself on
// pointerdown, which on a tablet means the tap that should open it is the tap that closes it.
test("#586: a role badge lists what it lets someone do", async ({ page }) => {
  const stamp = Date.now().toString(36);
  await openDemo(page);
  const { pageId } = await page.evaluate(async ({ api, stamp }) => {
    const p = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: `role tip ${stamp}` }),
    });
    const pageId = ((await p.json()) as { id: string }).id;
    // one individually granted capability, so the dialog has a row to describe
    await fetch(`${api}/pages/${pageId}/access`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ grantee: "user:dev-user", relation: "edit" }),
    });
    return { pageId };
  }, { api: API, stamp });

  try {
    await page.goto(`/p/${pageId}`);
    await page.waitForSelector("[data-pane=preview] .cm-content");
    await sleep(400);
    await page.click("[data-testid=page-overflow-trigger]");
    await page.click("[data-testid=permissions-open]");
    await expect(page.getByTestId("grant-relation")).toBeVisible({ timeout: 10_000 });

    const badge = page.getByTestId("grant-origin").first();
    await expect(badge, "the granted row is there to describe").toBeVisible({ timeout: 8000 });
    // keyboard first: a tooltip only a mouse can reach is not
    await badge.focus();
    const tip = page.getByRole("tooltip").first();
    await expect(tip).toBeVisible({ timeout: 4000 });
    expect((await tip.innerText()).trim().length, "it lists capabilities rather than showing an empty box").toBeGreaterThan(0);
    expect(["role", "grant"], "and the badge says which kind of access it is").toContain(await badge.getAttribute("data-origin"));

    // #586 review ①: a page grant is a single ARM. The tooltip used to look its badge up in the table of
    // space NOUNS and so told a reader that a page `edit` grant could comment — which the store denies
    // (`role-capability-truth-586`: "a bare edit grant is NOT the editor noun"). Measured on the rendered
    // text, because the defect was invisible to every type along the way.
    //
    // The EDIT row by name, not the first one: the page's creator already holds a manage grant, and the
    // first attempt at this assertion read that row instead and passed for the wrong reason.
    const editRow = page.getByTestId("grant-item").filter({ has: page.getByText("editor", { exact: true }) }).first();
    await expect(editRow, "the edit grant has a row").toBeVisible({ timeout: 8000 });
    const editBadge = editRow.getByTestId("grant-origin");
    await editBadge.focus();
    // …and read the tooltip THIS badge points at. The manage row's tooltip is still open from the focus
    // above, so `getByRole("tooltip").first` reads that one — which it did, and passed for the wrong
    // reason until the rendered text was actually looked at.
    const tipId = await editBadge.getAttribute("aria-describedby");
    expect(tipId, "the badge names its own tooltip").toBeTruthy();
    const editTip = page.locator(`#${tipId}`);
    await expect(editTip).toBeVisible({ timeout: 4000 });
    const tipText = (await editTip.innerText()).toLowerCase();
    expect(tipText, "the edit grant lists edit").toContain("edit");
    expect(tipText, "and does NOT claim comment — the server pins that it confers none").not.toContain("comment");

    // #586 (review rejection, 2026-08-03): the option is the NAME, and what it confers is REVEALED. The
    // previous shape printed the capability list under all nine labels, and the reader had to read the
    // whole vocabulary before picking one of them.
    // Opened from the KEYBOARD: the dialog is still settling and Playwright's click waits for the
    // trigger to stop moving, which (measured, twice now) it never does. Focus and Enter is the same act.
    await page.getByTestId("grant-relation").focus();
    await page.keyboard.press("Enter");
    const option = page.getByTestId("grant-relation-builtin:manage");
    await expect(option, "the picker offers the built-in roles").toBeVisible({ timeout: 4000 });
    // At rest the option is the NAME. The reject was a list of capabilities printed under all nine
    // labels, which made the reader read the vocabulary before picking one of them.
    const atRest = (await option.innerText()).trim().toLowerCase();
    expect(atRest, "the option is the role's name and nothing else").toBe("manager");

    // Pointing at it reveals what it confers…
    // Two moves, not `hover`: a single placement leaves the page with no pointer MOVEMENT to react to
    // (measured — `[role=option]:hover` matched nothing afterwards). The assertion then reads whichever
    // option the pointer actually ended on, because the list settles after the box is measured and the
    // row under the pointer is not always the row that was aimed at — an earlier version of this test
    // measured one option and hovered another, and called the feature broken.
    const box = (await option.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2 + 1);
    await sleep(400);
    const hovered = await page.evaluate(() => {
      const it = document.querySelector("[role=option]:hover") as HTMLElement | null;
      return { name: it?.textContent?.trim() ?? "", shown: it?.innerText?.trim() ?? "" };
    });
    expect(hovered.name, "the pointer is on an option").not.toBe("");
    expect(hovered.shown.toLowerCase().replace(/\s+/g, " "), `hovering ${hovered.name} says what it confers`).toMatch(/view|閲覧/);

    // …and so does the arrow key, which is the case a hover-only reveal loses: Radix drives this list
    // with `data-highlighted` rather than DOM focus, so anything bound to focus alone stays shut for a
    // keyboard user.
    await page.keyboard.press("ArrowDown");
    await sleep(300);
    const viaKeyboard = await page.evaluate(() => {
      const item = document.querySelector("[role=option][data-highlighted]") as HTMLElement | null;
      return { name: item?.textContent?.trim().toLowerCase() ?? "", shown: item?.innerText?.toLowerCase() ?? "" };
    });
    expect(viaKeyboard.name, "the highlight is on an option").not.toBe("");
    expect(viaKeyboard.shown.replace(/\s+/g, " "), `the highlighted option (${viaKeyboard.name}) explains itself too`).toMatch(/view|閲覧/);
    await page.keyboard.press("Escape");
  } finally {
    await page.evaluate(async ({ api, pageId }) => {
      await fetch(`${api}/pages/${pageId}`, { method: "DELETE", headers: { Authorization: "Bearer dev-token" } }).catch(() => {});
    }, { api: API, pageId });
  }
});
