import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// ADR-021: rebind a shortcut from Account → Editor (capture via event.code), it persists
// server-side and the new chord drives the command. dev-user keybindings reset after.
const API = "http://dev.localhost:4010";
const kb = (p: Page) =>
  p.evaluate(async (api) => {
    const r = await fetch(`${api}/me/settings`, { headers: { Authorization: "Bearer dev-token" } });
    return ((await r.json()) as { keybindings: Record<string, string> }).keybindings;
  }, API);

test.afterEach(async ({ page }) => {
  await page.evaluate(async (api) => {
    await fetch(`${api}/me/settings`, { method: "PATCH", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" }, body: JSON.stringify({ keybindings: {} }) });
  }, API);
});

test("rebind editor.toggleVim via the capture UI; persists; the new chord toggles vim", async ({ page }) => {
  const pageId = await openScratch(page, "kb");

  // Account → Editor → Keyboard shortcuts
  await page.click("[data-testid=user-menu]");
  await page.click("[data-testid=user-menu-account]");
  await page.click("[data-testid=settings-tab-editor]");
  await expect(page.getByTestId("kb-row-editor.toggleVim")).toBeVisible();

  // capture a new chord (event.code based) → saved + persisted
  await page.getByTestId("kb-change-editor.toggleVim").click();
  await expect(page.getByTestId("kb-capturing")).toBeVisible();
  await page.keyboard.press("Control+Alt+B");
  await expect.poll(() => kb(page).then((k) => k["editor.toggleVim"]), { timeout: 5000 }).toBe("Ctrl-Alt-b");
  await expect(page.getByTestId("kb-current-editor.toggleVim")).toBeVisible(); // back to showing the key

  // the new chord drives the command in the editor
  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  const toggle = page.getByTestId("vim-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Control+Alt+B");
  await sleep(80);
  await expect(toggle).toHaveAttribute("aria-pressed", "true"); // rebound chord works
});
