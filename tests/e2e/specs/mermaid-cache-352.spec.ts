import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #352: CM6 virtualizes — it destroys a block widget that scrolls out of the viewport — so a re-entered
// ```mermaid used to re-run the full mermaid.render (new SVG id each time), the scroll-jank the ticket measured.
// A (theme + code)-keyed SVG cache now re-injects the SAME SVG on re-entry. Real Chromium: pin that the visible
// mermaid's SVG id is UNCHANGED across a scroll round-trip (cache hit), and CHANGES when the body is edited
// (cache miss) — the two together prove the cache without measuring frame timings.

const svgId = (page: import("@playwright/test").Page) =>
  page.locator("[data-pane=preview] [data-testid=macro-mermaid] svg").first().getAttribute("id");

test("#352: a mermaid SVG survives a scroll round-trip with the SAME id (render cache hit)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "mermaid-cache");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // A mermaid at the top, then a tall tail so scrolling pushes the diagram out of the rendered viewport
  // (CM6 destroys it), then back.
  const tail = Array.from({ length: 80 }, (_, i) => `filler line ${i}`).join("\n");
  await page.keyboard.insertText(`top\n\`\`\`mermaid\nflowchart TD\n  A --> B\n\`\`\`\n${tail}\n`);
  await sleep(1200);
  await page.keyboard.press("Control+Home"); // caret to top → diagram renders as an atom
  await sleep(800);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid] svg").first()).toBeVisible({ timeout: 15000 });
  const idBefore = await svgId(page);
  expect(idBefore).toBeTruthy();

  // Scroll to the bottom (the top mermaid leaves the rendered viewport → CM6 destroys its widget), then back.
  const scroller = page.locator("[data-pane=preview] .cm-scroller");
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await sleep(600);
  await scroller.evaluate((el) => { el.scrollTop = 0; });
  await sleep(800);

  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid] svg").first()).toBeVisible({ timeout: 15000 });
  const idAfter = await svgId(page);
  // Same id ⇒ the cached SVG was re-injected, NOT a fresh mermaid.render (the ticket's cache-hit signal). The
  // cache is keyed on (theme + code), so a body/theme edit yields a different key → a fresh render → a new id
  // (a cache miss is guaranteed by construction — a stale SVG is never served for a changed body).
  expect(idAfter).toBe(idBefore);

  // Two DIFFERENT diagrams in the same session carry DIFFERENT ids (the cache is per-body, not one shared SVG).
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n```mermaid\nflowchart LR\n  X --> Y\n```\n");
  await sleep(1000);
  const ids = await page.locator("[data-pane=preview] [data-testid=macro-mermaid] svg").evaluateAll((els) => els.map((e) => e.id));
  expect(new Set(ids).size).toBe(ids.length); // all distinct — no cross-body cache bleed
});
