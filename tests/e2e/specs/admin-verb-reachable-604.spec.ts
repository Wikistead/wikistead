import { test, expect } from "@playwright/test";
import { API, WEB_REAL_PORT } from "../helpers";

// #604-B: the carve-out has to be REACHABLE, and only a real browser can say so.
//
// The review found the gap the API tests could not: `manage_connections` answered 200 on every
// connections route, and the person holding it still had no way in — the console entry was `isAdmin`
// and the sign-in screen read a tier-gated endpoint. So this walks it as the person: sign in with a
// password as a member who is NOT an admin, and check the door exists, opens, and opens onto exactly
// one tab.
const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };
const REAL = `http://dev.localhost:${WEB_REAL_PORT}`;
const STAMP = Date.now().toString(36);
const EMAIL = `verb604-${STAMP}@e2e.test`;
const PASSWORD = "an-e2e-passphrase-long-enough";

const setLocalLogin = (on: boolean) =>
  fetch(`${API}/admin/login-methods`, { method: "PATCH", headers: H, body: JSON.stringify({ localLoginEnabled: on }) });

test("#604-B: a connection manager finds the console, and sees only their tab", async ({ page }) => {
  const on = await setLocalLogin(true);
  expect(on.status, await on.text()).toBe(204);
  let roleId = "";
  let sub = "";
  try {
    // A member who signs in with a password — an ordinary member, no tier.
    const created = await fetch(`${API}/members/invites`, {
      method: "POST", headers: H, body: JSON.stringify({ email: EMAIL, role: "member", kind: "local" }),
    });
    const inviteBody = await created.text();
    expect(created.status, inviteBody).toBe(201);
    const token = new URL((JSON.parse(inviteBody) as { inviteUrl: string }).inviteUrl).searchParams.get("token")!;

    await page.goto(`${REAL}/invite?token=${encodeURIComponent(token)}`);
    await expect(page.getByTestId("set-password")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("set-password-input").fill(PASSWORD);
    await page.getByTestId("set-password-confirm").fill(PASSWORD);
    await page.getByTestId("set-password-submit").click();
    await page.waitForURL((u) => !u.pathname.startsWith("/invite"), { timeout: 15_000 });

    // Who they are, as the server knows them (the sub is what a role is assigned to).
    const me = await page.evaluate(async () => (await fetch("/api/auth/me", { credentials: "include" })).json());
    sub = (me as { sub: string }).sub;
    expect(sub, "the invited member has a sub").toBeTruthy();
    expect((me as { isAdmin?: boolean }).isAdmin ?? false, "and is NOT an admin — that is the whole point").toBe(false);

    // #289's first-run dialog greets a brand-new member and covers the header. Mark it seen through
    // the account API (as them, with their cookie) rather than racing the dialog open — it is not
    // what this spec measures, and a click that lands before it renders would flake.
    const marked = await page.evaluate(async () =>
      (await fetch("/api/me/settings", {
        method: "PATCH", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ onboardingCompleted: true }),
      })).status,
    );
    expect(marked, "the first-run dialog is marked seen").toBeLessThan(300);

    // Before the role: no console entry at all (this is the non-regression side of the change —
    // an ordinary member must not gain a door).
    await page.goto(`${REAL}/`);
    await page.getByTestId("user-menu").click();
    await expect(page.getByTestId("user-menu-admin"), "a plain member is offered nothing").toHaveCount(0);
    await page.keyboard.press("Escape");

    // Give them ONE tenant verb, the way an admin would: a tenant role carrying manageConnections.
    const role = await fetch(`${API}/admin/roles`, {
      method: "POST", headers: H,
      body: JSON.stringify({ name: `verb604-${STAMP}`, capabilities: ["manageConnections"], scope: "tenant" }),
    });
    const roleBody = await role.text();
    expect(role.status, roleBody).toBe(201);
    roleId = (JSON.parse(roleBody) as { id: string }).id;
    const assign = await fetch(`${API}/admin/roles/${roleId}/assignments`, {
      method: "POST", headers: H,
      body: JSON.stringify({ resourceType: "tenant", resourceId: "tenant_dev", principal: `user:${sub}` }),
    });
    expect(assign.status, await assign.text()).toBe(201);

    // Now the door exists. (Reload rather than poll: the surfaces answer is cached per session.)
    await page.goto(`${REAL}/`);
    await page.getByTestId("user-menu").click();
    await expect(page.getByTestId("user-menu-admin"), "the verb led somewhere").toBeVisible({ timeout: 10_000 });
    await page.getByTestId("user-menu-admin").click();

    // …and it opens onto the sign-in methods screen, drawn, not 403-blank.
    await page.waitForURL((u) => u.pathname.startsWith("/admin"), { timeout: 15_000 });
    await expect(page.getByTestId("admin-auth"), "the tab their verb opens is the one they land on").toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("sign-in-methods"), "and it drew — the read is no longer tier-gated").toBeVisible();

    // Exactly one tab: the console must not show them doors that would refuse.
    const tabs = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-testid^='settings-tab-']")).map((el) => el.getAttribute("data-testid")!),
    );
    expect(tabs.length, `only the surface their verb opens (saw ${tabs.join(", ")})`).toBe(1);

    // A direct link to a surface they do NOT hold refuses, rather than rendering an empty screen.
    await page.goto(`${REAL}/admin/roles`);
    await expect(page.getByTestId("settings-forbidden"), "a pasted link to somebody else's tab is refused").toBeVisible({ timeout: 10_000 });

    // The stance is not theirs to write: the switch is there (so the state is legible) and inert.
    await page.goto(`${REAL}/admin/auth`);
    await expect(page.getByTestId("sign-in-methods")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("sso-required-toggle"), "the stance switch belongs to the tier").toBeDisabled();
    await expect(page.getByTestId("sso-exemptions"), "and its exemptions are not offered at all").toHaveCount(0);
  } finally {
    if (roleId) {
      await fetch(`${API}/admin/roles/${roleId}/assignments`, {
        method: "DELETE", headers: H,
        body: JSON.stringify({ resourceType: "tenant", resourceId: "tenant_dev", principal: `user:${sub}` }),
      }).catch(() => {});
      await fetch(`${API}/admin/roles/${roleId}`, { method: "DELETE", headers: H }).catch(() => {});
    }
    await setLocalLogin(false).catch(() => {});
  }
});
