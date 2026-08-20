import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #636 (user ruling): the trailing room belongs to the EXPORTED FILE, and not to the app.
//
// The first attempt at this ticket put 40vh below the last line of the editor and the reading column,
// and the answer was that the gap was now far too big, the original state had been fine, and the
// remark had been about the exported html — it had been made while looking at a saved file, and
// the ticket read it as being about the product.
//
// The tail itself is measured on the saved bytes, in `export-user-path-85.spec.ts`, because that is the
// surface it belongs to: the file is downloaded, opened from `file://` with no app and no dev server,
// and the space below its last block is measured there.
//
// What is pinned HERE is the other half of that ruling, and it is the half a fix is likely to forget:
// the editing surface went back to what it was. Reverting one of the two files and shipping is the
// obvious mistake, and it leaves a reader with the 288px they explicitly rejected.
test("#636: the editor's own bottom room is what it was — the tail belongs to the export", async ({ page }) => {
  await openScratch(page, "tail-room-636");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("one\n");
  await sleep(800);

  const room = await page.evaluate(() => {
    const content = document.querySelector("[data-pane=preview] .cm-content") as HTMLElement | null;
    if (!content) return null;
    return {
      padBottom: parseFloat(getComputedStyle(content).paddingBottom),
      viewport: window.innerHeight,
      // …and a page that fits on one screen still does not scroll: the regression the 40vh version was
      // careful about, and the one a fixed value has to keep clear of too
      scrolls: (document.scrollingElement?.scrollHeight ?? 0) > (document.scrollingElement?.clientHeight ?? 0),
    };
  });

  expect(room, "the editor rendered").not.toBeNull();
  // enough to clear the floating controls (#473, which this value has always carried), and nowhere near
  // the fraction-of-the-window the ruling rejected
  expect(room!.padBottom, `the editor pads ${room!.padBottom}px below the last line`).toBeGreaterThan(40);
  expect(room!.padBottom, `…and not a fraction of the ${room!.viewport}px window — that was rejected`)
    .toBeLessThan(room!.viewport * 0.2);
  expect(room!.scrolls, "a page that fits on one screen does not scroll").toBe(false);
});
