import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #306: vim-style scrolloff — a ~25% scroll margin keeps the caret inside the middle ~50% of the viewport on
// cursor motion (so you never drive the caret to the very bottom edge as you move down a long document). Real
// Chromium: type a long doc, walk the caret down deep into it, and assert the caret's Y stays inside the band.
test("#306: the caret stays in the middle band while moving down a long document (scrolloff)", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  await openScratch(page, "scrolloff-306");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(Array.from({ length: 120 }, (_, i) => `line ${i} of the long document`).join("\n"));
  await sleep(300);

  const caretBandFrac = () => page.evaluate(() => {
    const sc = document.querySelector("[data-pane=preview] .cm-scroller") as HTMLElement;
    const cur = document.querySelector("[data-pane=preview] .cm-cursor-primary") as HTMLElement | null;
    if (!sc || !cur) return null;
    const scb = sc.getBoundingClientRect();
    const cb = cur.getBoundingClientRect();
    return (cb.top + cb.height / 2 - scb.top) / scb.height; // 0 = top edge, 1 = bottom edge
  });

  // Go to the top, then walk DOWN well past the top band into the document's middle.
  await page.keyboard.press("Control+Home");
  await sleep(150);
  for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowDown");
  await sleep(300);

  // The caret must sit inside the middle band — never driven to the bottom edge (pre-fix the 72px bottom
  // margin let it ride at ~90% of the viewport). Allow a little slack around the 25–75% band.
  const frac = await caretBandFrac();
  expect(frac, "no caret rect").not.toBeNull();
  expect(frac!, `caret band fraction ${frac} should be within the middle band`).toBeGreaterThan(0.18);
  expect(frac!, `caret band fraction ${frac} should be within the middle band`).toBeLessThan(0.82);
});

// #306 (review bounce): the band must be held by MINIMAL scrolling — the caret pinned at the
// band edge on screen while the document scrolls one line per keypress — never by re-centering (the old
// y:"center" made the view "yank" the caret back to the middle on every band exit). These assert the exact
// reported symptom: per keypress, the caret's viewport Y is unchanged (± a few px) and scrollTop advances
// by roughly one line — never a quarter-viewport jump.
test.describe("#306 minimal-scroll scrolloff (no re-center jump)", () => {
  async function setup(browser: import("@playwright/test").Browser) {
    const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
    await openScratch(page, "scrolloff-306-c1317");
    await enterEdit(page);
    await page.click("[data-pane=preview] .cm-content");
    await page.keyboard.insertText(Array.from({ length: 120 }, (_, i) => `line ${i} of the long document`).join("\n"));
    await sleep(300);
    const metrics = () => page.evaluate(() => {
      const sc = document.querySelector("[data-pane=preview] .cm-scroller") as HTMLElement;
      const cur = document.querySelector("[data-pane=preview] .cm-cursor-primary") as HTMLElement | null;
      if (!sc || !cur) return null;
      const scb = sc.getBoundingClientRect();
      const cb = cur.getBoundingClientRect();
      return { caretY: cb.top + cb.height / 2 - scb.top, scrollTop: sc.scrollTop, height: scb.height };
    });
    return { page, metrics };
  }

  test("moving DOWN at the band edge: caret Y pinned, scrollTop advances ~one line per press", async ({ browser }) => {
    const { page, metrics } = await setup(browser);
    // Walk well past the lower band edge so every further press is in the "follow" regime.
    await page.keyboard.press("Control+Home");
    await sleep(150);
    for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowDown");
    await sleep(300);

    let prev = await metrics();
    expect(prev, "no caret rect").not.toBeNull();
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("ArrowDown");
      await sleep(150); // the scrolloff listener runs in a rAF
      const cur = (await metrics())!;
      // the caret stays at the SAME on-screen height (band-edge pinning) …
      expect(Math.abs(cur.caretY - prev!.caretY), `press ${i}: caret Y moved ${prev!.caretY} → ${cur.caretY}`).toBeLessThanOrEqual(8);
      // … and the document scrolls by about one line — never a quarter-viewport (~175px) re-center jump.
      const delta = cur.scrollTop - prev!.scrollTop;
      expect(delta, `press ${i}: scrollTop delta ${delta}`).toBeGreaterThan(5);
      expect(delta, `press ${i}: scrollTop delta ${delta}`).toBeLessThan(80);
      prev = cur;
    }
    await page.close();
  });

  test("moving UP at the band edge is symmetric: caret Y pinned, scrollTop decreases ~one line per press", async ({ browser }) => {
    const { page, metrics } = await setup(browser);
    // Start deep in the document, then walk UP past the top band edge into the follow regime.
    await page.keyboard.press("Control+End");
    await sleep(150);
    for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowUp");
    await sleep(300);

    let prev = await metrics();
    expect(prev, "no caret rect").not.toBeNull();
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("ArrowUp");
      await sleep(150);
      const cur = (await metrics())!;
      expect(Math.abs(cur.caretY - prev!.caretY), `press ${i}: caret Y moved ${prev!.caretY} → ${cur.caretY}`).toBeLessThanOrEqual(8);
      const delta = prev!.scrollTop - cur.scrollTop;
      expect(delta, `press ${i}: scrollTop delta ${delta}`).toBeGreaterThan(5);
      expect(delta, `press ${i}: scrollTop delta ${delta}`).toBeLessThan(80);
      prev = cur;
    }
    await page.close();
  });

  test("inside the band nothing scrolls; a mouse click never moves the view", async ({ browser }) => {
    const { page, metrics } = await setup(browser);
    // Inside the band: a couple of presses from the very top must not scroll (scrollTop stays 0).
    await page.keyboard.press("Control+Home");
    await sleep(200);
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
    await sleep(200);
    const inBand = (await metrics())!;
    expect(inBand.scrollTop, "in-band motion must not scroll").toBe(0);

    // Scroll somewhere in the middle, then CLICK on a line near the lower edge — select.pointer is
    // excluded from the scrolloff, so the view must not move even though the caret lands outside the band.
    for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowDown");
    await sleep(300);
    const before = (await metrics())!;
    const sc = page.locator("[data-pane=preview] .cm-scroller");
    const box = (await sc.boundingBox())!;
    await page.mouse.click(box.x + 200, box.y + box.height - 40); // well below the lower band edge
    await sleep(300);
    const after = (await metrics())!;
    expect(Math.abs(after.scrollTop - before.scrollTop), "a click must not scroll the view").toBeLessThanOrEqual(1);
    await page.close();
  });
});
