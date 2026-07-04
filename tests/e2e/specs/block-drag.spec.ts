import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// ADR-036 / #84: drag a top-level block by its left-gutter grip to reorder it. The move is one
// transaction over the single Y.Text; the grip + drop indicator are display-only.
test("drag a block's gutter grip to reorder it", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "blockdrag");
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
  for (const l of ["A0", "", "B0", "", "C0"]) {
    await page.keyboard.type(l);
    await page.keyboard.press("Enter");
  }
  await sleep(300);

  // One grip per top-level block (A0 / B0 / C0).
  const grips = page.locator("[data-pane=preview] [data-testid=block-grip]");
  await expect.poll(() => grips.count(), { timeout: 4000 }).toBe(3);

  const gA = (await grips.first().boundingBox())!; // A0's grip
  const cb = (await page.getByText("C0", { exact: true }).boundingBox())!; // drop onto C0

  await page.mouse.move(gA.x + gA.width / 2, gA.y + gA.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + 5, cb.y + cb.height / 2, { steps: 10 });
  await page.mouse.up();
  await sleep(300);

  // A0 dropped onto C0 ⇒ inserted before C0 ⇒ order becomes B0, A0, C0.
  const text = await page.locator("[data-pane=preview] .cm-content").innerText();
  const iA = text.indexOf("A0"), iB = text.indexOf("B0"), iC = text.indexOf("C0");
  expect(iB).toBeLessThan(iA); // B0 now before A0 (A0 moved down)
  expect(iA).toBeLessThan(iC); // A0 before C0
  expect(iA).toBeGreaterThanOrEqual(0); // all three still present (block intact)
});

// #84 bounce (comment 696): a block ATOM (mermaid/callout/table) renders as a REPLACED block WIDGET,
// so the gutter `lineMarker` never fired for it — grips only showed on plain paragraphs. `widgetMarker`
// now places a grip on widget atoms too, so EVERY top-level block is draggable. Verified in a real
// browser (happy-dom can't lay out the gutter/widgets).
test("#84: the drag grip shows for widget atoms (mermaid/callout/table), not only paragraphs", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "blockdrag-widgets");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("a paragraph\n\n```mermaid\ngraph TD\nA-->B\n```\n\n:::info\nhello\n:::\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nlast para\n");
  await sleep(700);
  // 5 top-level blocks (paragraph, mermaid widget, callout, table widget, paragraph) → 5 grips.
  await expect.poll(() => page.locator("[data-pane=preview] [data-testid=block-grip]").count(), { timeout: 4000 }).toBeGreaterThanOrEqual(5);
});

// #84 (comment 719): "grip " while the DOM-count test was green. The gap: the grip was
// present in the DOM but opacity 0.25 muted-gray made it imperceptible — a DOM count doesn't catch a
// grip the eye can't see. These assertions guard the REAL user-visible state: each grip is actually
// VISIBLE (computed opacity above a floor) and NOT occluded (elementFromPoint at its centre returns the
// grip, not something covering it). Measured in a real browser (geometry/compositing don't exist in
// happy-dom). This is the regression that pure DOM-counting missed.
test("#84: grips are actually VISIBLE and un-occluded (not just present in the DOM)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "blockdrag-visible");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("a paragraph\n\n```mermaid\ngraph TD\nA-->B\n```\n\n:::info\nhello\n:::\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nlast para\n");
  await sleep(800);
  await page.getByText("last para").click(); // caret off the blocks so atoms render as widgets
  await sleep(300);

  const vis = await page.evaluate(() => {
    const grips = Array.from(document.querySelectorAll('[data-testid="block-grip"]')) as HTMLElement[];
    return grips.map((g) => {
      const r = g.getBoundingClientRect();
      const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
      const top = document.elementFromPoint(cx, cy) as HTMLElement | null;
      return { opacity: parseFloat(getComputedStyle(g).opacity), w: r.width, h: r.height, onTop: top === g || g.contains(top) };
    });
  });
  expect(vis.length).toBeGreaterThanOrEqual(5);
  for (const g of vis) {
    expect(g.opacity, "grip must be perceptibly visible, not a faint 0.25").toBeGreaterThanOrEqual(0.4);
    expect(g.w, "grip has real width").toBeGreaterThan(4);
    expect(g.h, "grip has real height").toBeGreaterThan(4);
    expect(g.onTop, "grip must not be occluded by another element").toBe(true);
  }
});
