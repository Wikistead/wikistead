import { test, expect, type APIRequestContext } from "@playwright/test";
import { WEB_REAL_PORT, MAILPIT_API, DEV_USER_SHOWN } from "../helpers";

// Invite → accept in a REAL browser (P1.4), on the real-mode web (5181, no
// dev-token). Proves the whole seat-lever loop end-to-end through the same-origin
// proxy: an admin (dev-user) invites via the Admin Console, the invite email lands
// in Mailpit (real SMTP), and a FRESH non-member identity accepts the link and is
// SEATED as a member (the new membership grant; login alone never grants).
//
// The fresh identity is minted by setting the issuer's `e2e_sub` cookie on the
// invitee's browser context — the test OP issues that subject (a real OP would use
// its own login session), so the invitee is genuinely not yet a member.
const WEB = `http://dev.localhost:${WEB_REAL_PORT}`;
// #484: derived from WKS_STACK_OFFSET like every other port — see helpers.ts.
const MAILPIT = MAILPIT_API;

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

/**
 * What the invite field is CALLED to a reader (#740 gave these fields visible labels, and an accessible
 * name follows the label a person can see). Spelled once: two tests fill this box, and a rename that
 * broke both of them used to read as two separate failures.
 */
const INVITE_EMAIL_LABEL = "Email address";

test("admin invites a member; a fresh identity accepts in the browser and is seated", async ({ browser, request }) => {
  // #891/#938: isolated from the merge gate — the shared real-auth tenant has accumulated dozens of
  // undeleted debris members (from avatar-isolation-372.spec.ts and friends), burying the seeded Dev
  // User row below the fold. Remove this skip once #938 lands.
  test.skip(true, "#938: isolated — Dev User buried under real-auth tenant debris");
  // ── admin (dev-user): real OIDC login, then the Admin Console ──────────────
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await admin.goto(`${WEB}/auth/login`);
  await admin.waitForURL((u) => !u.pathname.startsWith("/auth/"), { timeout: 15_000 });

  await admin.goto(`${WEB}/settings/members`);
  // #579 gave this page a second heading ("Members and groups"), so the un-anchored name matched
  // two elements and the spec failed in strict mode — the page was fine, the locator was not.
  // #867: the first assertion after a navigation is the one that meets a cold dev server, and the
  // default 5s ran out while Vite was still compiling the settings bundle (measured: this line failing
  // at 5.8s on a fresh stack, while the page itself was fine). Every other first-render assertion in
  // this suite carries a timeout for the same reason.
  await expect(admin.getByRole("heading", { name: "Members", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(admin.getByText(DEV_USER_SHOWN)).toBeVisible(); // the admin is listed (#902: shown name)

  const inviteEmail = `invitee${Date.now()}@e2e.test`;
  await admin.getByLabel(INVITE_EMAIL_LABEL).fill(inviteEmail);
  await admin.getByRole("button", { name: "Send invite" }).click();

  // #638: the link is shown once, in a modal — read the value inside the box, then dismiss it so the
  // console behind is usable again.
  const link = await admin.getByTestId("invite-link-value").textContent();
  await admin.getByTestId("secret-dialog-done").click();
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
  await admin.getByLabel(INVITE_EMAIL_LABEL).fill(`once${Date.now()}@e2e.test`);
  await admin.getByRole("button", { name: "Send invite" }).click();
  // #638: the link is shown once, in a modal — read the value inside the box, then dismiss it so the
  // console behind is usable again.
  const link = await admin.getByTestId("invite-link-value").textContent();
  await admin.getByTestId("secret-dialog-done").click();
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
