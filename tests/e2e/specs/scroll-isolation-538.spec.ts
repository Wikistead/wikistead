import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #538: scrolling re-rendered React. The route keeps the active/visible heading in state — that part is
// legitimate, the TOC needs it — but two of the callbacks it hands the memoised <Editor> were rebuilt on
// every render, so the memo missed and the whole editor re-rendered with the route. Measured: 22 editor
// renders across ten scroll steps, and the only props whose identity changed were `onPublish` and
// `onToggleTask`. Both listed a react-query mutation OBJECT in their dependencies, and react-query hands
// back a fresh object every render.
//
// This is the same invariant `foundation` pins for typing (ADR-013: the document lives in Y.Text and CM,
// not in React), aimed at the other thing a reader does constantly.
test("#538: scrolling does not re-render the editor", async ({ page }) => {
  test.setTimeout(120_000);
  await openScratch(page, `scroll538-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // Long enough that scrolling moves the active heading repeatedly — the state updates this pins are the
  // ones a real reader triggers, not an artificial single change.
  const doc = Array.from({ length: 40 }, (_, i) => `## Heading ${i}\n\npara ${i} text\n`).join("\n");
  await page.evaluate((text) => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
    const v = (el?.cmView?.view ?? el?.cmTile?.view) as { state: { doc: { length: number } }; dispatch(t: unknown): void };
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
  }, doc);
  await sleep(1200);

  const before = await page.evaluate(() => (window as unknown as { __editorRenders?: number }).__editorRenders ?? -1);
  expect(before, "the dev render probe is present").toBeGreaterThanOrEqual(0);
  for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 400); await sleep(120) }
  await sleep(600);
  const after = await page.evaluate(() => (window as unknown as { __editorRenders?: number }).__editorRenders ?? -1);

  expect(after - before, `ten scroll steps re-rendered the editor ${after - before} times`).toBe(0);
});
