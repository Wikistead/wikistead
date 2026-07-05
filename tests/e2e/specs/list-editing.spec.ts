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

// #202 (comment 761): nested ORDERED lists count INDEPENDENTLY per level (a nested list restarts, not
// merged into the parent's run) and get a per-level ordinal STYLE (1.→a.→i.), keyed off the same nesting
// depth as the bullet glyphs so the two hierarchies read consistently. The rendered ordinal comes from
// the tree position, so deliberately "wrong" source numbers still render the correct sequence.
test("#202: nested ordered lists are independent per level with 1.→a.→i. style", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "list-ordered");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // source numbers are wrong on purpose (9., 9.) — the render must use the per-level tree position.
  await page.keyboard.insertText("1. a\n2. b\n   9. n1\n   9. n2\n      9. deep\n3. c\nafter\n");
  await sleep(500);
  await page.keyboard.press("Control+End"); // caret off the list so markers render
  await sleep(200);
  const ords = await page.locator("[data-pane=preview] .cm-lp-ordinal").allTextContents();
  // top level: decimal, independent of the nested items (3. is the 3rd TOP item, not 6.)
  expect(ords).toContain("1.");
  expect(ords).toContain("2.");
  expect(ords).toContain("3.");
  // first nest: lower-alpha, restarted at a. (from source 9., 9.)
  expect(ords).toContain("a.");
  expect(ords).toContain("b.");
  // second nest: lower-roman
  expect(ords).toContain("i.");
  // NOT merged into the parent run — no stray 4./5./6. from counting the nested items
  expect(ords).not.toContain("4.");
  expect(ords).not.toContain("5.");
});

// #202 comment 773: pressing Tab to nest an ordered item must indent it by the marker width (3 for `1. `)
// so it PARSES as a child list — restarting the count and switching the ordinal style to lower-alpha. A
// fixed 2-space indent left the item in the parent list (flat 1,2,3,4,5). This is the real Tab workflow.
test("#202 comment 773: Tab-nesting an ordered list restarts and switches 1.→a. (not flat decimal)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "list-ordered-tab");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("1. a");
  await page.keyboard.press("Enter"); // → "2. "
  await page.keyboard.type("b");
  await page.keyboard.press("Enter"); // → "3. "
  await page.keyboard.press("Tab");   // nest: indent by marker width (3) so it parses as a child list
  await page.keyboard.type("c");
  await page.keyboard.press("Enter"); // continues the NESTED list
  await page.keyboard.type("d");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Tab"); // back to top level
  await page.keyboard.type("e");
  await page.keyboard.press("Enter"); // → continuation marker
  await page.keyboard.press("Enter"); // empty item → exits the list (blank line)
  await page.keyboard.type("end");
  await sleep(400);
  await page.keyboard.press("Control+End"); // caret on the trailing paragraph — every list marker renders
  await sleep(300);

  const ords = await page.locator("[data-pane=preview] .cm-lp-ordinal").allTextContents();
  // top level stays decimal and consecutive (nested items do NOT bleed into it)
  expect(ords).toContain("1.");
  expect(ords).toContain("2.");
  expect(ords).toContain("3."); // the third TOP item (e), not "5."
  // the nested items restart under lower-alpha
  expect(ords).toContain("a.");
  expect(ords).toContain("b.");
  // the flat-decimal bug is gone: no 4./5. from counting nested items into the parent run
  expect(ords).not.toContain("4.");
  expect(ords).not.toContain("5.");
});
