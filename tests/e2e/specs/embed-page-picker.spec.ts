import { test, expect } from "@playwright/test";
import { openScratch, createScratchPage, enterEdit, sleep } from "../helpers";

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
