import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #202: list-editing ergonomics, verified in a real browser (vim key routing + rendered glyphs can't
// be checked in happy-dom). Nested bullets show a per-level hierarchy glyph, and vim normal `o`/`O`
// continue the list marker (the bounced core — a CM keymap can't intercept vim normal keys, and an
// `A<CR>` remap left the new line unmarked; a Vim.defineAction does the continuation directly).
test("#202: nested bullets show hierarchy glyphs (•→◦→▪)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "list-glyphs");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("- top\n  - nested\n    - deep\nafter\n");
  await sleep(500);
  await page.getByText("after").click(); // caret off the list so markers render (not raw under cursor)
  await sleep(200);
  const glyphs = await page.locator("[data-pane=preview] .cm-lp-bullet").allTextContents();
  expect(glyphs).toContain("•"); // level 0
  expect(glyphs).toContain("◦"); // level 1
  expect(glyphs).toContain("▪"); // level 2
});

test("#202: vim normal o/O continue the list marker", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "list-vim-o");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("- alpha\n- beta\nplain\n");
  await sleep(500);
  await page.getByTestId("vim-toggle").click();
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");

  // o on a bullet line → new line below KEEPS the "- " marker.
  await page.keyboard.press("g"); await page.keyboard.press("g"); await sleep(80);
  await page.keyboard.press("o"); await page.keyboard.type("X"); await page.keyboard.press("Escape"); await sleep(150);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText(), "o did not continue the marker").toMatch(/- X|• X/);

  // O on a bullet line → new line ABOVE keeps the marker.
  await page.keyboard.press("g"); await page.keyboard.press("g"); await sleep(80);
  await page.keyboard.press("O"); await page.keyboard.type("Y"); await page.keyboard.press("Escape"); await sleep(150);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText(), "O did not continue the marker").toMatch(/- Y|• Y/);
});
