import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #361the in-place update must hold on the READING (view) surface too — the rejection was that the
// editor animated but the reading surface didn't (it re-synced publishedMd with a WHOLE-doc replace, rebuilding
// every widget → no ring transition + a checkbox bounce). The fix dispatches the MINIMAL diff on the reading
// surface, so a toggle keeps the SAME ring arc + checkbox (updateDOM path). The visual animation stays a human
// check; here we prove the structural precondition (element identity survives) in real Chromium.
test("#361on the READING surface a toggle keeps the SAME ring + checkbox (minimal diff, not full rebuild)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `todo-view-361-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::todo[Sprint]\n- [x] alpha\n- [ ] beta\n- [ ] gamma\n:::\n\nbelow\n");
  await sleep(300);
  await page.getByTestId("publish-page").click(); // persist published_md
  await sleep(600);
  // publish EXITS editing → we are already on the VIEW surface (the Edit button proves view mode; the
  // earlier version clicked edit-toggle here, which re-ENTERED edit and asserted the live surface instead).
  await expect(page.getByTestId("edit-toggle")).toBeVisible({ timeout: 8000 });
  await sleep(500);

  const ring = page.locator("[data-pane=preview] [data-testid=todo-ring]");
  await expect(ring).toHaveAttribute("data-done", "1", { timeout: 6000 });
  const boxes = page.getByTestId("task-checkbox");
  await expect(boxes).toHaveCount(3);

  // grab the exact nodes BEFORE the toggle so we can prove they SURVIVE the reading-surface re-sync.
  const arc = (await ring.locator(".cm-lp-todo-ring-arc").elementHandle())!;
  const betaBox = (await boxes.nth(1).elementHandle())!;
  const offsetBefore = await arc.getAttribute("stroke-dashoffset");

  await boxes.nth(1).click(); // toggle → server persist → published query invalidated → minimal-diff re-sync
  await expect(ring).toHaveAttribute("data-done", "2", { timeout: 8000 }); // the re-sync landed

  // The reading-surface dispatch was a MINIMAL diff (not a whole-doc replace), so the SAME arc + checkbox are
  // still attached (updateDOM ran) — the precondition for a ring transition + a bounce-free checkbox.
  expect(await arc.evaluate((el) => el.isConnected), "reading-surface ring arc is the SAME circle").toBe(true);
  expect(await betaBox.evaluate((el) => el.isConnected), "reading-surface checkbox is the SAME input (no rebuild bounce)").toBe(true);
  expect(await betaBox.evaluate((el) => (el as HTMLInputElement).checked)).toBe(true);
  expect(await arc.getAttribute("stroke-dashoffset")).not.toBe(offsetBefore); // 1/3 → 2/3 moved the arc
});

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

// #361point 3: the SIDEBAR ring lives in a react-arborist virtualized row that REMOUNTS on the
// pages refetch after a toggle, so element identity can NOT survive there (the probe-confirmed structural
// limit). The fix replays the ring's last→new offset on a value-CHANGED mount, driving the SHARED CSS
// transition — so the sidebar ring finally ANIMATES (transitionrun fires) even though the element is new,
// while a value-unchanged remount stays still. Asserted with a capture-phase transitionrun listener (the
//probe technique) in real Chromium.
test("#361 c1846-3: the SIDEBAR ring animates across the refetch remount (transitionrun on a value change)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const title = `todo-side-361-${Date.now()}`;
  await openScratch(page, title);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::todo[Sprint]\n- [x] alpha\n- [ ] beta\n- [ ] gamma\n:::\n\nbelow\n");
  await sleep(300);
  await page.getByTestId("publish-page").click(); // aggregates land (task_done/total) → the sidebar ring appears
  await sleep(600);
  // publish EXITS editing → already on the VIEW surface (the reported repro surface).
  await expect(page.getByTestId("edit-toggle")).toBeVisible({ timeout: 8000 });
  await sleep(500);

  // the page's own sidebar row shows the compact ring at 1/3 — this mount records the animation baseline.
  const row = page.locator("[data-testid=tree-page]", { hasText: title }).first();
  await row.scrollIntoViewIfNeeded();
  const sideRing = row.locator("[data-testid=page-task-ring]");
  await expect(sideRing).toHaveAttribute("data-done", "1", { timeout: 8000 });

  // count transitionrun on ANY sidebar ring arc from here on — capture phase on document, so it counts
  // even when the arc is a brand-new element (the remount case this fix exists for).
  await page.evaluate(() => {
    (window as unknown as { __sideRingRuns?: number }).__sideRingRuns = 0;
    document.addEventListener("transitionrun", (e) => {
      const t = e.target as HTMLElement;
      if (t?.classList?.contains("cm-lp-todo-ring-arc") && t.closest?.("[data-testid=tree-todo-ring]")) {
        (window as unknown as { __sideRingRuns?: number }).__sideRingRuns!++;
      }
    }, true);
  });

  // toggle beta on the reading surface → server persists → ["pages"] invalidated → sidebar refetch/remount.
  await page.getByTestId("task-checkbox").nth(1).click();
  await expect(sideRing).toHaveAttribute("data-done", "2", { timeout: 8000 }); // the aggregate reached the sidebar
  await sleep(400); // give the replayed transition a beat to start
  const runs = await page.evaluate(() => (window as unknown as { __sideRingRuns?: number }).__sideRingRuns ?? 0);
  expect(runs, "the sidebar ring arc played a stroke-dashoffset transition").toBeGreaterThanOrEqual(1);
});

// #361the FAST-CLICK flicker. preventDefault on mousedown does NOT stop a native checkbox's
// click-activation: a real click (mousedown+mouseup) flipped the box optimistically on mousedown and the
// browser flipped it BACK on mouseup, leaving an unchecked window for the whole server round-trip
// (checked → unchecked → ~500ms → checked). element.click() never reproduced it (no mousedown), which is
// how the earlier pins stayed green. This drives a REAL click with the toggle endpoint DELAYED to widen
// the window, and samples the box on every frame: it must never revert before the server confirms.
test("#361a real fast click never shows the reverted state while the toggle is in flight", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  // widen the revert window: hold the toggle POST for 1200ms
  await page.route("**/tasks/toggle", async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  await openScratch(page, `todo-fastclick-361-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::todo[Sprint]\n- [ ] alpha\n- [x] bravo\n:::\n\nbelow\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(600);
  await expect(page.getByTestId("edit-toggle")).toBeVisible({ timeout: 8000 });
  await sleep(500);
  const boxes = page.getByTestId("task-checkbox");
  await expect(boxes).toHaveCount(2);

  // ON: real click on the unchecked alpha. The optimistic mousedown flip must HOLD through the whole
  // in-flight window — unfixed, the native click reverted it and the box sat UNCHECKED for the 1200ms
  // round-trip (exactly the reported "turns on, turns off, turns on").
  await boxes.nth(0).click();
  const onSamples: boolean[] = [];
  for (let t = 0; t < 10; t++) { await sleep(100); onSamples.push(await boxes.nth(0).evaluate((el) => (el as HTMLInputElement).checked)); }
  expect(onSamples.every(Boolean), `alpha stayed CHECKED while the toggle was in flight (samples: ${onSamples.join(",")})`).toBe(true);
  await sleep(800); // let the held POST land + refetch settle
  expect(await boxes.nth(0).evaluate((el) => (el as HTMLInputElement).checked), "alpha confirmed on").toBe(true);

  // OFF: real click on the checked bravo — symmetric: it must stay UNCHECKED through the window.
  await boxes.nth(1).click();
  const offSamples: boolean[] = [];
  for (let t = 0; t < 10; t++) { await sleep(100); offSamples.push(await boxes.nth(1).evaluate((el) => (el as HTMLInputElement).checked)); }
  expect(offSamples.every((v) => !v), `bravo stayed UNCHECKED while the toggle was in flight (samples: ${offSamples.join(",")})`).toBe(true);
  await sleep(800);
  expect(await boxes.nth(1).evaluate((el) => (el as HTMLInputElement).checked), "bravo confirmed off").toBe(false);
});
