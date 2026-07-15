import { test, expect } from "@playwright/test";

// #427: the dev-token bypass must never MASK a real session. Real browser, dev-token web (5180):
//  - no cookie → god-mode (dev-user) with a visible DEV badge;
//  - after a real OIDC login (cookie) → the real session owns the identity and the badge is gone.
test("#427: god-mode shows a DEV badge; a real OIDC login takes over and hides it", async ({ page }) => {
  // Fresh context, no cookie: the dev-token identity renders with the badge.
  await page.goto("/");
  await expect(page.getByTestId("user-avatar")).toBeVisible();
  await expect(page.getByTestId("dev-mode-badge")).toBeVisible();

  // Real login through the same-origin proxy (the globalSetup issuer, sub dev-user).
  await page.goto("/auth/login");
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/"), { timeout: 15_000 });
  const sess = (await page.context().cookies()).find((c) => c.name === "wks_sess");
  expect(sess, "session cookie set after login").toBeTruthy();

  // The provider probes /auth/me on load — with the cookie present the REAL session wins:
  // still authed, but no longer god-mode → the DEV badge is gone.
  await page.goto("/");
  await expect(page.getByTestId("user-avatar")).toBeVisible();
  await expect(page.getByTestId("dev-mode-badge")).toBeHidden();
});
