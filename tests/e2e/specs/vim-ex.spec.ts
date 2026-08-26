import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// Light-3 / #911 (user ruling 2026-08-23, chat): vim ex commands as entry points to existing
// actions. From NORMAL-mode `:`, :q leaves edit mode WITHOUT publishing; :w publishes and STAYS
// in the editor (dirty clears, a toast confirms — the only ex command that does not return to
// view); :wq publishes AND leaves edit mode. Before #911, :w and :wq shared one publish call
// that always exited (publish == done) — :w now goes through publishStay, a distinct
// opts.stay-carrying call down the SAME single publish path (#448's stable reference, #813's
// liveness gate — both unchanged).
async function toNormalMode(page: import("@playwright/test").Page) {
  await page.getByTestId("vim-toggle").click();
  await sleep(300);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape"); // ensure NORMAL mode
}

test("vim :q leaves edit mode (back to the rendered view)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "vim-q");
  await enterEdit(page);
  // editing now → the Edit toggle is gone
  expect(await page.getByTestId("edit-toggle").count()).toBe(0);

  await toNormalMode(page);
  await page.keyboard.type(":q");
  await page.keyboard.press("Enter");

  // back in view mode → the Edit toggle reappears
  await expect(page.getByTestId("edit-toggle")).toBeVisible();
});

test("#911: vim :w publishes but STAYS in the editor (does not return to view)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "vim-w-stays");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("publish me via :w");
  await sleep(300);

  await toNormalMode(page);
  await page.keyboard.type(":w");
  await page.keyboard.press("Enter");

  // publish fired exactly once — the toast confirms it, not a return to view.
  await expect(page.getByText(/^Published$|^公開しました$/)).toBeVisible({ timeout: 10_000 });

  // still editing: the Edit toggle never reappears and the surface stays contenteditable.
  await sleep(500);
  expect(await page.getByTestId("edit-toggle").count()).toBe(0);
  await expect(page.locator("[data-pane=preview] .cm-content")).toHaveAttribute("contenteditable", "true");

  // collab/presence survived (not torn down and remounted): a further edit still lands live.
  // Still in vim NORMAL mode after :w — "A" appends at end-of-line AND enters INSERT mode.
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("A");
  await page.keyboard.type(" - still live");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-pane=preview] .cm-content")).toContainText("publish me via :w - still live");
});

test("#911: vim :wq publishes AND leaves edit mode (back to the rendered view)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "vim-wq");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("publish me via :wq");
  await sleep(300);

  await toNormalMode(page);
  await page.keyboard.type(":wq");
  await page.keyboard.press("Enter");

  // publish succeeded AND returned to the rendered view (Edit toggle reappears).
  await expect(page.getByTestId("edit-toggle")).toBeVisible({ timeout: 10_000 });
  // and the published content is shown in the read-only view
  await expect(page.locator("[data-pane=preview] .cm-content")).toContainText("publish me via :wq");
});
