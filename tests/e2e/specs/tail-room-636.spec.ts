import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

//
// The last line sat against the bottom of the window, so a document that had ended looked like one that
// was cut off — and writing at the end of it meant typing along the very edge of the screen.
//
// Two things are measured, and the second is the one that is easy to break while fixing the first
// adding trailing room by height makes a SHORT page scroll, which is a new annoyance in place of the
// old one. That case is asserted before the tail itself, because it is the regression a fix invites.
const LONG = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");

async function scrollMetrics(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[data-pane=preview] .cm-scroller")!;
    const content = document.querySelector<HTMLElement>("[data-pane=preview] .cm-scroller > .cm-content")!;
    const lines = [...content.querySelectorAll<HTMLElement>(".cm-line")];
    const last = lines[lines.length - 1]!;
    return {
      // how much empty space follows the last line, in the scrollable box
      tail: Math.round(content.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom),
      viewport: window.innerHeight,
      scrollable: scroller.scrollHeight > scroller.clientHeight + 1,
    };
  });
}

test("#636: a document ends with room after its last line", async ({ page }) => {
  await openScratch(page, "tail-room-636");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(LONG + "\n");
  await sleep(900);

  const m = await scrollMetrics(page);
  expect(m.scrollable, "the fixture is long enough to scroll").toBe(true);
  // A fraction of the viewport, not a fixed height — what makes the last line comfortable is where it
  // lands on the screen. Asserted as "a real share of the window" rather than an exact px, so the
  // token can be tuned without rewriting the test.
  expect(m.tail, `only ${m.tail}px follows the last line in a ${m.viewport}px window`)
    .toBeGreaterThan(m.viewport * 0.2);
});

test("#636: a short page still does not scroll — the tail must not invent one", async ({ page }) => {
  await openScratch(page, "tail-room-636-short");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("just one line\n");
  await sleep(900);

  const m = await scrollMetrics(page);
  expect(m.scrollable, "a one-line page fits, and adding trailing room must not change that").toBe(false);
});
