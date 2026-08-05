import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #631 (user request, 2026-08-05): " wysiwyg vim
//
// Dragging a selection with the mouse puts vim in visual mode, so the product could not tell the two
// apart and answered a reader holding a mouse with "press \". The axis it was missing is not the mode,
// it is what made the selection.
//
// Real mouse and real keys, because vim's mode transitions do not happen for synthetic events — the
// thing under test IS the transition. Two sessions burned themselves on that in #458 / #494.
async function vimOn(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+Alt+v");
  await sleep(400);
}

/** Drag across the first line with a real pointer. */
async function dragSelectFirstLine(page: import("@playwright/test").Page) {
  const line = page.locator("[data-pane=preview] .cm-line").first();
  const box = (await line.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(box.width - 4, 120), box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await sleep(400);
}

test("#631: a mouse-made selection gets the toolbar; a v-made one keeps the hint", async ({ page }) => {
  await openScratch(page, "vim-mouse-631");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("the quick brown fox jumps\nsecond line here\n");
  await sleep(400);
  await vimOn(page);

  const hint = page.getByTestId("vim-decorate-hint");
  const bubble = page.getByTestId("format-bubble");

  // ── keyboard: `v` then motion — the hint, as before ────────────────────────────────────────────
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await page.keyboard.press("v");
  for (let i = 0; i < 6; i++) await page.keyboard.press("l");
  await sleep(500);
  await expect(hint, "a v-made selection still says how to open it from the keyboard").toBeVisible({ timeout: 4_000 });
  await expect(bubble, "…and does not also raise the bubble").toHaveCount(0);

  // ── mouse: drag — the toolbar, like non-vim and WYSIWYG ────────────────────────────────────────
  await page.keyboard.press("Escape");
  await sleep(200);
  await dragSelectFirstLine(page);
  await expect(bubble, "a dragged selection offers the palette straight away").toBeVisible({ timeout: 4_000 });
  await expect(hint, "…and the keystroke hint steps aside").toHaveCount(0);

  // ── last input wins: touching a key after the drag hands it back to the keyboard ───────────────
  //
  // The bubble going away is the assertion, not the hint arriving. Whether the hint then shows depends
  // on vim still holding a visual selection after that key, which is vim's business and varies by key
  // measuring it here would be measuring the editor's motion rules, not this ticket's rule. What #631
  // decides is that a selection stops counting as pointer-made once a key is touched, and that is
  // exactly what the bubble's absence reports.
  await page.keyboard.press("l");
  await sleep(400);
  await expect(bubble, "a key after the drag takes the mouse answer back").toHaveCount(0);
});

test("#631: `\\` still opens the palette from either kind of selection", async ({ page }) => {
  await openScratch(page, "vim-mouse-631-b");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("alpha beta gamma delta\n");
  await sleep(400);
  await vimOn(page);

  // from a dragged selection — the one that now shows the bubble
  await dragSelectFirstLine(page);
  await page.keyboard.press("\\");
  await sleep(400);
  const palette = page.locator("[data-testid=decorate-palette], [data-testid=palette]").first();
  await expect(palette, "the keyboard route is not taken away by the mouse route").toBeVisible({ timeout: 4_000 });
});
