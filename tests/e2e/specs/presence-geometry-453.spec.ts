import { test, expect } from "@playwright/test";
import { enterEdit, createScratchPage, sleep } from "../helpers";

// #453: the LOCAL atom-selection ring and the REMOTE macro-presence box must share one geometry —
// same rect (the macro wrap, not the full content width), same radius/outline — differing only in
// colour + avatar. Two real clients on one `:::children` atom; the observer holds BOTH frames at
// once (its own atom-sel + the peer's presence box) so the comparison is same-viewport.
test("#453: remote presence box hugs the same rect/shape as the local atom-sel ring", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  try {
    await A.goto("/p/demo");
    await A.waitForSelector("[data-pane=preview] .cm-content");
    const id = await createScratchPage(A, "pgeo453");
    for (const p of [A, B]) {
      await p.goto(`/p/${id}`);
      await p.waitForSelector("[data-pane=preview] .cm-content");
    }
    await sleep(600);
    await enterEdit(A);
    await enterEdit(B);

    // A inserts an ATOM macro (children = atomSelectable widget with a .cm-lp-macro-wrap).
    await A.click("[data-pane=preview] .cm-content");
    for (const line of ["intro", "", ":::children", ":::", "", "tail"]) {
      await A.keyboard.type(line);
      await A.keyboard.press("Enter");
    }
    await sleep(900);
    const wrapB = B.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
    await expect(wrapB).toBeVisible({ timeout: 8000 });

    // A parks its caret ON the atom (click the widget) → B draws the presence box for A.
    await A.locator("[data-pane=preview] .cm-lp-macro-wrap").first().click();
    await sleep(700);
    const box = B.locator("[data-pane=preview] [data-testid=macro-presence]");
    await expect(box).toHaveCount(1, { timeout: 5000 });

    // B atom-selects the SAME macro → B now shows its own ring AND A's box simultaneously.
    await wrapB.click();
    await sleep(500);
    await expect(wrapB).toHaveClass(/cm-lp-atom-sel/, { timeout: 5000 });

    // 1. RECT parity: the presence box sits on the wrap's own rect (not the full content width).
    const wr = (await wrapB.boundingBox())!;
    const br = (await box.boundingBox())!;
    expect(Math.abs(br.x - wr.x), "left").toBeLessThanOrEqual(2);
    expect(Math.abs(br.width - wr.width), "width").toBeLessThanOrEqual(3);
    expect(Math.abs(br.y - wr.y), "top").toBeLessThanOrEqual(2);
    expect(Math.abs(br.height - wr.height), "height").toBeLessThanOrEqual(3);

    // 2. SHAPE parity: identical ring properties (radius / outline), colour is the only difference.
    const selStyle = await wrapB.evaluate((el) => {
      const c = getComputedStyle(el);
      return { radius: c.borderRadius, outlineW: c.outlineWidth, outlineOffset: c.outlineOffset };
    });
    const boxStyle = await box.evaluate((el) => {
      const c = getComputedStyle(el);
      return { radius: c.borderRadius, outlineW: c.outlineWidth, outlineOffset: c.outlineOffset, border: c.borderTopWidth };
    });
    expect(boxStyle.radius, "border-radius parity").toBe(selStyle.radius);
    expect(boxStyle.outlineW, "outline width parity").toBe(selStyle.outlineW);
    expect(boxStyle.outlineOffset, "outline offset parity").toBe(selStyle.outlineOffset);
    expect(boxStyle.border, "no on-edge border (ring only)").toBe("0px");
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
