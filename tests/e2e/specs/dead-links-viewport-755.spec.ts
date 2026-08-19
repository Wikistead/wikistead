import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #755 / ADR-241 decision 2: the overlay now asks the store only about the links the reader can SEE.
// The answers are the same; what changed is WHEN they are asked.
//
// The regression that change could introduce is invisible to a unit test that drives the collector
// directly: if nothing re-ran the fetch on scroll, every dead link below the first screenful would stay
// unmarked FOREVER — the reader would scroll down and find live-looking links into pages they cannot
// open. The plugin re-runs on `viewportChanged`, and whether a real viewport actually changes on a real
// scroll is a browser question, so this is a real-Chromium check rather than a jsdom one.
//
// It is deliberately built so BOTH halves must hold: the first link proves marking still works at all,
// and the far one proves it survives the reader scrolling to it. A build that reverted to asking about
// the whole document would also pass — this pins the reader's outcome, not the request shape, because
// the reader's outcome is the thing that must not regress.
test("#755: a dead link far below the fold is struck once the reader scrolls to it", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");

  await openScratch(page, "dead-link-viewport-755");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // A dead link on line 1, ~300 lines of filler, then a second dead link. 300 lines is far past any
  // viewport at the sizes this suite runs at, so the far link starts outside `visibleRanges`.
  const filler = Array.from({ length: 300 }, (_, i) => `filler line ${i}`).join("\n");
  await page.keyboard.insertText(
    `[near](/p/does-not-exist-near-755)\n\n${filler}\n\n[far](/p/does-not-exist-far-755)\n\nend\n`,
  );
  await sleep(400);

  const dead = page.locator("[data-pane=preview] .cm-lp-link-dead");
  // The caret is at the end, so the near link renders (not raw) and is off-screen upward; scroll back to
  // it and let the first batch resolve.
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await sleep(200);
  await expect.poll(async () => await dead.allInnerTexts(), { timeout: 8000 }).toContain("near");

  // Now the half that only a moving viewport can answer. The far link was never in a request when the
  // page opened; scrolling to it must be enough on its own.
  await page.keyboard.press("Control+End");
  await sleep(300);
  await expect
    .poll(async () => await dead.allInnerTexts(), { timeout: 8000 })
    .toContain("far");
});
