import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, publishAndWait, sleep } from "../helpers";

// #345Lezer parses LAZILY — on a FRESH LOAD (no enterEdit; the state every reader lands in)
// `syntaxTree()` covered only the initially displayed range, so a long published page's TOC was
// truncated (18 of 30 headings) and scrolling past the last known heading blanked the highlight
// (active AND visible empty → "the highlight stops following"). Every earlier spec drove the page
// through enterEdit, which forces a full parse — the false-green this spec closes: it reloads the
// published page and reads it WITHOUT entering edit.

const HEADINGS = 30;

test("#345a fresh-loaded long page has the FULL TOC and the highlight follows to the bottom", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 800 } })).newPage();
  const id = await openScratch(page, "toc-freshload");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  let content = "";
  for (let i = 1; i <= HEADINGS; i++) content += `## Heading ${i}\n\n` + "Lorem ipsum dolor sit amet consectetur adipiscing. ".repeat(10) + "\n\n";
  await page.keyboard.insertText(content);
  await sleep(1200);
  await publishAndWait(page, id, `Heading ${HEADINGS}`);

  // FRESH LOAD: reload and read WITHOUT entering edit — the lazy-parse state.
  await page.reload({ waitUntil: "networkidle" });
  await sleep(2500); // give the settle re-extraction its window (bounded retries in headingsExtension)

  // The TOC rail lists ALL headings (not the truncated lazy-parse prefix).
  const items = page.locator("nav").filter({ hasText: "Heading 1" }).first().locator("button");
  await expect(items, "the TOC carries every heading on a fresh load").toHaveCount(HEADINGS, { timeout: 8000 });

  // Scroll the CONTENT to the very bottom → the highlight must still be lit (active non-empty) and
  // point at a late heading; the visible layer must be non-empty too.
  await page.evaluate(() => {
    const s = document.querySelector(".cm-scroller") as HTMLElement | null;
    if (s) s.scrollTop = s.scrollHeight;
  });
  await sleep(800);
  const state = await page.evaluate(() => {
    const nav = [...document.querySelectorAll("nav")].find((n) => (n.textContent || "").includes("Heading 30"));
    if (!nav) return null;
    const act = nav.querySelector("[data-active]");
    return { active: act?.textContent ?? null, visible: nav.querySelectorAll("[data-visible]").length };
  });
  expect(state, "the TOC nav exists").not.toBeNull();
  expect(state!.active, "active stays lit at the very bottom").not.toBeNull();
  const n = Number(/Heading (\d+)/.exec(state!.active ?? "")?.[1] ?? 0);
  expect(n, "the active item is a LATE heading (not a truncation artifact)").toBeGreaterThanOrEqual(HEADINGS - 3);
  expect(state!.visible, "the visible layer is non-empty at the bottom").toBeGreaterThanOrEqual(1);
});
