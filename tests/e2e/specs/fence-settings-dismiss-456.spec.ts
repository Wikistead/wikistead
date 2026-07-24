import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #456 (user, 2026-07-27), two follow-ups on the code-fence settings panel:
//  1. the keyboard route was undiscoverable — every other macro opens with Ctrl+↵ but a fence needs
//     Ctrl+Alt+↵, and nothing said so. The header button now names the shortcut.
//  2. the panel only closed via ✕ / Escape / re-toggle. It dismisses on an outside click now, like
//     every other popover — without a click INSIDE it (or on its controls) closing it by accident.
async function seedFence(page: Page) {
  await openScratch(page, `fence456d-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("```ts\nconst a = 1\n```\n\nbelow\n");
  await sleep(600);
}
const openViaMenu = async (page: Page) => {
  await page.getByText("const a = 1", { exact: true }).click({ button: "right" });
  await expect(page.getByTestId("ctx-item-codesettings")).toBeVisible({ timeout: 8000 });
  await page.getByTestId("ctx-item-codesettings").click();
  await expect(page.getByTestId("fence-settings-panel")).toBeVisible({ timeout: 8000 });
};

test("#456: the settings button names its keyboard shortcut", async ({ page }) => {
  await seedFence(page);
  const btn = page.locator(".cm-lp-code-settings-btn").first();
  await expect(btn).toBeVisible();
  const label = `${await btn.getAttribute("aria-label")} ${await btn.getAttribute("title")}`;
  expect(label, "a user who never guesses Ctrl+Alt+↵ can read it here").toContain("Alt");
  expect(label).toMatch(/↵|Enter/);
});

test("#456: an outside click dismisses the panel; a click inside it does not", async ({ page }) => {
  await seedFence(page);
  await openViaMenu(page);

  // a click on the panel's own control must NOT dismiss it (its writes are document changes)
  await page.getByTestId("macro-setting-title").click();
  await sleep(300);
  await expect(page.getByTestId("fence-settings-panel"), "clicking inside is not a dismissal").toBeVisible();

  // …a click outside does
  await page.getByText("below", { exact: true }).click();
  await expect(page.getByTestId("fence-settings-panel"), "an outside click closes it, like any popover").toHaveCount(0, { timeout: 5000 });

  // and the other ways out still work
  await openViaMenu(page);
  await page.getByTestId("fence-settings-close").click();
  await expect(page.getByTestId("fence-settings-panel")).toHaveCount(0, { timeout: 5000 });
});
