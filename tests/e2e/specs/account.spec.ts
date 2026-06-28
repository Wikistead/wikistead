import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// ADR-020 / Design-6: the personal account settings page (Profile / Editor / Theme).
// Self-scope server-side; this checks the UI wiring (save persists, keymap syncs, theme
// switches, avatar uploads). Cleans up the shared dev-user row at the end.
const API = "http://dev.localhost:4010";
const settings = (p: Page) =>
  p.evaluate(async (api) => {
    const r = await fetch(`${api}/me/settings`, { headers: { Authorization: "Bearer dev-token" } });
    return r.json() as Promise<{ displayName: string | null; displayNameOverride: string | null; editorKeymap: string; hasAvatar: boolean }>;
  }, API);
const reset = (p: Page) =>
  p.evaluate(async (api) => {
    await fetch(`${api}/me/settings`, { method: "PATCH", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" }, body: JSON.stringify({ displayNameOverride: null, editorKeymap: "default" }) });
    await fetch(`${api}/me/avatar`, { method: "DELETE", headers: { Authorization: "Bearer dev-token" } });
  }, API);

test.afterEach(async ({ page }) => { await reset(page); });

test("account settings: name override persists + resets; keymap syncs; theme switches; avatar upload", async ({ page }) => {
  await openDemo(page);

  // open via the header user menu
  await page.click("[data-testid=user-menu]");
  await page.click("[data-testid=user-menu-account]");
  await expect(page.getByTestId("account-profile")).toBeVisible();

  // Profile: set a display-name override → it persists server-side
  await page.fill("[data-testid=account-name-input]", "E2E Name");
  await page.click("[data-testid=account-name-save]");
  await expect.poll(() => settings(page).then((s) => s.displayNameOverride), { timeout: 5000 }).toBe("E2E Name");
  // reset → back to the IdP name (override cleared)
  await page.click("[data-testid=account-name-reset]");
  await expect.poll(() => settings(page).then((s) => s.displayNameOverride), { timeout: 5000 }).toBeNull();

  // Editor: switching the keymap is persisted (server-synced)
  await page.click("[data-testid=settings-tab-editor]");
  await page.click("[data-testid=account-keymap-vim]");
  await expect.poll(() => settings(page).then((s) => s.editorKeymap), { timeout: 5000 }).toBe("vim");
  // ADR-056 / #164-3: the display-mode startup pref is persisted too (server-synced).
  await page.click("[data-testid=account-displaymode-source]");
  await expect.poll(() => settings(page).then((s) => s.editorDisplayMode), { timeout: 5000 }).toBe("source");

  // Theme: reuses the existing control → reflected on <html data-theme>
  await page.click("[data-testid=settings-tab-theme]");
  await page.click("[data-testid=account-theme-dark]");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.click("[data-testid=account-theme-system]");

  // Avatar: a PNG upload registers server-side
  await page.click("[data-testid=settings-tab-profile]");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 9)]);
  await page.setInputFiles("[data-testid=account-avatar-input]", { name: "a.png", mimeType: "image/png", buffer: png });
  await expect.poll(() => settings(page).then((s) => s.hasAvatar), { timeout: 5000 }).toBe(true);
  await sleep(100);
});
