import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #394 / ADR-147: the §Local graph section in the Related panel. Real Chromium (sigma.js renders to
// WebGL canvases — happy-dom can't). Create a target + a linker so the graph has an edge, open the
// Related panel, expand the collapsed §Local graph, expect the canvas; then expand to the depth-2 modal.
test("#394: the Related panel draws a local graph and expands it to a modal", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const target = await openScratch(page, "lg-target");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("local graph target.\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(600);

  const linker = await openScratch(page, "lg-linker");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`see [the target](/p/${target}) here\n`);
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(800);

  // Open the target's Related panel; §Local graph starts COLLAPSED (no canvas, no fetch).
  await page.goto(`/p/${target}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("related-toggle").click();
  await expect(page.getByTestId("related-panel")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("local-graph-toggle")).toBeVisible();
  await expect(page.getByTestId("local-graph-canvas")).toHaveCount(0);

  // Expand the section → the mini canvas mounts and sigma attaches its canvases.
  await page.getByTestId("local-graph-toggle").click();
  const mini = page.getByTestId("local-graph-canvas");
  await expect(mini).toBeVisible({ timeout: 10000 });
  await expect(mini.locator("canvas").first()).toBeAttached({ timeout: 10000 });

  // Expand button → the depth-2 modal with its own canvas.
  await page.getByTestId("local-graph-expand").click();
  const modal = page.getByTestId("local-graph-modal");
  await expect(modal).toBeVisible({ timeout: 10000 });
  await expect(modal.locator("[data-testid=local-graph-canvas] canvas").first()).toBeAttached({ timeout: 10000 });
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
  void linker;
});

// #394 the animation pin the first pass lacked (false-green: "canvas exists" can't catch a
// dead layout). Samples REAL display coordinates (the component's __wksSigma seam) right after mount
// and again after the settle window — nodes must actually MOVE (the worker-based layout silently
// never ran on device). Needs >2 nodes: the layout loop is gated on graph.order > 2.
async function maxDisplacement(page: any, scope: string, waitMs: number): Promise<number> {
  const grab = () =>
    page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as any;
      const sigma = el?.__wksSigma;
      if (!sigma) return null;
      const out: Record<string, { x: number; y: number }> = {};
      for (const n of sigma.getGraph().nodes()) {
        // raw layout coords -> real viewport PIXELS (the ruling asks for on-screen movement)
        const a = sigma.getGraph().getNodeAttributes(n);
        out[n] = sigma.graphToViewport({ x: a.x, y: a.y });
      }
      return out;
    }, scope);
  const before = await grab();
  await sleep(waitMs);
  const after = await grab();
  if (!before || !after) return -1;
  let max = 0;
  for (const id of Object.keys(before)) {
    if (!after[id]) continue;
    max = Math.max(max, Math.hypot(after[id].x - before[id].x, after[id].y - before[id].y));
  }
  return max;
}

test("#394 the layout ANIMATES — display coordinates move between frames (mini + modal)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const target = await openScratch(page, "lg-anim-target");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("anim target.\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(600);
  for (const name of ["lg-anim-a", "lg-anim-b"]) {
    await openScratch(page, name);
    await enterEdit(page);
    await page.click("[data-pane=preview] .cm-content");
    await page.keyboard.insertText(`links [t](/p/${target}) here\n`);
    await sleep(300);
    await page.getByTestId("publish-page").click();
    await sleep(600);
  }

  await page.goto(`/p/${target}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("related-toggle").click();
  await expect(page.getByTestId("related-panel")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("local-graph-toggle").click();
  const miniSel = "[data-testid=local-graph-canvas]";
  await expect(page.locator(miniSel).locator("canvas").first()).toBeAttached({ timeout: 10000 });
  // sample immediately (settle takes ~2.5s) — nodes must travel a real screen distance
  const miniMove = await maxDisplacement(page, miniSel, 2000);
  expect(miniMove, "mini graph nodes move after mount").toBeGreaterThan(5);

  // the modal mounts its own canvas — same pin at depth 2
  await page.getByTestId("local-graph-expand").click();
  const modal = page.getByTestId("local-graph-modal");
  await expect(modal).toBeVisible({ timeout: 10000 });
  const modalSel = "[data-testid=local-graph-modal] [data-testid=local-graph-canvas]";
  await expect(page.locator(modalSel).locator("canvas").first()).toBeAttached({ timeout: 10000 });
  const modalMove = await maxDisplacement(page, modalSel, 2000);
  expect(modalMove, "modal graph nodes move after mount").toBeGreaterThan(5);
});
