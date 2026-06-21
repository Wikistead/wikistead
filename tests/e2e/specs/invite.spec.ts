import { test, expect, type APIRequestContext } from "@playwright/test";

// Invite → accept in a REAL browser (P1.4), on the real-mode web (5181, no
// dev-token). Proves the whole seat-lever loop end-to-end through the same-origin
// proxy: an admin (dev-user) invites via the Admin Console, the invite email lands
// in Mailpit (real SMTP), and a FRESH non-member identity accepts the link and is
// SEATED as a member (the new membership grant; login alone never grants).
//
// The fresh identity is minted by setting the issuer's `e2e_sub` cookie on the
// invitee's browser context — the test OP issues that subject (a real OP would use
// its own login session), so the invitee is genuinely not yet a member.
const WEB = "http://dev.localhost:5181";
const MAILPIT = "http://localhost:8026/api/v1";

async function mailpitReceived(api: APIRequestContext, to: string): Promise<boolean> {
  for (let i = 0; i < 15; i++) {
    const r = await api.get(`${MAILPIT}/messages`);
    if (r.ok()) {
      const body = (await r.json()) as { messages: { To: { Address: string }[] }[] };
      if (body.messages.some((m) => m.To.some((t) => t.Address === to))) return true;
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  return false;
}

test("admin invites a member; a fresh identity accepts in the browser and is seated", async ({ browser, request }) => {
  // ── admin (dev-user): real OIDC login, then the Admin Console ──────────────
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await admin.goto(`${WEB}/auth/login`);
  await admin.waitForURL((u) => !u.pathname.startsWith("/auth/"), { timeout: 15_000 });

  await admin.goto(`${WEB}/settings/members`);
  await expect(admin.getByRole("heading", { name: "Members" })).toBeVisible();
  await expect(admin.getByText("dev-user")).toBeVisible(); // the admin is listed

  const inviteEmail = `invitee${Date.now()}@e2e.test`;
  await admin.getByLabel("invite email").fill(inviteEmail);
  await admin.getByRole("button", { name: "Send invite" }).click();

  const link = await admin.getByTestId("invite-link").textContent();
  expect(link).toMatch(/\/invite\?token=inv_/);
  // Real SMTP: the invite email reached Mailpit.
  expect(await mailpitReceived(request, inviteEmail), "invite email delivered to Mailpit").toBe(true);

  // ── invitee: a fresh, non-member identity accepts the link ─────────────────
  const inviteeSub = `inv-${Date.now()}`;
  const inviteeCtx = await browser.newContext();
  await inviteeCtx.addCookies([{ name: "e2e_sub", value: inviteeSub, url: "http://127.0.0.1:4444" }]);
  const invitee = await inviteeCtx.newPage();

  await invitee.goto(link!);
  await invitee.getByRole("button", { name: "Accept invite" }).click();
  // Accept → OIDC login (carrying the invite) → callback grants membership → returnTo.
  await invitee.waitForURL((u) => !u.pathname.startsWith("/auth/") && u.pathname !== "/invite", { timeout: 20_000 });

  // Seated: a host-only member session on the tenant origin, as the invitee.
  const me = await invitee.request.get(`${WEB}/api/auth/me`);
  expect(me.status()).toBe(200);
  expect((await me.json()).sub).toBe(inviteeSub);

  await adminCtx.close();
  await inviteeCtx.close();
});

test("the same invite link cannot be accepted twice (consume-once)", async ({ browser }) => {
  // Admin issues one invite.
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await admin.goto(`${WEB}/auth/login`);
  await admin.waitForURL((u) => !u.pathname.startsWith("/auth/"), { timeout: 15_000 });
  await admin.goto(`${WEB}/settings/members`);
  await admin.getByLabel("invite email").fill(`once${Date.now()}@e2e.test`);
  await admin.getByRole("button", { name: "Send invite" }).click();
  const link = await admin.getByTestId("invite-link").textContent();
  await adminCtx.close();

  // First identity accepts → seated.
  const firstSub = `inv-once-a-${Date.now()}`;
  const c1 = await browser.newContext();
  await c1.addCookies([{ name: "e2e_sub", value: firstSub, url: "http://127.0.0.1:4444" }]);
  const p1 = await c1.newPage();
  await p1.goto(link!);
  await p1.getByRole("button", { name: "Accept invite" }).click();
  await p1.waitForURL((u) => !u.pathname.startsWith("/auth/") && u.pathname !== "/invite", { timeout: 20_000 });
  expect((await (await p1.request.get(`${WEB}/api/auth/me`)).json()).sub).toBe(firstSub);
  await c1.close();

  // Second, different identity tries the SAME link → consumed → no membership.
  const secondSub = `inv-once-b-${Date.now()}`;
  const c2 = await browser.newContext();
  await c2.addCookies([{ name: "e2e_sub", value: secondSub, url: "http://127.0.0.1:4444" }]);
  const p2 = await c2.newPage();
  await p2.goto(link!);
  await p2.getByRole("button", { name: "Accept invite" }).click();
  // The callback cannot grant (invite spent) → vague access redirect, no session.
  // (It lands on /login?error=access, which the SPA may then bounce to /p/demo;
  // assert the OUTCOME — not seated — rather than racing the redirect chain.)
  await p2.waitForURL((u) => !u.pathname.startsWith("/auth/") && u.pathname !== "/invite", { timeout: 20_000 });
  const me2 = await p2.request.get(`${WEB}/api/auth/me`);
  expect(me2.status()).not.toBe(200);
  await c2.close();
});
