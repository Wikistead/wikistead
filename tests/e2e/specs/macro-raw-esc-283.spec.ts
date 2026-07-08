import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

const vimInsert = (p: import("@playwright/test").Page) => p.evaluate(() => (window as any).__lpVimInsert as boolean);
const headLine = (p: import("@playwright/test").Page) => p.evaluate(() => (window as any).__lpHeadLine as number);

// #283: editing a mermaid's raw source in vim, ONE Esc used to render the block but leave vim stuck in
// INSERT mode — escExit swallowed the Esc so codemirror-vim never saw it (a second Esc was needed). Now one
// Esc exits raw AND returns vim to normal, and the caret lands on the atom's line (not a hidden body line).
// Real Chromium + vim.
test("#283: one Esc exits mermaid raw edit AND returns vim to normal (caret not trapped)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "macro-raw-esc");
  await enterEdit(page);
  await page.getByTestId("vim-toggle").click();
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```mermaid\ngraph TD\nA-->B\n```\nbot\n"); // paste-like (vim stays normal)
  await sleep(400);
  await page.getByText("bot").click(); // caret off the block → it renders as the atom
  await sleep(300);

  // caret onto the atom, Ctrl+Enter → reveal raw source (vim lands in NORMAL per ADR-024)
  await page.getByTestId("macro-mermaid").first().click();
  await sleep(150);
  await page.keyboard.press("Control+Enter");
  await sleep(250);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("```mermaid"); // raw shown

  // enter INSERT (no typing — keep the fence intact), confirm insert mode, then ONE Esc
  await page.keyboard.press("i");
  await sleep(120);
  expect(await vimInsert(page)).toBe(true); // we are in insert mode
  await page.keyboard.press("Escape");
  await sleep(300);

  // (a) the block re-rendered as the atom (raw source hidden)
  await expect(page.getByTestId("macro-mermaid").first()).toBeVisible();
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain("```mermaid");
  // (b) vim is back in NORMAL after a SINGLE Esc
  expect(await vimInsert(page), "one Esc returned vim to normal").toBe(false);
  // (c) the caret is on the atom's opening line, not a hidden body line
  const line = await headLine(page);
  expect(line).toBe(2); // "top" is line 1, the ```mermaid atom opens on line 2
});
