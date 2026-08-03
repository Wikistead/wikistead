import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #599: the block grip is a handle for the block it is BESIDE, and it is big enough to grab.
//
// Two symptoms, one of them not cosmetic. The grip was positioned in editor coordinates and recomputed
// only on mousemove, so a wheel scroll left it hanging beside whatever had scrolled into that spot —
// while it still carried the position of the block it was originally resolved on. Grabbing it then
// moved a block the reader was not looking at. That is a wrong edit to the document, reached through a
// control that looked right.
//
// Measured in a real browser because both facts are geometry: where the grip is after a scroll, and how
// big the thing a hand has to hit actually is.
const LINES = Array.from({ length: 60 }, (_, i) => `paragraph number ${i + 1}`).join("\n\n");

test("#599: the grip does not outlive the scroll that moved its block away", async ({ page }) => {
  test.setTimeout(120_000);
  await openScratch(page, `grip599-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.evaluate((text) => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? el?.cmTile?.view) as { state: { doc: { length: number } }; dispatch(t: unknown): void } | undefined;
    if (!view) throw new Error("no editor view");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, LINES);
  await sleep(800);

  // hover a paragraph to summon the grip
  const line = page.locator("[data-pane=preview] .cm-content .cm-line").nth(6);
  await line.hover();
  const grip = page.getByTestId("block-grip");
  await expect(grip).toBeVisible({ timeout: 8000 });

  // the hit area: the icon may stay small, the target may not (#535's minimum)
  const box = (await grip.boundingBox())!;
  expect(Math.round(box.width), "the hit area is at least 24px wide").toBeGreaterThanOrEqual(24);
  expect(Math.round(box.height), "and at least 24px tall").toBeGreaterThanOrEqual(24);

  // scroll the content out from under it — the grip must not stay behind pointing at a stale block
  await page.mouse.wheel(0, 400);
  await sleep(400);
  await expect(grip, "a grip that survives the scroll is a handle for the wrong block").toBeHidden();
});
