import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #473: "the view scrolls a long way and the caret appears to leap upwards". Measured, the trigger is
// not adding a line (that scrolls nothing on its own) but the first caret MOTION after a click has
// parked the caret below the #306 scrolloff band — clicking deliberately never scrolls, so the
// caret can sit well outside the band, and the correction used to be paid in a single step: the view
// moved 161px while the caret stayed on the same text, measured as a 137px leap up the screen.
//
// The scrolloff now closes that gap by at most half a line beyond the caret's own movement, so the view
// catches up over a few presses instead of lurching. bottom-edge-scroll-473.spec.ts pins the steady
// state this must not disturb (one line per press, caret fixed); this pins the arrival.
const geo = (p: Page) => p.evaluate(() => {
  const sc = document.querySelector("[data-pane=preview] .cm-scroller")!;
  const c = document.querySelector("[data-pane=preview] .cm-cursor-primary");
  return { scrollTop: Math.round(sc.scrollTop), caretY: c ? Math.round(c.getBoundingClientRect().top) : null };
});

test("#473: the first motion after a click parked below the band catches up gradually, without a leap", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  await openScratch(page, `catchup473-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(Array.from({ length: 60 }, (_, i) => `line ${i + 1} of prose`).join("\n") + "\n");
  await sleep(1200);

  // park the caret near the bottom edge with plenty of document left below it, by clicking (which must
  // not scroll), so the scrolloff has a large gap to close on the next keypress
  await page.evaluate(() => { document.querySelector("[data-pane=preview] .cm-scroller")!.scrollTop = 0; });
  await sleep(500);
  const spot = await page.evaluate(() => {
    const sc = document.querySelector("[data-pane=preview] .cm-scroller")!;
    const box = sc.getBoundingClientRect();
    const line = [...document.querySelectorAll("[data-pane=preview] .cm-line")]
      .filter((l) => { const r = l.getBoundingClientRect(); return r.bottom < box.bottom - 40 && r.top > box.top; }).pop()!;
    const r = line.getBoundingClientRect();
    return { x: r.left + 20, y: r.top + r.height / 2 };
  });
  await page.mouse.click(spot.x, spot.y);
  await sleep(400);

  let prev = await geo(page);
  const caretSteps: number[] = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("ArrowDown");
    await sleep(350);
    const cur = await geo(page);
    caretSteps.push((cur.caretY ?? 0) - (prev.caretY ?? 0));
    prev = cur;
  }

  const worst = Math.max(...caretSteps.map(Math.abs));
  // before the fix the first press measured 137px; the residual is the caret being lifted clear of the
  // floating controls strip by CodeMirror's own 72px clearance, which bottom-edge-scroll-473 pins
  expect(worst, `worst caret displacement ${worst}px (per press: ${JSON.stringify(caretSteps)})`).toBeLessThan(80);
  // and every press after the arrival must be gentle — this is the part the clamp owns
  const after = caretSteps.slice(1).map(Math.abs);
  expect(Math.max(...after), `later presses: ${JSON.stringify(caretSteps)}`).toBeLessThanOrEqual(20);
});
