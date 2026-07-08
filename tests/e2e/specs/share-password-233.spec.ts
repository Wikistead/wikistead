import { test, expect, type Page } from "@playwright/test";
import { openDemo, enterSplit, resetDoc, sleep } from "../helpers";

// #233 / ADR-107: a password-protected share link. A guest opening it gets a password prompt; a wrong
// password shows a generic error (wrong ≡ missing), the correct one unlocks the page. Real Chromium.
async function createPasswordLink(page: Page, password: string): Promise<string> {
  await page.waitForSelector("[data-testid=tree-page]", { timeout: 5000 });
  const row = page.locator("[data-testid=tree-page]", { hasText: "Demo Page" }).first();
  await row.hover();
  await row.locator("[data-testid=page-actions]").click();
  await page.locator("[data-testid=page-menu][data-state=open]").getByText("Share").click();
  await page.waitForSelector("[data-testid=share-dialog]");
  await page.locator("[data-testid=share-capability]:visible").click();
  await page.locator("[data-testid=share-capability-view]:visible").click();
  await page.locator("[data-testid=share-password]:visible").fill(password);
  const before = await page.$$eval('[data-testid=share-dialog] input[aria-label="Share URL"]', (e) => e.length);
  await page.click("[data-testid=create-link]");
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=share-dialog] input[aria-label="Share URL"]').length > n, before, { timeout: 5000 });
  const url = await page.evaluate(() => {
    const inp = document.querySelector("[data-testid=share-dialog] input[aria-label='Share URL']") as HTMLInputElement | null;
    return inp?.value ?? "";
  });
  await page.keyboard.press("Escape");
  return url;
}

test("#233: a password-protected link prompts, rejects a wrong password, unlocks with the right one", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  await enterSplit(member);
  await resetDoc(member);
  await member.locator("[data-pane=preview] .cm-content").click();
  await member.keyboard.insertText("# Secret doc\n");
  await sleep(400);
  await member.getByTestId("publish-page").click().catch(() => {}); // publish if the button is present
  await sleep(500);

  const url = await createPasswordLink(member, "hunter2");
  expect(url).toMatch(/\/share\/[0-9a-f-]{36}$/);

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(url);
  // The link is password-protected → the prompt appears (not the page).
  await expect(guest.getByTestId("share-password-form")).toBeVisible({ timeout: 10000 });

  // Wrong password → a generic error, still on the prompt.
  await guest.getByTestId("share-password-input").fill("wrong");
  await guest.getByTestId("share-password-submit").click();
  await expect(guest.getByTestId("share-password-error")).toBeVisible({ timeout: 8000 });

  // Correct password → the page unlocks (the read-only editor surface loads).
  await guest.getByTestId("share-password-input").fill("hunter2");
  await guest.getByTestId("share-password-submit").click();
  await expect(guest.locator("[data-pane=preview] .cm-content")).toBeVisible({ timeout: 10000 });
  await expect(guest.getByTestId("share-password-form")).toHaveCount(0);
});
