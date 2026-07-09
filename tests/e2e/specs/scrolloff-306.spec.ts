import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #306: vim-style scrolloff — a ~25% scroll margin keeps the caret inside the middle ~50% of the viewport on
// cursor motion (so you never drive the caret to the very bottom edge as you move down a long document). Real
// Chromium: type a long doc, walk the caret down deep into it, and assert the caret's Y stays inside the band.
test("#306: the caret stays in the middle band while moving down a long document (scrolloff)", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  await openScratch(page, "scrolloff-306");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(Array.from({ length: 120 }, (_, i) => `line ${i} of the long document`).join("\n"));
  await sleep(300);

  const caretBandFrac = () => page.evaluate(() => {
    const sc = document.querySelector("[data-pane=preview] .cm-scroller") as HTMLElement;
    const cur = document.querySelector("[data-pane=preview] .cm-cursor-primary") as HTMLElement | null;
    if (!sc || !cur) return null;
    const scb = sc.getBoundingClientRect();
    const cb = cur.getBoundingClientRect();
    return (cb.top + cb.height / 2 - scb.top) / scb.height; // 0 = top edge, 1 = bottom edge
  });

  // Go to the top, then walk DOWN well past the top band into the document's middle.
  await page.keyboard.press("Control+Home");
  await sleep(150);
  for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowDown");
  await sleep(300);

  // The caret must sit inside the middle band — never driven to the bottom edge (pre-fix the 72px bottom
  // margin let it ride at ~90% of the viewport). Allow a little slack around the 25–75% band.
  const frac = await caretBandFrac();
  expect(frac, "no caret rect").not.toBeNull();
  expect(frac!, `caret band fraction ${frac} should be within the middle band`).toBeGreaterThan(0.18);
  expect(frac!, `caret band fraction ${frac} should be within the middle band`).toBeLessThan(0.82);
});
