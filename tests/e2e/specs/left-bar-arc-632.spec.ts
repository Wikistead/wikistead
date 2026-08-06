import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";
import { decodePng, type Bitmap } from "../paint";

// #632 (review rejection)
//
// The strip was given `border-radius: inherit` so it would follow the box's corners. It cannot. A radius
// is clamped to half the side it sits on, so a 3px-wide strip asking for 4px is drawn with 1.5px — while
// the box's own background is still cut at the full 4px on the right. The two top corners of one box end
// up visibly different, which is what the reject saw.
//
// **`getComputedStyle` cannot find this.** It reports the SPECIFIED value, not the used one, so the box
// and the strip both answer "4px" and any comparison of those strings agrees. That is precisely how the
// previous check passed a defect a person could see. This one reads PIXELS.
//
// It also refuses to memorise 4px and 3px: the radius and the bar width are both driven from the test, so
// what is asserted is "the two corners are cut alike" for whatever values they are given — the general
// form of the defect rather than the single instance of it.

/** How far in from an edge the box's own paint starts, row by row down a corner arc.
 *
 *  The shot is taken with a margin around the box so that its first pixel is genuinely OUTSIDE it. An
 *  element screenshot has no outside: its top-left pixel is the strip, so "the background" came back as
 *  the bar's own colour and every reading was measured against the wrong reference — the first version of
 *  this test reported the right edge as painted at 0. `pad` is where the box begins.
 */
function cornerProfile(bm: Bitmap, rows: number, pad: number): { left: number[]; right: number[] } {
  const bg = [bm.data[0], bm.data[1], bm.data[2]] as const;
  const differs = (x: number, y: number) => {
    const o = (y * bm.width + x) * 4;
    return Math.abs(bm.data[o] - bg[0]) + Math.abs(bm.data[o + 1] - bg[1]) + Math.abs(bm.data[o + 2] - bg[2]) > 12;
  };
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < rows; i++) {
    const y = pad + i;
    let l = pad;
    while (l < bm.width && !differs(l, y)) l++;
    let r = pad;
    while (r < bm.width && !differs(bm.width - 1 - r, y)) r++;
    left.push(l - pad);
    right.push(r - pad);
  }
  return { left, right };
}

test("#632: the two top corners of a bar-carrying box are cut by the same arc", async ({ page }) => {
  test.setTimeout(120_000);
  await openScratch(page, "bar-arc-632");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::warning\nheads up\n:::\n\ntail\n");
  await sleep(1500);

  const box = page.locator("[data-pane=preview] .cm-lp-callout-panel").first();
  await expect(box, "the fixture rendered a bar-carrying box").toBeVisible({ timeout: 15_000 });

  for (const [radius, barW] of [["4px", "3px"], ["8px", "3px"], ["4px", "6px"], ["10px", "2px"]] as const) {
    await page.evaluate(({ radius, barW }) => {
      document.documentElement.style.setProperty("--wks-bar-w", barW);
      const el = document.querySelector<HTMLElement>("[data-pane=preview] .cm-lp-callout-panel")!;
      el.style.borderRadius = radius;
    }, { radius, barW });
    await sleep(150);

    const PAD = 4;
    const rect = (await box.boundingBox())!;
    const rows = Math.round(parseFloat(radius));
    const bm = decodePng(await page.screenshot({
      clip: { x: rect.x - PAD, y: rect.y - PAD, width: rect.width + PAD * 2, height: rows + PAD * 2 },
    }));
    expect(rows, `radius ${radius}: enough rows to see an arc`).toBeGreaterThan(1);

    const p = cornerProfile(bm, rows, PAD);
    // the premise: the corner actually curves, so there is something to compare. Without this the
    // assertion below is satisfied by a perfectly square box.
    expect(Math.max(...p.left, ...p.right), `radius ${radius}: the corner has an arc at all`).toBeGreaterThan(0);

    for (let i = 0; i < rows; i++) {
      expect(Math.abs(p.left[i] - p.right[i]),
        `radius ${radius} / bar ${barW}: row ${i} — paint starts ${p.left[i]}px in on the left and ${p.right[i]}px in on the right`)
        .toBeLessThanOrEqual(1);
    }
  }
});
