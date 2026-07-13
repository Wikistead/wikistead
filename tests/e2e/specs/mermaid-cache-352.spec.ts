import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { enterEdit, openScratch, sleep } from "../helpers";

// The standing QA torture body — 4 mermaid diagrams among long content, the exact fixture the review
// probe used.
const TORTURE = readFileSync(fileURLToPath(new URL("../fixtures/torture-page.md", import.meta.url)), "utf8");

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

// #352 the review found the TOP diagram missing the cache EVERY round-trip (id 4→7→8) — a paint
// that ran while the widget was momentarily width-0 rendered a valid SVG but never cached it (the store keyed on
// `el.clientWidth` read AFTER the async render, which a fast scroll had dropped to 0). Fix: store any real-width
// render, keyed on the width we rendered AT. Pin it with the real torture body across TWO round-trips: the top
// diagram's id must be STABLE on the 2nd trip (no new render), not just the 1st.
test("#352 the top mermaid caches across TWO round-trips (torture body, no per-trip re-render)", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1310, height: 940 } })).newPage();
  await openScratch(page, "mermaid-torture");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // A known diagram at the very TOP (the permanent-miss was the top diagram), then the real torture body
  // below to give the scroll distance that virtualizes the top one out and back.
  // A leading text line so Control+Home lands OUTSIDE the fence (a caret on the fence line reveals raw source).
  await page.keyboard.insertText("intro\n```mermaid\nflowchart TD\n  A[Top] --> B[Diagram]\n```\n\n" + TORTURE);
  await page.keyboard.press("Control+Home");
  await sleep(1500); // let the top diagram render
  const scroller = page.locator("[data-pane=preview] .cm-scroller");
  const topId = () => page.locator("[data-pane=preview] [data-testid=macro-mermaid] svg").first().getAttribute("id");
  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid] svg").first()).toBeVisible({ timeout: 15000 });

  const roundTrip = async () => {
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await sleep(700);
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await sleep(900);
    await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid] svg").first()).toBeVisible({ timeout: 15000 });
    return topId();
  };

  const afterRT1 = await roundTrip(); // the first trip may legitimately render once (fills the cache)
  const afterRT2 = await roundTrip(); // ...but the SECOND must be a pure cache hit — the same id
  expect(afterRT2).toBe(afterRT1); // stable id ⇒ no re-render on the 2nd round-trip (the permanent-miss gone)
});
