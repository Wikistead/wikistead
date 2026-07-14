import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #361: a task toggle must UPDATE the checkbox + progress ring IN PLACE, not rebuild them. A rebuild re-mounts
// the DOM — the checkbox shows a one-frame bounce (flicker) and the ring's arc `<circle>` is a fresh element
// with no from→to, so its stroke-dashoffset transition never fires (the ring doesn't animate). We assert the
// STRUCTURAL precondition in real Chromium: the SAME elements survive the toggle (updateDOM ran) and their
// state updated. The visual smoothness of the animation itself stays a human-eye check.
test("#361: toggling a task keeps the SAME checkbox + ring elements (in-place update, no re-mount)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "todo-inplace-361");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::todo[Sprint]\n- [x] alpha\n- [ ] beta\n- [ ] gamma\n:::\n\nbelow\n");
  await sleep(400);
  await page.getByText("below").click();
  await sleep(200);

  const boxes = page.getByTestId("task-checkbox");
  await expect(boxes).toHaveCount(3);
  const ring = page.locator("[data-pane=preview] [data-testid=todo-ring]");
  await expect(ring).toHaveAttribute("data-done", "1");

  // Grab element handles BEFORE the toggle so we can prove the exact same nodes are still attached after.
  const betaBox = (await boxes.nth(1).elementHandle())!;
  const arc = (await ring.locator(".cm-lp-todo-ring-arc").elementHandle())!;
  const offsetBefore = await arc.getAttribute("stroke-dashoffset");

  await boxes.nth(1).click();
  await sleep(300);

  // The checkbox is the SAME <input> (updateDOM kept it — no re-mount bounce) and is now checked.
  expect(await betaBox.evaluate((el) => el.isConnected), "the toggled checkbox is the SAME element (not rebuilt)").toBe(true);
  expect(await betaBox.evaluate((el) => (el as HTMLInputElement).checked)).toBe(true);

  // The ring arc is the SAME <circle> (updateProgressRing kept it) with an UPDATED stroke-dashoffset — the
  // precondition for the CSS transition to animate. A rebuild would have detached this node.
  expect(await arc.evaluate((el) => el.isConnected), "the ring arc is the SAME circle (transition can fire)").toBe(true);
  const offsetAfter = await arc.getAttribute("stroke-dashoffset");
  expect(offsetAfter).not.toBe(offsetBefore); // 1/3 → 2/3 moved the arc
  await expect(ring).toHaveAttribute("data-done", "2");
});
