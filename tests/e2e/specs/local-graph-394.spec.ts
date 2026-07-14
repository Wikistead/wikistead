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
