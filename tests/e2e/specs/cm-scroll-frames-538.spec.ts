import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #538 the jank the user felt was NOT the page scroll (already 0 re-renders) but wheeling over
// the EDITOR — the `.cm-scroller` path. The profile named it: the route holds the TOC's
// visibleHeadings state, so every editor scroll tick re-rendered the route, and react-arborist's
// componentDidUpdate (the sidebar tree, whose props had not changed) was the long-frame cost. The fix
// memoizes the prop-less Sidebar; this pin holds the frame clock on the reviewer's exact fixture shape
// (heading sections + a 45×12 table) and measurement (wheel the cm-scroller, count long frames).
//
// Thresholds per the reject: >100ms frames must be ZERO; >50ms ones — bounded at 3 for the
// shared box's load spikes (measured post-fix: 0 and 0 on dev, three runs).
const SECTIONS = 20;
const table = () => {
  const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const lines = [row(Array.from({ length: 12 }, (_, c) => `H${c}`)), row(Array.from({ length: 12 }, () => "---"))];
  for (let r = 0; r < 45; r++) lines.push(row(Array.from({ length: 12 }, (_, c) => `r${r}c${c}`)));
  return lines.join("\n");
};
const DOC = Array.from({ length: SECTIONS }, (_, i) => `## Section ${i}\n\nSome paragraph text for section ${i}.\n`).join("\n") + "\n" + table() + "\n";

test("#538: wheeling the editor's own scroller never blocks a frame past 100ms", async ({ page }) => {
  test.setTimeout(240_000);
  await openScratch(page, `s538-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content >> nth=0");
  await page.keyboard.insertText(DOC);
  await sleep(3000); // widgets settle (the table renders async)

  const scroller = page.locator(".cm-scroller").first();
  const box = (await scroller.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[] };
    w.__frames = [];
    let last = performance.now();
    const loop = (t: number) => { w.__frames.push(t - last); last = t; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  await sleep(300); // let the sampler settle so its own start is not the first frame
  await page.evaluate(() => { (window as unknown as { __frames: number[] }).__frames.length = 0; });

  for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 240); await page.waitForTimeout(60); }
  for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(60); }

  const frames = await page.evaluate(() => (window as unknown as { __frames: number[] }).__frames);
  const over100 = frames.filter((f) => f > 100).length;
  const over50 = frames.filter((f) => f > 50).length;
  const sorted = [...frames].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const detail = `frames=${frames.length} p95=${p95.toFixed(0)}ms max=${Math.max(...frames).toFixed(0)}ms >50ms=${over50} >100ms=${over100}`;
  expect(frames.length, "the sampler ran").toBeGreaterThan(100);
  expect(over100, `no frame past 100ms — ${detail}`).toBe(0);
  expect(over50, `long frames stay rare — ${detail}`).toBeLessThanOrEqual(3);
});
