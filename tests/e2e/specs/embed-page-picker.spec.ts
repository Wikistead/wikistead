import { test, expect } from "@playwright/test";
import { openScratch, createScratchPage, enterEdit, sleep } from "../helpers";

const vimInsert = (p: import("@playwright/test").Page) => p.evaluate(() => (window as unknown as { __lpVimInsert?: boolean }).__lpVimInsert === true);
const headLine = (p: import("@playwright/test").Page) => p.evaluate(() => (window as unknown as { __lpHeadLine?: number }).__lpHeadLine ?? -1);

// #205 part 2 / ADR-071: the `:::embed-page` title-search picker. The slash command "Embed a page"
// opens a picker whose candidates are FGA-view-filtered (GET /search); selecting one inserts
// `:::embed-page\n<id>\n:::`. Here we exercise the deterministic raw-id path (typing a page id
// directly, the fallback that doesn't depend on Meilisearch indexing timing) → insert → the
// embed-page macro widget renders in place of the raw block.
test("slash 'embed a page' → picker → pick a page id → inserts :::embed-page and renders the widget", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const targetId = await createScratchPage(page, "Embed Target Page");

  await openScratch(page, "embed-host");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");

  // Open the slash palette and choose "Embed a page".
  await page.keyboard.type("/embed");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-macro:embed-page"]');

  // The picker dialog opens; type the target page id → the raw-id escape hatch appears.
  await expect(page.getByTestId("embed-picker-input")).toBeVisible();
  await page.getByTestId("embed-picker-input").fill(targetId);
  await expect(page.getByTestId("embed-picker-raw")).toBeVisible();
  await page.getByTestId("embed-picker-raw").click();

  // The picker closed and the embed-page block was inserted → its host-mediated widget renders.
  await expect(page.getByTestId("embed-picker-input")).toHaveCount(0);
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-embed-page]")).toBeVisible();
});

// #332 (review reject): in vim, the `/embed` picker (run from the INSERT-mode slash palette)
// used to leave the caret STRANDED on a blank line below the card in INSERT mode. A picker-completed
// embed-page is `atomSelectable` (transclude.ts), so after the pick vim drops to NORMAL and the caret
// rests ON the atom: the card renders (never raw) and the caret sits on the block (blank-fatcursor). Raw
// editing is still reachable by Ctrl+Enter (the id is edited via ⇆ / explicit entry, not caret-in). Real
// Chromium + vim (the reveal boundary + vim-mode transition are synthetic-DOM-invisible).
test("#332: vim /embed picker leaves NORMAL mode with the caret on the rendered atom (not insert on a blank line)", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const targetId = await createScratchPage(page, "Embed Target 332");

  await openScratch(page, "embed-host-332");
  await enterEdit(page);
  await page.getByTestId("vim-toggle").click();
  await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("i"); // INSERT mode — the slash palette is an insert-mode trigger
  await page.keyboard.type("/embed");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-macro:embed-page"]');
  await expect(page.getByTestId("embed-picker-input")).toBeVisible();
  await page.getByTestId("embed-picker-input").fill(targetId);
  await page.getByTestId("embed-picker-raw").click();
  await expect(page.getByTestId("embed-picker-input")).toHaveCount(0);
  await sleep(300);

  // The card renders — the block never reveals raw (atomSelectable: an empty caret selects, not reveals).
  await expect(page.locator("[data-pane=preview] [data-testid=macro-embed-page]")).toBeVisible();
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain(":::embed-page");
  // vim is back in NORMAL (not stranded in insert) and the caret rests ON the rendered block atom — its
  // line falls within a live-preview block range (the widget), NOT a blank line below the card.
  expect(await vimInsert(page), "vim dropped back to normal after the pick").toBe(false);
  const onAtom = await page.evaluate(() => {
    const w = window as unknown as { __lpHeadLine?: number; __lpBlocks?: { fromLine: number; toLine: number }[] };
    const h = w.__lpHeadLine ?? -1;
    return { h, onBlock: (w.__lpBlocks ?? []).some((b) => b.fromLine <= h && h <= b.toLine) };
  });
  expect(onAtom.h, "the caret is on the atom's opening line, not a blank line below").toBe(1);
  expect(onAtom.onBlock, "the caret's line is inside a rendered macro block (the card), not a bare line").toBe(true);

  // Non-regression: the id is still editable — Ctrl+Enter (explicit entry) reveals the raw block. (Focus
  // returns to the editor after the picker closes — the deferred view.focus() — so the keystroke lands.)
  await page.keyboard.press("Control+Enter");
  await sleep(200);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain(":::embed-page");
});

// #344: the picker dialog is TOP-PINNED, so its top input never shifts vertically as the candidate list
// grows/shrinks (the "input jumps while typing" bug on center-aligned dialogs with variable content).
test("#344: the picker input stays put vertically as the candidate list changes", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const targetId = await createScratchPage(page, "Embed Target 344");

  await openScratch(page, "embed-host-344");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("/embed");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-macro:embed-page"]');

  const input = page.getByTestId("embed-picker-input");
  await expect(input).toBeVisible();
  const vh = page.viewportSize()!.height;
  // Top-pinned: the dialog sits near the top (top-[10%]), so the input is well within the upper third —
  // a center-aligned dialog would put it near the middle.
  const y0 = (await input.boundingBox())!.y;
  expect(y0, "the input is top-pinned, not vertically centered").toBeLessThan(vh * 0.35);

  // Grow the candidate list (the raw-id item appears; the empty state disappears) → the input must NOT move.
  await input.fill(targetId);
  await expect(page.getByTestId("embed-picker-raw")).toBeVisible();
  await sleep(150);
  const y1 = (await input.boundingBox())!.y;
  // Top-pinned → the input barely moves (a couple sub-pixels of reflow); a center-aligned dialog would
  // shift it by ~half the list-height delta. The top-third assertion above is the primary top-pin proof.
  expect(Math.abs(y1 - y0), "the input does not shift when the list changes size").toBeLessThan(5);
});
