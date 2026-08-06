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
  // #638 slice 2: the link arrives in a modal now, and it has to be dismissed before the list behind it
  // can be used — which is the point of a modal for a secret shown once.
  const link = page.getByTestId("invite-link-value");
  await expect(link).toBeVisible({ timeout: 20_000 });
  const before = (await link.textContent())!.trim();
  expect(before, "the create flow produced a link").toMatch(/\/invite\?token=/);
  await expect(page.getByTestId("invite-link-copy"), "…and it can be copied").toBeVisible();
  await page.getByTestId("secret-dialog-done").click();
  await expect(link).toBeHidden({ timeout: 10_000 });

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

  await expect(link, "the new link arrives in the same modal").toBeVisible({ timeout: 20_000 });
  const after = (await link.textContent())!.trim();
  expect(after, "a usable link, not a confirmation message").toMatch(/\/invite\?token=/);
  expect(after, "and it is a DIFFERENT link — the old one has been replaced").not.toBe(before);
  await page.getByTestId("secret-dialog-done").click();

  // ONE invitation still — a second row is how #606 put one person on two seats
  await expect(page.locator('[data-testid="invite-row"]').filter({ hasText: addr }), "still one invitation")
    .toHaveCount(1);

  // clean up: the invitation is this spec's, and leaving it pending would drown the next walk of this list
  await row.getByTestId("invite-revoke").click();
  await page.getByTestId("members-confirm").click();
  await sleep(500);
});

// #638 ①③④⑤⑫ (slice 2): the same screen, measured for shape rather than for reach.
//
// Supplied rather than taken from the fixture, and with addresses of deliberately different lengths
// the defect is that the row was one sentence (" · "), so the controls after it slid left and
// right with the address and the button a reader was reaching for was never twice in the same place.
const INVITE = (i: number, email: string) => ({
  id: `i${i}`, email, role: "member", invited_by: "dev-user",
  expires_at: "2027-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z",
  last_emailed_at: i % 2 === 0 ? "2026-01-01T00:00:00Z" : null,
});
const ADDRESSES = ["a@e.test", "considerably-longer-address@example-domain.test", "mid@sample.test"];

test("#638: the pending list is a column of rows, and its controls line up", async ({ page }) => {
  test.setTimeout(90_000);
  await openDemo(page);
  await page.route("**/api/members/invites", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ invites: ADDRESSES.map((a, i) => INVITE(i, a)) }),
    });
  });
  await page.goto("/admin/members");
  await expect(page.getByTestId("invite-list")).toBeVisible({ timeout: 20_000 });
  await sleep(400);

  const m = await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('[data-testid="invite-list"]')!;
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="invite-row"]')];
    const xOf = (r: HTMLElement, id: string) =>
      Math.round(r.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.getBoundingClientRect().x);
    return {
      rows: rows.length,
      revokeX: [...new Set(rows.map((r) => xOf(r, "invite-revoke")))],
      mailed: rows.map((r) => r.querySelector('[data-testid="invite-mailed"]')?.getAttribute("data-mailed")),
      // ⑤ nothing in this list styles itself inline any more
      inlineStyled: [...box.querySelectorAll("*")].filter((el) => el.getAttribute("style")).length,
      scrolls: box.scrollHeight > box.clientHeight + 1,
    };
  });

  expect(m.rows, "the stub filled the list").toBe(3);
  // ④ the control is in one place regardless of how long the address is
  expect(m.revokeX.length, `revoke sits at ${JSON.stringify(m.revokeX)} across rows of different widths`).toBe(1);
  // ⑩ (slice 1) still reported, per row
  expect(new Set(m.mailed), "the rows still say who has been mailed").toEqual(new Set(["yes", "no"]));
  expect(m.inlineStyled, "no element in the list styles itself inline").toBe(0);
  expect(m.scrolls, "three invitations do not need a scrollbar").toBe(false);
});

test("#638: …and twenty invitations scroll inside the box instead of growing the page", async ({ page }) => {
  test.setTimeout(90_000);
  await openDemo(page);
  await page.route("**/api/members/invites", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ invites: Array.from({ length: 40 }, (_, i) => INVITE(i, `bulk${i}@e.test`)) }),
    });
  });
  await page.goto("/admin/members");
  await expect(page.getByTestId("invite-list")).toBeVisible({ timeout: 20_000 });
  await sleep(500);

  const m = await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('[data-testid="invite-list"]')!;
    return {
      rows: document.querySelectorAll('[data-testid="invite-row"]').length,
      scrolls: box.scrollHeight > box.clientHeight + 1,
      boxHeight: Math.round(box.getBoundingClientRect().height),
    };
  });
  expect(m.rows, "the stub filled the list").toBeGreaterThan(20);
  expect(m.scrolls, "the box scrolls rather than the page growing").toBe(true);
  expect(m.boxHeight, `the box stops growing (${m.boxHeight}px)`).toBeLessThan(500);
});
