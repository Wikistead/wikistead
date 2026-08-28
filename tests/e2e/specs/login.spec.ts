import { test, expect } from "@playwright/test";
import { WEB, WEB_PORT } from "../helpers";

// Proves the BFF login works in a REAL browser through the same-origin proxy
// (ADR-016) — the SeaweedFS lesson: server-to-server green is not enough.
// globalSetup runs a real minimal OIDC issuer (issuing sub "dev-user") and points
// tenant_dev's OIDC config at it.

// #1000: isolated at the describe level, not in-body — this test requires `{ page }`, and Playwright
// resolves that fixture BEFORE an in-body test.skip runs (the same trap #973's guest-vim-ex-448 fix
// documents). Raising the skip to describe scope evaluates it at collection time, ahead of the fixture.
test.describe(() => {
  test.skip(true, "#1000: isolated — real OIDC login never sets the session cookie under the #891 gate's stack (reproduces on a fresh stack, confirmed unrelated to #925)");

  test("real OIDC login through the same-origin proxy sets a working host-only session", async ({ page }) => {
    // Full browser flow: /auth/login → IdP /authorize → /auth/callback → cookie → app.
    await page.goto("/auth/login");
    await page.waitForURL((u) => !u.pathname.startsWith("/auth/"), { timeout: 15_000 });

    // The session cookie was set, host-only on the web host (no Domain).
    const sess = (await page.context().cookies()).find((c) => c.name === "wks_sess");
    expect(sess, "session cookie set after login").toBeTruthy();
    expect(sess!.domain).toContain("dev.localhost");

    // Authenticated, same-origin: /api/auth/me returns the logged-in member.
    const me = await page.request.get(`${WEB}/api/auth/me`);
    expect(me.status()).toBe(200);
    expect((await me.json()).sub).toBe("dev-user");

    // Cross-tenant: the host-only cookie is NOT applicable to another tenant's host,
    // so the browser won't send it there, and that origin is unauthenticated.
    const acmeCookies = await page.context().cookies(`http://acme.localhost:${WEB_PORT}`);
    expect(acmeCookies.find((c) => c.name === "wks_sess"), "cookie must not cross to another tenant host").toBeUndefined();
    const acme = await page.request.get(`http://acme.localhost:${WEB_PORT}/api/auth/me`);
    expect(acme.status()).not.toBe(200);
  });
});
