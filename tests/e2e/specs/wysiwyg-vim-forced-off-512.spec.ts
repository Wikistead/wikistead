import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #512 (user ruling): vim × WYSIWYG is a bug nest, so WYSIWYG FORCES vim off — the same forced-off seam
// as ADR-159(e)'s coarse-pointer case (the stored keymap preference is untouched; vim returns on leaving
// WYSIWYG). Real Chromium: the vim fat cursor is a separate render layer, so its ABSENCE is the signal.
const fatCursorCount = (page: import("@playwright/test").Page) =>
  page.locator("[data-pane=preview] .cm-fat-cursor").count();

async function vimOn(page: import("@playwright/test").Page) {
  await page.getByTestId("vim-toggle").click().catch(async () => {
    await page.locator("[data-testid=vim-toggle], [aria-label*=vim i]").first().click();
  });
  await sleep(200);
}

test("#512: turning vim on then entering WYSIWYG forces it off (no fat cursor; the toggle is disabled)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `wys-vim-off-${Date.now()}`);
  await enterEdit(page);
  await vimOn(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("i");
  await page.keyboard.insertText("hello world\nsecond line");
  await page.keyboard.press("Escape"); // normal mode → a fat cursor exists in Live
  await sleep(200);
  await expect.poll(() => fatCursorCount(page), { timeout: 4000 }).toBeGreaterThan(0);

  // Enter WYSIWYG → vim is forced off: the fat cursor vanishes and the toggle is disabled with a reason.
  await page.getByTestId("displaymode-wysiwyg").click();
  await sleep(400);
  await expect.poll(() => fatCursorCount(page), { timeout: 4000 }).toBe(0);
  await expect(page.getByTestId("vim-toggle"), "the vim toggle is disabled in WYSIWYG").toBeDisabled();

  // `i` in WYSIWYG is ordinary text input (no vim insert transition), proving vim is truly inert.
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("End");
  await page.keyboard.type("iZZ");
  await sleep(200);
  expect(await page.evaluate(() => document.querySelector("[data-pane=preview] .cm-content")?.textContent ?? ""),
    "an 'i' typed in WYSIWYG is literal text, not a vim insert command").toContain("iZZ");
});

test("#512: leaving WYSIWYG restores vim from the stored preference (unchanged)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `wys-vim-restore-${Date.now()}`);
  await enterEdit(page);
  await vimOn(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("i");
  await page.keyboard.insertText("alpha beta");
  await page.keyboard.press("Escape");
  await sleep(200);

  await page.getByTestId("displaymode-wysiwyg").click();
  await sleep(300);
  await expect.poll(() => fatCursorCount(page), { timeout: 4000 }).toBe(0); // forced off

  // Back to Live: vim returns (the stored pref was never rewritten) → the fat cursor reappears.
  await page.getByTestId("displaymode-live").click();
  await sleep(400);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await sleep(150);
  await expect.poll(() => fatCursorCount(page), { timeout: 4000 }).toBeGreaterThan(0);
  await expect(page.getByTestId("vim-toggle"), "the toggle is enabled again outside WYSIWYG").toBeEnabled();
});
