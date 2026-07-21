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

// #440 / ADR-166: the modal's hop selector + the space legend. The selector refetches/relayouts per
// depth (server clamps anyway); nodes color by space with a NAMED legend row only for spaces in the
// viewer's own view-filtered space list (name-leak boundary is GET /spaces, pinned server-side).
test("#440: the modal hop selector switches depth and the space legend names the viewable space", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const target = await openScratch(page, `lg-depth-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("depth target.\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(600);
  const linker = await openScratch(page, `lg-depth-linker-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`link [t](/p/${target})\n`);
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(800);

  await page.goto(`/p/${target}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("related-toggle").click();
  await page.getByTestId("local-graph-toggle").click();
  await expect(page.getByTestId("local-graph-canvas")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("local-graph-expand").click();
  const modal = page.getByTestId("local-graph-modal");
  await expect(modal).toBeVisible({ timeout: 10000 });

  // default = 2; switching to 1 and 3 keeps a live canvas (refetch + rebuild, no crash/blank)
  await expect(modal.getByTestId("graph-depth-2")).toHaveAttribute("aria-checked", "true");
  await modal.getByTestId("graph-depth-1").click();
  await expect(modal.getByTestId("graph-depth-1")).toHaveAttribute("aria-checked", "true");
  await expect(modal.locator("[data-testid=local-graph-canvas] canvas").first()).toBeAttached({ timeout: 10000 });
  await modal.getByTestId("graph-depth-3").click();
  await expect(modal.getByTestId("graph-depth-3")).toHaveAttribute("aria-checked", "true");
  await expect(modal.locator("[data-testid=local-graph-canvas] canvas").first()).toBeAttached({ timeout: 10000 });

  // the space legend names the space (dev-user views it → it is in GET /spaces) — no generic bucket here
  await expect(modal.getByTestId("graph-space-legend").first()).toBeVisible({ timeout: 10000 });
  await expect(modal.getByTestId("graph-space-legend-other")).toHaveCount(0);
  void linker;
});

// #440 the two device-visible defects behind the rejection.
//  (a) the space colour reached the DOM legend but not the nodes: colorFromString returns a
//      space-separated `hsl(...)`, which sigma's WebGL renderer cannot parse, so every space node fell
//      back to the default paint while the swatch beside it showed the real colour. Both sides now
//      take the same hex, so the pin compares them directly.
//  (b) nodes were not draggable at all. A press that moves past a small threshold drags (and must not
//      navigate); a press that does not still navigates.
test("#440 node colours equal their legend swatch, and nodes drag without losing click-to-open", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const target = await openScratch(page, `lg-drag-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("drag target.\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(600);
  // THREE linkers, not one: with only two nodes the graph's layout is degenerate (identical y, and the
  // force loop is skipped for order <= 2), which makes sigma's viewport mapping unrepresentative — a
  // drag there moves one axis only. A real local graph has several nodes; the pin uses that shape.
  const linkers: string[] = [];
  for (let i = 0; i < 3; i++) {
    linkers.push(await openScratch(page, `lg-drag-linker${i}-${Date.now()}`));
    await enterEdit(page);
    await page.click("[data-pane=preview] .cm-content");
    await page.keyboard.insertText(`link ${i} [t](/p/${target})\n`);
    await sleep(300);
    await page.getByTestId("publish-page").click();
    await sleep(700);
  }

  await page.goto(`/p/${target}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("related-toggle").click();
  await page.getByTestId("local-graph-toggle").click();
  await expect(page.getByTestId("local-graph-canvas")).toBeVisible({ timeout: 10000 });
  await sleep(2000); // let the (now ~1s) settle finish so coordinates are stable

  // (a) every non-center node's colour is a hex the renderer understands, and the space swatch matches
  const colours = await page.evaluate(() => {
    const el = document.querySelector("[data-testid=local-graph-canvas]") as (HTMLElement & { __wksSigma?: any }) | null;
    const sigma = el?.__wksSigma;
    if (!sigma) return null;
    const nodeColours: string[] = [];
    sigma.getGraph().forEachNode((_n: string, a: { color: string }) => nodeColours.push(a.color));
    const swatches = [...document.querySelectorAll("[data-testid=graph-space-legend] span[aria-hidden]")]
      .map((s) => getComputedStyle(s as HTMLElement).backgroundColor);
    return { nodeColours, swatches };
  });
  expect(colours, "sigma seam present").not.toBeNull();
  expect(colours!.nodeColours.length).toBeGreaterThan(1);
  for (const c of colours!.nodeColours) {
    expect(c, `node colour must be renderer-parseable hex/rgb, got ${c}`).not.toMatch(/^hsl/);
  }
  // rgb(r, g, b) → #rrggbb so the legend swatch can be compared with the node attribute directly
  const toHex = (rgb: string) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
    return m ? `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}` : rgb;
  };
  const swatchHexes = colours!.swatches.map(toHex);
  expect(swatchHexes.length, "at least one named space swatch").toBeGreaterThan(0);
  for (const sw of swatchHexes) {
    expect(colours!.nodeColours, `swatch ${sw} has no node painted with it`).toContain(sw);
  }

  // (b) drag a non-center node: it follows the pointer and does NOT navigate
  const box = (await page.getByTestId("local-graph-canvas").first().boundingBox())!;
  const spots = await page.evaluate(() => {
    const el = document.querySelector("[data-testid=local-graph-canvas]") as (HTMLElement & { __wksSigma?: any }) | null;
    const sigma = el!.__wksSigma;
    const g = sigma.getGraph();
    const out: { id: string; x: number; y: number }[] = [];
    g.forEachNode((n: string, a: { x: number; y: number }) => {
      const v = sigma.graphToViewport({ x: a.x, y: a.y });
      out.push({ id: n, x: v.x, y: v.y });
    });
    return out;
  });
  const node = spots[1]!; // not the centre
  const urlBefore = page.url();
  await page.mouse.move(box.x + node.x, box.y + node.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + node.x + i * 8, box.y + node.y + i * 5);
    await sleep(30);
  }
  await page.mouse.up();
  await sleep(400);
  const after = await page.evaluate((id: string) => {
    const el = document.querySelector("[data-testid=local-graph-canvas]") as (HTMLElement & { __wksSigma?: any }) | null;
    const sigma = el!.__wksSigma;
    const a = sigma.getGraph().getNodeAttributes(id) as { x: number; y: number };
    return sigma.graphToViewport({ x: a.x, y: a.y });
  }, node.id);
  const followError = Math.hypot(after.x - (node.x + 64), after.y - (node.y + 40));
  expect(followError, `the node follows the pointer (off by ${Math.round(followError)}px)`).toBeLessThan(25);
  expect(page.url(), "a drag must not navigate").toBe(urlBefore);

  // …and a plain click still opens the page (the gesture that already existed)
  await page.mouse.click(box.x + after.x, box.y + after.y);
  await sleep(1200);
  expect(page.url(), "a click still navigates").not.toBe(urlBefore);
  void linkers;
});
