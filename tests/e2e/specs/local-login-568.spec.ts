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

    // Acceptance: the person sets their own password. Cross-origin fetch from the page's context so
    // the same-origin proof is genuine rather than forged by the test.
    await page.goto(`${REAL}/login`);
    const accepted = await page.evaluate(async ([tok, pw]) => {
      const r = await fetch("/api/auth/local/accept", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: tok, password: pw }),
      });
      return { status: r.status, body: await r.text() };
    }, [token, PASSWORD]);
    expect(accepted.status, `accept said ${accepted.body}`).toBe(201);

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
