import { test, expect } from "@playwright/test";
import { openDemo, sleep, INVITE_EMAIL_LABEL } from "../helpers";

// #638 (user ruling): an admin can hand a pending invitation over again, from the row it is on.
//
// The scenario the ruling asks the product to survive: a self-hosted tenant with no mail configured, where
// the link that appeared once on the screen that made the invite is the only copy of it. Losing that link
// used to mean revoking and inviting again — a different invitation to anyone reading the ledger, and a
// second chance to mistype the address.
//
// Driven through the screen rather than the API, because the ruling is about reach: the act existing on
// the server is not the same as an admin being able to perform it from where they are looking.
// #891/#937: isolated from the merge gate. NOT for the reason first written here — that theory (an
// onboarding popover overlapping the row's dialog) did not reproduce: standalone x7 and once in a
// full 20-spec gate run, this test passed clean. A second full-gate run then failed it at a DIFFERENT
// point (members-filter never appearing after /admin/members, before any invite work starts) — the
// #823/#825 "shared stack gets heavy under a full run" family, same as #969/#972/#973, not a defect
// this test or the popover theory can fix. Re-isolated under the correct reason rather than left
// claiming a root cause that was not real.
//
// The skip is lifted to describe scope (the project design notes's own note on this file): this test requests `{
// page }`, and Playwright resolves that fixture before an in-body `test.skip` ever runs — a slow
// enough run can still time out fixture setup and fail the gate, with the isolation counter none the
// wiser. Evaluated at collection time here, before any fixture is requested.
test.describe(() => {
  test.skip(true, "#937: isolated — #823/#825 family (shared stack under gate load), not the popover theory this ticket started with");

  test("#638: a pending invitation can be handed over again from its own row", async ({ page }) => {
    test.setTimeout(120_000);
    await openDemo(page);
    await page.goto("/admin/members");
    await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 20_000 });

    // an invitation to work with, created the way an admin creates one
    const addr = `handoff638-${Date.now().toString(36)}@e2e.test`;
    await page.getByLabel(INVITE_EMAIL_LABEL).fill(addr);
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

    // #638 the hand-off is a dialog opened from the row, and OPENING IT COSTS NOTHING. Two buttons
    // used to sit here — "new link" and "resend" — calling the same endpoint, so a reader who pressed the
    // one that sounded harmless invalidated the link its recipient was already holding.
    await expect(row.getByTestId("invite-reissue"), "the two-button row is gone").toHaveCount(0);
    await expect(row.getByTestId("invite-resend")).toHaveCount(0);
    //
    // Measured at the NETWORK, not by looking for the link. A first version asserted the link was hidden
    // right after the dialog opened, and a build that minted ON OPEN still passed it — the request had not
    // come back yet, so "not there" and "not asked for" looked identical. Counting calls cannot be early.
    const minted: string[] = [];
    page.on("request", (r) => { if (/\/invites\/[^/]+\/reissue/.test(r.url())) minted.push(r.url()); });

    await row.getByTestId("invite-link-open").click();
    await expect(page.getByTestId("invite-link-dialog"), "the dialog opens").toBeVisible({ timeout: 10_000 });
    await sleep(1200); // long enough for a mint-on-open to have travelled
    expect(minted.length, `opening it issued a link :: ${JSON.stringify(minted)}`).toBe(0);
    await expect(link, "…and there is nothing to copy yet").toBeHidden();
    const warning = (await page.getByTestId("invite-link-warn").textContent()) ?? "";
    expect(warning, `it says what issuing will cost: ${warning.slice(0, 200)}`)
      .toMatch(/stops the previous one|使えなくなります/);

    // …and the invitation the recipient holds is still the one from before
    await page.getByTestId("secret-dialog-done").click();
    await sleep(400);
    await row.getByTestId("invite-link-open").click();
    await expect(page.getByTestId("invite-link-mint"), "the deliberate second press").toBeVisible();
    await page.getByTestId("invite-link-mint").click();

    await expect(link, "the new link arrives in the same modal").toBeVisible({ timeout: 20_000 });
    expect(minted.length, "…and exactly one deliberate press produced it").toBe(1);
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
});

// #638 ①③④⑤⑫ (slice 2): the same screen, measured for shape rather than for reach.
//
// Supplied rather than taken from the fixture, and with addresses of deliberately different lengths
// the defect is that the row was one run-on "email · role" sentence, so the controls after it slid left and
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
      // ③ the row has exactly two controls now: the link, and revoking it
      controls: [...new Set(rows.map((r) => r.querySelectorAll("button").length))],
      // #638 ⑤: the delivery column is gone. It said the same thing on every row — the tenant has
      // mail configured or it does not — so it was a column that carried no information.
      mailed: rows.filter((r) => r.querySelector('[data-testid="invite-mailed"]')).length,
      // ⑤ nothing in this list styles itself inline any more
      inlineStyled: [...box.querySelectorAll("*")].filter((el) => el.getAttribute("style")).length,
      scrolls: box.scrollHeight > box.clientHeight + 1,
    };
  });

  expect(m.rows, "the stub filled the list").toBe(3);
  // ④ the control is in one place regardless of how long the address is
  expect(m.revokeX.length, `revoke sits at ${JSON.stringify(m.revokeX)} across rows of different widths`).toBe(1);
  expect(m.mailed, "no row carries the delivery column any more (⑤)").toBe(0);
  expect(m.controls, `each row carries two controls :: ${JSON.stringify(m.controls)}`).toEqual([2]);
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
