import { test, expect } from "@playwright/test";
import { API, WEB_REAL_PORT } from "../helpers";

// #568 / ADR-198: password sign-in, walked in a real browser from an admin turning it on to a member
// signing in with it. The parts a unit test cannot reach are the ones that matter here: the form
// actually posts, the browser actually KEEPS the session cookie the response sets, and a refusal is
// one message whichever way it failed.
const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };
const REAL = `http://dev.localhost:${WEB_REAL_PORT}`;
const STAMP = Date.now().toString(36);
const EMAIL = `local568-${STAMP}@e2e.test`;
const PASSWORD = "an-e2e-passphrase-long-enough";

const setLocalLogin = (on: boolean) =>
  fetch(`${API}/admin/login-methods`, { method: "PATCH", headers: H, body: JSON.stringify({ localLoginEnabled: on }) });

test("#568: an invited member sets a password and signs in with it", async ({ page, request }) => {
  const on = await setLocalLogin(true);
  expect(on.status, await on.text()).toBe(204);
  try {
    // The admin issues a PASSWORD invite (the API the console will drive).
    const created = await fetch(`${API}/members/invites`, {
      method: "POST", headers: H,
      body: JSON.stringify({ email: EMAIL, role: "member", kind: "local" }),
    });
    const body = await created.text();
    expect(created.status, body).toBe(201);
    // the route answers with the LINK (the plaintext token rides in it and is stored only as a hash)
    const inviteUrl = (JSON.parse(body) as { inviteUrl: string }).inviteUrl;
    const token = new URL(inviteUrl).searchParams.get("token")!;
    expect(token, "the link carries a token").toBeTruthy();

    // review B2: the LINK is what a person actually opens, and it used to send them to the IdP —
    // burning the token on an OIDC seat and never writing the credential. Walk the real page.
    await page.goto(`${REAL}/invite?token=${encodeURIComponent(token)}`);
    await expect(page.getByTestId("set-password"), "a password invite offers a password form").toBeVisible({ timeout: 10_000 });
    // #807: an accepted password invite asks what to call you, and the submit stays disabled until
    // it is answered — the member would otherwise arrive nameless in the roster and in presence.
    await page.getByTestId("set-password-display-name").fill("Invited Member");
    await page.getByTestId("set-password-input").fill(PASSWORD);
    await page.getByTestId("set-password-confirm").fill(PASSWORD);
    await page.getByTestId("set-password-submit").click();
    await page.waitForURL((u) => !u.pathname.startsWith("/invite"), { timeout: 15_000 });
    expect((await page.context().cookies()).some((c) => c.name === "wks_sess"), "accepting signed them in").toBe(true);

    // Sign OUT so the next step proves the password, not the acceptance session.
    await page.context().clearCookies();
    await page.goto(`${REAL}/login`);
    await expect(page.getByTestId("login-local"), "the password form is on the screen").toBeVisible({ timeout: 10_000 });

    // A wrong password: one message, and no session.
    await page.getByTestId("login-local-identifier").fill(EMAIL);
    await page.getByTestId("login-local-password").fill("definitely-not-the-password");
    await page.getByTestId("login-local-submit").click();
    await expect(page.getByTestId("login-local-error")).toBeVisible();
    const wrongText = await page.getByTestId("login-local-error").textContent();

    // An address nobody has: the SAME message (the screen must not answer "does this account exist").
    await page.getByTestId("login-local-identifier").fill(`ghost-${STAMP}@e2e.test`);
    await page.getByTestId("login-local-password").fill(PASSWORD);
    await page.getByTestId("login-local-submit").click();
    await expect(page.getByTestId("login-local-error")).toBeVisible();
    expect(await page.getByTestId("login-local-error").textContent(), "one message for both").toBe(wrongText);

    // The real password gets in, and the browser kept the cookie.
    await page.getByTestId("login-local-identifier").fill(EMAIL);
    await page.getByTestId("login-local-password").fill(PASSWORD);
    await page.getByTestId("login-local-submit").click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15_000 });
    expect(page.url(), "signed in, off the login screen").not.toContain("/login");
    expect((await page.context().cookies()).some((c) => c.name === "wks_sess"), "the session cookie survived").toBe(true);
  } finally {
    await setLocalLogin(false).catch(() => {});
    void request;
  }
});

test("#568: with passwords switched off the form is not on the screen", async ({ page }) => {
  await setLocalLogin(false);
  await page.goto(`${REAL}/login`);
  await expect(page.getByTestId("login-card")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("login-local"), "nothing to type into when the tenant does not offer it").toHaveCount(0);
});

test("#568 review R3: the login screen can ask for a reset link", async ({ page }) => {
  // Without this the reset endpoints were live and nothing in the product reached them — an
  // unauthenticated surface with no user, which is the same shape as the invite-link defect.
  const on = await setLocalLogin(true);
  expect(on.status).toBe(204);
  try {
    await page.goto(`${REAL}/login`);
    await expect(page.getByTestId("login-local")).toBeVisible({ timeout: 10_000 });
    // it needs the address first — asking for "a reset for nobody in particular" is not a thing
    await page.getByTestId("login-local-forgot").click();
    await expect(page.getByTestId("login-local-error"), "with an empty field it asks for one").toBeVisible();

    await page.getByTestId("login-local-identifier").fill(`stranger-${STAMP}@e2e.test`);
    await page.getByTestId("login-local-forgot").click();
    // The confirmation is the same whatever happened, because the server answers the same — a
    // screen that said "we sent it" only for real accounts would be the oracle by another route.
    await expect(page.getByTestId("login-local-reset-sent")).toBeVisible();
  } finally {
    await setLocalLogin(false).catch(() => {});
  }
});
