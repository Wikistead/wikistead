import { test, expect, type Page } from "@playwright/test";
import { API, enterEdit, openScratch, sleep } from "../helpers";

// #544(user review): "the footnote back-arrows all land after a line break — can't they sit
// right after the description?" The #544 SVG swap put a trusted-constant <svg> inside the back-link — the
// ONLY icon site that is a bare inline <a> (every other site is a button, whose flex context neutralises
// this) — and Tailwind preflight's `svg { display: block }` splits an inline formatting context at a block
// child: the anchor grew to the full line width (measured: 671px, pane's right edge) and the arrow wrapped.
//
// Pinned as GEOMETRY in a real browser (happy-dom has no layout engine), on BOTH renderers (#381: the CM
// live/read surface and renderMarkdownToDom are different code paths — the print portal is the second):
// the arrow's box is icon-sized and its vertical centre sits inside the definition text's own line band.

const FIXTURE = "A note[^1] in some body text.\n\n[^1]: the description text\n";

type Geom = { back: { top: number; width: number; height: number }; text: { top: number; bottom: number } };

// Read the back-arrow's rect and the rect of the definition's own text (via a Range over the first
// non-empty text node) inside the given footnote list item.
const readGeom = (li: Element): Geom | null => {
  const back = li.querySelector(".cm-lp-footnote-back");
  if (!back) return null;
  const b = back.getBoundingClientRect();
  const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if ((t.textContent || "").trim()) {
      const r = document.createRange();
      r.selectNodeContents(t);
      const tr = r.getBoundingClientRect();
      return { back: { top: b.top, width: b.width, height: b.height }, text: { top: tr.top, bottom: tr.bottom } };
    }
  }
  return null;
};

function assertSameLine(geom: Geom | null, face: string): void {
  expect(geom, `${face}: the back link and the definition text were found`).not.toBeNull();
  // icon-sized, not "the rest of the line" (the defect measured 671px here)
  expect(geom!.back.width, `${face}: the arrow's box is icon-sized`).toBeLessThan(30);
  // and it sits ON the text's line: its vertical centre is inside the text's own band
  const centre = geom!.back.top + geom!.back.height / 2;
  expect(centre, `${face}: the arrow is not below the text's line`).toBeLessThan(geom!.text.bottom);
  expect(centre, `${face}: the arrow is not above the text's line`).toBeGreaterThan(geom!.text.top);
}

test("#544the footnote back-arrow sits on the definition's own line (both renderers)", async ({ browser }) => {
  const page: Page = await (await browser.newContext()).newPage();
  const id = await openScratch(page, `fn-back-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(FIXTURE);
  await sleep(600);
  // Publish through the API (the print portal renders the PUBLISHED body) — the toolbar button leaves
  // edit mode, and the display-mode toggle has to stay reachable for the Reading face below.
  await page.evaluate(async ({ api, pageId }) => {
    await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, pageId: id });
  await sleep(500);

  // Face 1: the live/read surface (decorations) — footnotes aggregate in Reading mode.
  await page.getByTestId("displaymode-reading").click();
  await sleep(500);
  const section = page.locator("[data-pane=preview] [data-testid=footnotes]");
  await expect(section).toBeVisible();
  const liveGeom = (await section.locator("li#fn-1").evaluate(
    (li, fn) => (new Function("return " + fn)())(li),
    readGeom.toString(),
  )) as Geom | null;
  assertSameLine(liveGeom, "live surface (Reading)");

  // Face 2: the static renderer (renderMarkdownToDom) — the print portal, visible under print media.
  await page.emulateMedia({ media: "print" });
  await sleep(300);
  const printGeom = (await page.evaluate((fn) => {
    const portal = document.querySelector("[data-print-root]");
    const li = portal?.querySelector("li#fn-1");
    return li ? (new Function("return " + fn)())(li) : null;
  }, readGeom.toString())) as Geom | null;
  assertSameLine(printGeom, "static surface (print portal)");
  await page.emulateMedia({ media: null });
});
