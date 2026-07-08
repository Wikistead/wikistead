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
