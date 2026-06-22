import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// Phase 5a: the two-layer admin console framework + authz gates.
//  - Positive (dev-mode 5180, dev-user = tenant admin + space manager): the user
//    menu exposes Tenant admin; the admin console + space settings render and the
//    space General tab can rename/delete.
//  - Negative (real-mode 5181): a freshly-seated NON-admin member is denied — the
//    UI gate hides the entry and the leak rule applies (admin → 403; a space they
//    cannot even view → 404, hiding its existence). The server stays the fortress;
//    these assert the convenience layer behaves and never leaks.
const REAL_WEB = "http://dev.localhost:5181";

test("admin: user menu opens the tenant console; space settings rename + delete", async ({ page }) => {
  await openDemo(page);

  // User menu → Tenant admin → /admin/members (the re-homed Members screen).
  await page.getByTestId("user-menu").click();
  await expect(page.getByTestId("user-menu-admin")).toBeVisible();
  await page.getByTestId("user-menu-admin").click();
  await expect(page).toHaveURL(/\/admin\/members$/);
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  await expect(page.getByText("dev-user")).toBeVisible();

  // Back-compat: the old members URL redirects into the console.
  await page.goto("/settings/members");
  await expect(page).toHaveURL(/\/admin\/members$/);

  // A self-contained space to exercise General (avoids mutating the seed).
  await page.goto("/p/demo");
  await page.waitForSelector("[data-testid=space-switcher]");
  await page.getByTestId("space-switcher").click();
  await page.getByText("New space").click();
  await sleep(400);

  // Open its settings from the switcher menu and rename it on the General tab.
  await page.getByTestId("space-switcher").click();
  await page.getByTestId("space-settings-open").click();
  await expect(page).toHaveURL(/\/spaces\/.+\/settings\/general$/);
  await expect(page.getByTestId("space-general")).toBeVisible();
  await page.getByTestId("space-name-input").fill("Renamed E2E Space");
  await page.getByTestId("space-name-save").click();
  // The rail title is driven by the (refetched) space list — proves the rename stuck.
  await expect(page.getByText("Renamed E2E Space · Settings")).toBeVisible();

  // Delete from the danger zone → confirm → back in the app.
  await page.getByTestId("space-delete").click();
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

test("non-admin member is denied: admin → 403 (no menu entry); unviewable space settings → 404, then view→403", async ({ browser }) => {
  // Admin (dev-user) invites a member via the real-mode console.
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await admin.goto(`${REAL_WEB}/auth/login`);
  await admin.waitForURL((u) => !u.pathname.startsWith("/auth/"), { timeout: 15_000 });
  await admin.goto(`${REAL_WEB}/admin/members`);
  await expect(admin.getByRole("heading", { name: "Members" })).toBeVisible();
  const inviteEmail = `gate${Date.now()}@e2e.test`;
  await admin.getByLabel("invite email").fill(inviteEmail);
  await admin.getByRole("button", { name: "Send invite" }).click();
  const link = await admin.getByTestId("invite-link").textContent();
  expect(link).toMatch(/\/invite\?token=inv_/);

  // A fresh, non-member identity accepts → seated as a plain member (not admin,
  // not a manager of any space).
  const memberSub = `gate-${Date.now()}`;
  const memberCtx = await browser.newContext();
  await memberCtx.addCookies([{ name: "e2e_sub", value: memberSub, url: "http://127.0.0.1:4444" }]);
  const member = await memberCtx.newPage();
  await member.goto(link!);
  await member.getByRole("button", { name: "Accept invite" }).click();
  await member.waitForURL((u) => !u.pathname.startsWith("/auth/") && u.pathname !== "/invite", { timeout: 20_000 });

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
