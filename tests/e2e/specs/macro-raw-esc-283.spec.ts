import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

const vimInsert = (p: import("@playwright/test").Page) => p.evaluate(() => (window as any).__lpVimInsert as boolean);
const headLine = (p: import("@playwright/test").Page) => p.evaluate(() => (window as any).__lpHeadLine as number);

// #283: editing a mermaid's raw source in vim, ONE Esc used to leave vim stuck in INSERT mode — escExit
// swallowed the Esc so codemirror-vim never saw it (a second Esc was needed).
// #243 (ADR-111 C1/C4): mermaid raw is now the CARET-IN reveal (a click / vim landing), so there is NO
// `active` render-edit session — escExit is not involved and vim receives the Esc natively. This guards that
// one Esc returns vim to NORMAL from the revealed mermaid source (the caret stays put, callout-style — you
// leave the reveal by moving the caret out). Real Chromium + vim.
test("#283: one Esc returns vim to normal while editing revealed mermaid source (not trapped in insert)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "macro-raw-esc");
  await enterEdit(page);
  await page.getByTestId("vim-toggle").click();
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```mermaid\ngraph TD\nA-->B\n```\nbot\n"); // paste-like (vim stays normal)
  await sleep(400);
  await page.getByText("bot").click(); // caret off the block → it renders as the atom
  await sleep(300);

  // #243 C1: a click lands the caret INSIDE the diagram → the raw source reveals (vim lands in NORMAL).
  await page.getByTestId("macro-mermaid").first().click();
  await sleep(250);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("```mermaid"); // raw shown

  // enter INSERT (no typing — keep the fence intact), confirm insert mode, then ONE Esc
  await page.keyboard.press("i");
  await sleep(120);
  expect(await vimInsert(page)).toBe(true); // we are in insert mode
  await page.keyboard.press("Escape");
  await sleep(300);

  // (a) vim is back in NORMAL after a SINGLE Esc (the #283 core — no swallowed Esc, no stuck insert)
  expect(await vimInsert(page), "one Esc returned vim to normal").toBe(false);
  // (b) the caret is on a real, landable line (not trapped mid-atom); it stays inside the revealed fence
  //     (callout-style — the diagram re-renders when the caret leaves, exercised elsewhere)
  const line = await headLine(page);
  expect(line).toBeGreaterThanOrEqual(2); // 1 top · 2-5 ```mermaid…``` · 6 bot
});
