import { test, expect } from "@playwright/test";
import { WEB_REAL_PORT } from "../helpers";

// Cloud self-serve signup in a REAL browser (P1.2 P2d) on the real-mode web (5181,
// no dev-token). Verifies the cross-subdomain seating the SeaweedFS lesson warns
// about: signup on the platform origin → create tenant → redirect to the new
// subdomain → platform-IdP SSO issues a HOST-ONLY member session THERE (not carried
// across origins). globalSetup runs the platform IdP (fixed-port issuer, sub dev-user).
test("signup → tenant → SSO seating with a host-only member session on the new subdomain", async ({ page }) => {
  const slug = `e2esignup${Date.now().toString(36)}`.replace(/[^a-z0-9]/g, "");
  const WEB = `http://dev.localhost:${WEB_REAL_PORT}`;

  // 1) platform signup (real-mode web): /join → platform IdP → /join/workspace
  await page.goto(`${WEB}/join`);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.waitForURL(/\/join\/workspace$/, { timeout: 15_000 });

  // 2) name the workspace → create the tenant → redirect to its subdomain
  await page.getByLabel("Workspace name").fill(slug);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL(new RegExp(`^https?://${slug}\\.localhost:${WEB_REAL_PORT}`), { timeout: 20_000 });

  // 3) the new subdomain has no session yet (real mode) → login screen → SSO seats us
  // #798: by test id, not by the button's words. The words are the thing that ticket changed, and
  // "Sign in" is now a SUBSTRING of two of them ("with single sign-on", "with email") — a name-based
  // locator would match both and fail strict mode on a tenant with a password door.
  await page.getByTestId("login-signin").click();
  await expect(page.getByTestId("login-signin")).toHaveCount(0, { timeout: 20_000 });

  // 4) seated: a host-only member session exists ON THE TENANT SUBDOMAIN
  const me = await page.request.get(`http://${slug}.localhost:${WEB_REAL_PORT}/api/auth/me`);
  expect(me.status()).toBe(200);
  expect((await me.json()).sub).toBe("dev-user"); // the signup creator (issuer subject)

  const sess = (await page.context().cookies(`http://${slug}.localhost:${WEB_REAL_PORT}`)).find((c) => c.name === "wks_sess");
  expect(sess, "member session cookie on the tenant subdomain").toBeTruthy();
  expect(sess!.domain).toContain(`${slug}.localhost`); // host-only — not shared across subdomains
});
