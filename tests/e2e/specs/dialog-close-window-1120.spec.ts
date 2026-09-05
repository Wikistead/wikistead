import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #1120: closing a dialog must give the page back IMMEDIATELY, and must still fade.
//
// The history is a pendulum, which is why both halves are pinned here at once. #1072 found that a
// click landing while a dialog closed was swallowed, and closed that window by deleting the exit
// animation (99e5aa15) — motion traded for hit-testing. #1120's ruling put the fade back and asked for
// the window to be closed "by another means". Measured on the restored version (2026-09-05, real
// Chromium): `document.body`'s pointer-events lock cleared after ~10ms, but the OVERLAY stayed over
// the page for the whole exit animation, so the page only became clickable again ~175ms after the
// close. The fix makes the exiting layers stop hit-testing (`ds-controls.css`, `[data-state="closed"]`).
//
// Real Chromium on purpose: the defect and the fix both live in computed style and hit-testing during
// an animation — a class-string or source-order assertion would have passed for the Tailwind utility
// that was tried first, whose class reached the element while its declaration never existed.
test("#1120: a closing dialog stops taking clicks at once, and still fades out", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await openDemo(page);
  await sleep(1200);

  // A point over the app chrome, outside the dialog. What matters is only whether the topmost element
  // there still belongs to the closing dialog — so this needs no testid of its own.
  const aim = { x: 60, y: 400 };
  const under = (label: string) => `${label}`;
  void under;

  await page.keyboard.press("Control+k");
  await expect(page.locator("[role=dialog]")).toBeVisible({ timeout: 10000 });
  await sleep(300);

  const trace = await page.evaluate((pt) => new Promise<{ firstReachableMs: number; sawFade: boolean; frames: [number, string, string][] }>((resolve) => {
    const frames: [number, string, string][] = [];
    const t0 = performance.now();
    let firstReachableMs = -1;
    let sawFade = false;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const tick = () => {
      const t = Math.round(performance.now() - t0);
      const ov = document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement | null;
      const hit = document.elementFromPoint(pt.x, pt.y);
      const inDialog = !!hit?.closest('[role="dialog"], [data-slot="dialog-overlay"]');
      const opacity = ov ? Number(getComputedStyle(ov).opacity) : NaN;
      // the fade is real only if the overlay is still mounted AND part-way transparent at some frame
      if (ov && opacity > 0 && opacity < 1) sawFade = true;
      if (!inDialog && firstReachableMs < 0) firstReachableMs = t;
      frames.push([t, inDialog ? "dialog" : "page", ov ? `${opacity.toFixed(2)} pe=${getComputedStyle(ov).pointerEvents} inline=${ov.style.pointerEvents || "-"}` : "unmounted"]);
      if (t > 400) return resolve({ firstReachableMs, sawFade, frames });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), aim);

  console.log("[1120] first frame the page is reachable again:", trace.firstReachableMs, "ms");
  console.log("[1120] frames:", JSON.stringify(trace.frames.slice(0, 12)));

  // Half 1 — the window. One frame's grace (the sample can start before the state flips), never the
  // length of an animation: 175ms was the defect, ~16ms is the first frame at 60Hz.
  expect(trace.firstReachableMs, "the page must be clickable again within a frame of the close").toBeGreaterThanOrEqual(0);
  expect(trace.firstReachableMs, "a click must not be swallowed for the length of the exit animation").toBeLessThan(50);

  // Half 2 — the motion. Without this a future fix could close the window by deleting the fade again,
  // which is exactly the trade #1120 reversed.
  expect(trace.sawFade, "the overlay must still fade out (mounted and part-way transparent at some frame)").toBe(true);
});
