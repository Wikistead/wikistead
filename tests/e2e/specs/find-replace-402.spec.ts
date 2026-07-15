import { test, expect, type Page } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #402: in-page find & replace on the (non-vim) live-preview surface. Real Chromium: Mod-f opens the CM
// search panel, matches highlight (the virtualized doc defeats native browser find — this is the only
// path), replace edits the doc, and vim keeps its own `/` (the CM panel keymap lives in the non-vim
// Compartment branch, so Ctrl+F under vim does NOT open the panel).

const srcText = async (p: Page) => {
  await p.getByTestId("displaymode-source").click();
  await sleep(250);
  return p.locator("[data-pane=preview] .cm-content").innerText();
};

test("#402: Ctrl+F opens find/replace; matches highlight; replace rewrites the doc", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "findrep-a");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("alpha one\nalpha two\nbeta three\n");
  await sleep(300);
  await page.keyboard.press("Control+f");
  const panel = page.locator(".cm-panel.cm-search");
  await expect(panel).toBeVisible();
  // real keystrokes (fill sets the value without the keyup the panel listens for; Enter commits)
  await panel.locator("input[name=search]").pressSequentially("alpha");
  await panel.locator("input[name=search]").press("Enter");
  await sleep(300);
  expect(await page.locator(".cm-searchMatch").count()).toBeGreaterThanOrEqual(2);
  await panel.locator("input[name=replace]").fill("gamma");
  await panel.locator("button[name=replaceAll]").click();
  await sleep(300);
  await page.keyboard.press("Escape");
  const s = await srcText(page);
  expect(s).toContain("gamma one");
  expect(s).toContain("gamma two");
  expect(s).not.toContain("alpha");
});

test("#402: under vim, Ctrl+F does NOT open the CM panel (vim keeps its own / search)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "findrep-vim");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("delta line\n");
  await sleep(200);
  await page.keyboard.press("Control+Alt+v"); // vim ON (toolbar shortcut)
  await sleep(300);
  await page.keyboard.press("Escape"); // normal mode
  await page.keyboard.press("Control+f");
  await sleep(300);
  await expect(page.locator(".cm-panel.cm-search")).toHaveCount(0);
  // vim's own `/` search still works (its dialog panel appears)
  await page.keyboard.type("/delta");
  await sleep(200);
  await expect(page.locator(".cm-vim-panel, .cm-panel").first()).toBeVisible();
});

// #402 (review return): the CM search panel must speak the UI language — the phrases facet
// was never wired, so a Japanese UI still showed CM's built-in English ("next"/"replace all"/…).
test("#402 the search panel is localized (ja) and follows the language", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem("wks.lang", "ja"));
  await openScratch(page, "findrep-i18n");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("alpha one\n");
  await sleep(200);
  await page.keyboard.press("Control+f");
  const panel = page.locator(".cm-panel.cm-search");
  await expect(panel).toBeVisible();
  // the five buttons + a checkbox label are Japanese (phrase map applied)
  await expect(panel.locator("button[name=next]")).toHaveText("次へ");
  await expect(panel.locator("button[name=prev]")).toHaveText("前へ");
  await expect(panel.locator("button[name=replaceAll]")).toHaveText("すべて置換");
  await expect(panel).toContainText("大文字小文字を区別");
  // and the Find input placeholder is translated too
  await expect(panel.locator("input[name=search]")).toHaveAttribute("placeholder", "検索");
});
