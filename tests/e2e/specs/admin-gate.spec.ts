import { test, expect } from "@playwright/test";
import { openDemo, sleep, WEB_REAL_PORT } from "../helpers";

// Phase 5a: the two-layer admin console framework + authz gates.
//  - Positive (dev-mode 5180, dev-user = tenant admin + space manager): the user
//    menu exposes Tenant admin; the admin console + space settings render and the
//    space General tab can rename/delete.
//  - Negative (real-mode 5181): a freshly-seated NON-admin member is denied — the
//    UI gate hides the entry and the leak rule applies (admin → 403; a space they
//    cannot even view → 404, hiding its existence). The server stays the fortress;
//    these assert the convenience layer behaves and never leaks.
const REAL_WEB = `http://dev.localhost:${WEB_REAL_PORT}`;

test("admin: user menu opens the tenant console; space settings rename + delete", async ({ page }) => {
  await openDemo(page);

  // User menu → Tenant admin → /admin/members (the re-homed Members screen).
  await page.getByTestId("user-menu").click();
  await expect(page.getByTestId("user-menu-admin")).toBeVisible();
  await page.getByTestId("user-menu-admin").click();
  await expect(page).toHaveURL(/\/admin\/members$/);
  // #579 gave this page a SECOND heading ("Members and groups"), and an un-anchored name matches by
  // substring — so this resolved to two elements and the console's own landing pin went red. Anchored,
  // because the thing being asserted is "the console rendered", not "some heading starts with Members".
  await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
  await expect(page.getByText("dev-user")).toBeVisible();

  // Back-compat: the old members URL redirects into the console.
  await page.goto("/settings/members");
  await expect(page).toHaveURL(/\/admin\/members$/);

  // A self-contained space to exercise General (avoids mutating the seed).
  await page.goto("/p/demo");
  await page.waitForSelector("[data-testid=space-switcher]");
  await page.getByTestId("space-switcher").click();
  await page.locator("[data-testid=space-menu]").getByText("New space").click();
  const createDlg = page.locator("[data-testid=rename-dialog][data-state=open]");
  await createDlg.waitFor();
  await createDlg.locator("input").fill("Settings E2E Space");
  await createDlg.locator("button[type=submit]").click();
  await sleep(400);

  // Open its settings from the gear button (now in the sidebar header) and rename it.
  await page.getByTestId("space-settings-open").click();
  await expect(page).toHaveURL(/\/spaces\/.+\/settings\/general$/);
  await expect(page.getByTestId("space-general")).toBeVisible();
  await page.getByTestId("space-name-input").fill("Renamed E2E Space");
  await page.getByTestId("space-name-save").click();
  // The rail title is driven by the (refetched) space list — proves the rename stuck.
  await expect(page.getByText("Renamed E2E Space · Settings")).toBeVisible();

  // Delete from the danger zone → type-to-confirm (#504: delete-forever parity) → back in the app.
  await page.getByTestId("space-delete").click();
  await page.getByTestId("typed-confirm-input").fill("Renamed E2E Space");
  await page.getByTestId("space-delete-confirm").click();
  await expect(page).toHaveURL(/\/p\//);
});

test("space Members tab renders and the member typeahead finds a seeded member", async ({ page }) => {
  await openDemo(page);
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-members")).toBeVisible();
  // Typeahead is manage-gated server-side and returns the minimal {sub,displayName}.
  await page.getByTestId("space-grant-input").fill("dev");
  await expect(page.getByTestId("space-grant-candidate").first()).toContainText("dev-user");
});

test("space Pages overview lists the space's pages", async ({ page }) => {
  await openDemo(page);
  await page.goto("/spaces/demo_space/settings/pages");
  await expect(page.getByTestId("space-pages")).toBeVisible();
  await expect(page.locator("[data-testid=space-page-row]").first()).toBeVisible();
});

test("admin Billing tab renders (self-hosted state when Stripe is not configured)", async ({ page }) => {
  await openDemo(page);
  await page.goto("/admin/billing");
  await expect(page.getByTestId("admin-billing")).toBeVisible();
  // The e2e stack has no STRIPE_SECRET_KEY → billing disabled → self-hosted notice.
  await expect(page.getByTestId("billing-selfhosted")).toBeVisible();
});

test("admin API tab: create a key shows the plaintext once, then revoke", async ({ page }) => {
  await openDemo(page);
  await page.goto("/admin/api");
  await expect(page.getByTestId("admin-api")).toBeVisible();

  await page.getByTestId("api-key-name").fill("e2e key");
  await page.getByTestId("api-key-create").click();
  // Plaintext shown once + the key appears in the list.
  await expect(page.getByTestId("api-key-plaintext")).toContainText("wks_");
  const row = page.locator("[data-testid=api-key-item]", { hasText: "e2e key" });
  await expect(row).toBeVisible();

  await row.getByTestId("api-key-revoke").click();
  await page.getByTestId("api-key-revoke-confirm").click(); // #504: revoke confirms first
  await expect(page.locator("[data-testid=api-key-item]", { hasText: "e2e key" })).toHaveCount(0);
});

test("admin Auth tab edits a sign-in method in its row, and Test reports a bad issuer", async ({ page }) => {
  // #589 re-aimed: the editor used to be a form of its own below the list, which always wrote the
  // FIRST connection. It is the row's own editor now, so the walk is: open the row, edit there.
  await openDemo(page);
  await page.goto("/admin/auth");
  await expect(page.getByTestId("admin-auth")).toBeVisible();
  await expect(page.getByTestId("sign-in-warning")).toBeVisible();
  await expect(page.getByTestId("sign-in-methods-list")).toBeVisible();

  const row = page.locator("[data-testid^=admin-connection-]").filter({ has: page.locator("[data-testid^=admin-connection-edit-]") }).first();
  await expect(row, "the seeded tenant has a connection to edit").toBeVisible();
  await row.locator("[data-testid^=admin-connection-edit-]").click();

  // Test connection against an unreachable issuer → a failure is reported (not enabled).
  await page.getByTestId("oidc-issuer").fill("http://127.0.0.1:1/");
  await page.getByTestId("oidc-test").click();
  await expect(page.getByTestId("oidc-test-result")).toBeVisible();
});

test("admin Spaces tab lists tenant spaces with counts and links to settings", async ({ page }) => {
  await openDemo(page);
  await page.goto("/admin/spaces");
  await expect(page.getByTestId("admin-spaces")).toBeVisible();
  const row = page.locator("[data-testid=admin-space-row]", { hasText: "Demo Space" });
  await expect(row).toBeVisible();
  await row.getByTestId("admin-space-settings").click();
  await expect(page).toHaveURL(/\/spaces\/demo_space\/settings/);
});

test("non-admin member is denied: admin → 403 (no menu entry); unviewable space settings → 404, then view→403", async ({ browser }) => {
  // Admin (dev-user) invites a member via the real-mode console.
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await admin.goto(`${REAL_WEB}/auth/login`);
  await admin.waitForURL((u) => !u.pathname.startsWith("/auth/"), { timeout: 15_000 });
  // #608: a REJECTED sign-in also leaves /auth/ — the callback bounces to /login?error=access, which
  // satisfied the wait above and let the failure surface three asserts later as "the console did not
  // render". Say what actually happened at the door instead.
  expect(admin.url(), "the sign-in was accepted (an error redirect is a rejection, not a landing)").not.toMatch(/[?&]error=/);
  await admin.goto(`${REAL_WEB}/admin/members`);
  await expect(admin.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
  // #436: the real-mode profile has no persisted chrome prefs, so the onboarding BANNER (#339 class)
  // floats over the bottom of the page — exactly where the invite form lives — and swallows the click.
  // It renders AFTER settings load, so WAIT for it (bounded) rather than a one-shot visibility probe.
  await admin.getByTestId("onboarding-banner-dismiss").click({ timeout: 5000 }).catch(() => {});
  await expect(admin.getByTestId("onboarding-banner")).toBeHidden();
  const inviteEmail = `gate${Date.now()}@e2e.test`;
  await admin.getByLabel("invite email").fill(inviteEmail);
  await admin.getByRole("button", { name: "Send invite" }).click();
  // #638: the link arrives in a modal now (it is shown once and the two links on this screen are made
  // from different places), so it is read from the value inside the box and the modal is dismissed —
  // the overlay covers the console behind it, which is the point.
  const link = await admin.getByTestId("invite-link-value").textContent();
  expect(link).toMatch(/\/invite\?token=inv_/);
  await admin.getByTestId("secret-dialog-done").click();

  // A fresh, non-member identity accepts → seated as a plain member (not admin,
  // not a manager of any space).
  const memberSub = `gate-${Date.now()}`;
  const memberCtx = await browser.newContext();
  await memberCtx.addCookies([{ name: "e2e_sub", value: memberSub, url: "http://127.0.0.1:4444" }]);
  const member = await memberCtx.newPage();
  await member.goto(link!);
  await member.getByRole("button", { name: "Accept invite" }).click();
  await member.waitForURL((u) => !u.pathname.startsWith("/auth/") && u.pathname !== "/invite", { timeout: 20_000 });

  // #436: a BRAND-NEW member gets the editor-onboarding dialog (#347) on first load, and its overlay
  // swallows every click below. Dismissing it from the UI is a race this spec kept losing — the dialog
  // mounts after the page settles, so a wait-then-Escape checked an empty page, passed, and the overlay
  // arrived afterwards to block a click two hundred lines later ("dialog-overlay intercepts pointer
  // events"). Turn it off at the source instead: mark onboarding complete for this member through their
  // OWN settings, then load the page that has no dialog to dismiss.
  await member.evaluate(async () => {
    await fetch("/api/me/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ onboardingCompleted: true }),
    });
  });
  await member.reload();
  await expect(member.locator("[data-slot=dialog-overlay]"), "no dialog stands between us and the page").toHaveCount(0, { timeout: 10_000 })
  await expect(member.getByTestId("onboarding-dialog")).toBeHidden();

  // Admin console: isAdmin false → 403 banner, and the user menu has no entry.
  await member.goto(`${REAL_WEB}/admin/members`);
  await expect(member.getByTestId("settings-forbidden")).toBeVisible();
  await member.getByTestId("user-menu").click();
  await expect(member.getByTestId("user-menu-admin")).toHaveCount(0);

  // A space the member cannot even view → 404 (existence hidden), not 403.
  await member.goto(`${REAL_WEB}/spaces/demo_space/settings/general`);
  await expect(member.getByTestId("settings-notfound")).toBeVisible();

  // Now the admin grants the member space VIEW (5b API). The member can now see the
  // space, so its settings flip from 404 (hidden) to 403 (known but not manage) —
  // the leak-rule branch deferred from 5a, proven here.
  const granted = await admin.request.post(`${REAL_WEB}/api/spaces/demo_space/access`, {
    data: { grantee: `user:${memberSub}`, relation: "view" },
  });
  expect(granted.status()).toBe(204);
  await member.goto(`${REAL_WEB}/spaces/demo_space/settings/general`);
  await expect(member.getByTestId("settings-forbidden")).toBeVisible();

  // Clean up the grant (FGA persists across runs).
  await admin.request.delete(`${REAL_WEB}/api/spaces/demo_space/access`, {
    data: { grantee: `user:${memberSub}`, relation: "view" },
  });

  await adminCtx.close();
  await memberCtx.close();
});
