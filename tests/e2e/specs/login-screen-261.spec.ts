import { test, expect } from "@playwright/test";
import { sleep } from "../helpers";

// #261: the sign-in screen. The auth callback redirects failures to /login?error=<kind>; the dedicated
// /login route renders the branded card and surfaces the error (so a denied / seat-full sign-in isn't
// silent). `access` stays vague (no enumeration). Real Chromium — the full realauth round-trip
// (mini-OP sign-in → logout → back to login) is a needs-human-check; this pins the screen + error wiring.

test("#261: /login renders the branded sign-in card with a sign-in button", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByTestId("login-card")).toBeVisible();
  await expect(page.getByTestId("login-brand")).toBeVisible();
  await expect(page.getByTestId("login-signin")).toBeVisible();
  // no error banner without an ?error query
  await expect(page.getByTestId("login-error")).toHaveCount(0);
});

test("#261: /login?error=access shows a VAGUE error (no enumeration hint)", async ({ page }) => {
  await page.goto("/login?error=access");
  await sleep(200);
  const err = page.getByTestId("login-error");
  await expect(err).toBeVisible();
  // vague — never reveals WHY (no IdP-subject enumeration); must not name the account/reason
  await expect(err).not.toContainText(/not found|no such|unknown user/i);
});

// #371: clicking sign-in navigates top-level to /auth/login (then the IdP) — show a spinner + lock the buttons
// so the click reads as "working". Hold the navigation (route hangs) so the login screen stays up and the
// spinner is observable.
test("#371: clicking sign-in shows a spinner and disables the button", async ({ page }) => {
  // Answer the top-level nav to /auth/login with 204 No Content — the browser keeps the current login document
  // (a 204 navigation is a no-op), so the spinner (committed from the click's setState, navigated from an effect)
  // stays observable instead of the page unloading.
  await page.route("**/auth/login**", (route) => route.fulfill({ status: 204, body: "" }));
  await page.goto("/login");
  const btn = page.getByTestId("login-signin");
  await expect(btn).toBeVisible();
  await expect(page.getByTestId("login-spinner")).toHaveCount(0); // no spinner before the click
  await btn.click();
  await expect(page.getByTestId("login-spinner")).toBeVisible(); // spinner appears (rendered before the nav)
  await expect(btn).toBeDisabled(); // the button locks so it can't be re-triggered
});

test("#261: /login?error=seat_full shows the seat-limit message (distinct from the vague one)", async ({ page }) => {
  await page.goto("/login?error=access");
  await sleep(150);
  const vague = (await page.getByTestId("login-error").textContent()) ?? "";
  await page.goto("/login?error=seat_full");
  await sleep(150);
  const seat = (await page.getByTestId("login-error").textContent()) ?? "";
  expect(seat.length).toBeGreaterThan(0);
  expect(seat).not.toBe(vague); // seat-full is a distinct, specific message
});
