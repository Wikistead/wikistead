import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { enterEdit, FGA, openScratch, setPublicSurface, sleep, WEB } from "../helpers";

// #313: hover-copy anchor links on headings + #<slug> deep links, in a REAL browser with a REAL
// clipboard (context clipboard permissions). Three surfaces: the member CM surface (widget button),
// the /p/:id#slug landing (band-aware TOC jump), and the public reader (DOM button + /pub landing).
// Slugs are GitHub-style and Unicode-preserving (Japanese headings must get distinct anchors).

const repoEnv = readFileSync(fileURLToPath(new URL("../../../.env.e2e.local", import.meta.url)), "utf8");
const STORE = /OPENFGA_STORE_ID=(.+)/.exec(repoEnv)![1]!.trim();
const MODEL = /OPENFGA_MODEL_ID=(.+)/.exec(repoEnv)![1]!.trim();

async function makePublic(pageId: string) {
  const res = await fetch(`${FGA}/stores/${STORE}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      writes: { tuple_keys: [{ user: "user:*", relation: "view_base", object: `page:${pageId}` }] },
      authorization_model_id: MODEL,
    }),
  });
  if (!res.ok) throw new Error(`fga write failed: ${res.status} ${await res.text()}`);
}

const FILLER = Array.from({ length: 30 }, (_, i) => `filler paragraph ${i}`).join("\n\n");
const DOC = `# Top Title\n\n${FILLER}\n\n## 対象見出し\n\ntarget body\n\n${FILLER}\n`;
const SLUG = "対象見出し";

// The CM band clearance: the editor content's padding-top (--wks-band-h) — a landed heading must
// sit below it (the #304 geometry), i.e. its top ≥ (content box top + bandH) - tolerance.
async function cmBandPx(page: Page): Promise<number> {
  return page.evaluate(() => parseFloat(getComputedStyle(document.querySelector("[data-pane=preview] .cm-content")!).paddingTop) || 0);
}

async function authorAndPublish(page: Page, title: string): Promise<string> {
  const id = await openScratch(page, title);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(DOC);
  await sleep(400);
  await page.getByTestId("publish-page").click();
  await sleep(800); // publish flush
  return id;
}

test("#313 member surface: hovering a heading reveals 🔗; click copies /p/:id#slug (Unicode slug)", async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const id = await authorAndPublish(page, "anchor-copy");

  // Back on the read-only view surface: hover the heading line → the anchor button becomes visible.
  // (The TOP heading — a line deep in the doc may be outside CM's rendered viewport.)
  const line = page.locator(".cm-line", { hasText: "Top Title" }).first();
  const btn = line.locator("[data-testid=heading-anchor-copy]");
  await expect(btn).toHaveCount(1);
  await expect.poll(async () => btn.evaluate((el) => getComputedStyle(el).opacity)).toBe("0"); // hidden until hover
  await line.hover();
  await expect.poll(async () => btn.evaluate((el) => getComputedStyle(el).opacity)).toBe("1"); // revealed on line hover

  await btn.click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(`${WEB}/p/${id}#top-title`);
  // never the transient query (?edit=1 / ?diff=) — an anchor must not force a mode on the receiver
  expect(copied).not.toContain("?");
});

//(review bounce): the 🔗 follows the HEADING's font size — an h1's icon is visibly larger
// than an h3's (was a fixed 14px at every level). Pinned via the icon svg's rendered height per level.
test("#313the anchor icon scales with the heading level (h1 icon > h3 icon)", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await openScratch(page, "anchor-icon-size");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Big Heading\n\nprose\n\n### Small Heading\n\nprose\n");
  await sleep(400);

  const iconMetrics = async (text: string) => {
    const line = page.locator(".cm-line", { hasText: text }).first();
    const svg = line.locator("[data-testid=heading-anchor-copy] svg");
    await expect(svg).toHaveCount(1);
    const height = (await svg.boundingBox())!.height;
    const fontSize = await svg.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)); // inherited heading size
    return { height, fontSize };
  };
  //(review bounce — the icon-position pendulum): the icon must sit ON the text, not float above it
  // NOR drop below the baseline into the descender, NOR sit too far right. Measure the icon svg vs the heading
  // TEXT glyph box (a Range over the text run, excluding the widget) and pin all three, so a nudge in either
  // direction re-fails. Both surfaces use the same seat (vertical-align: baseline).
  const geom = await page.evaluate(() => {
    const line = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent?.includes("Big Heading"))!;
    const svg = line.querySelector("[data-testid=heading-anchor-copy] svg")!.getBoundingClientRect();
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node: Node | null = null; while ((node = walker.nextNode())) { if (node.textContent?.includes("Big Heading")) break; }
    const r = document.createRange(); r.selectNodeContents(node!); const tr = r.getBoundingClientRect();
    const fs = parseFloat(getComputedStyle(line as Element).fontSize);
    return { svg: { top: svg.top, bottom: svg.bottom, left: svg.left }, text: { top: tr.top, right: tr.right }, fs };
  });
  // no TOP overflow: the icon top does not clear the heading text-box top.
  expect(geom.svg.top, `icon top ${geom.svg.top} ≥ text top ${geom.text.top}`).toBeGreaterThanOrEqual(geom.text.top - 0.5);
  // no BOTTOM overflow: the icon bottom rests at/above the baseline (≤ the em-box bottom = text.top + font-size).
  // The old -0.1em nudge dropped it a further ~5px into the descender (bottom ≈ text.top + 1.13×fs) → this fails.
  expect(geom.svg.bottom, `icon bottom ${geom.svg.bottom} ≤ baseline≈${geom.text.top + geom.fs}`).toBeLessThanOrEqual(geom.text.top + geom.fs);
  // not too far RIGHT: the gap from the last glyph to the icon is ≤ 0.2em.
  expect(geom.svg.left - geom.text.right, `right gap ${(geom.svg.left - geom.text.right).toFixed(1)}px ≤ 0.2em (${(geom.fs * 0.2).toFixed(1)}px)`).toBeLessThanOrEqual(geom.fs * 0.2);
  const h1 = await iconMetrics("Big Heading");
  const h3 = await iconMetrics("Small Heading");
  expect(h1.height, `h1 icon ${h1.height}px should be larger than a fixed 14px`).toBeGreaterThan(20);
  expect(h1.height, `h1 icon ${h1.height}px vs h3 icon ${h3.height}px`).toBeGreaterThan(h3.height * 1.2);
  //(review bounce): the icon is at most CAP height (≤ font-size × 0.85), not a full 1em square
  // that overshoots the glyph tops. A 1em icon (height ≈ font-size × 1.0) fails this.
  expect(h1.height, `h1 icon ${h1.height}px ≤ cap (font-size ${h1.fontSize}px × 0.85)`).toBeLessThanOrEqual(h1.fontSize * 0.85);
  expect(h3.height, `h3 icon ${h3.height}px ≤ cap (font-size ${h3.fontSize}px × 0.85)`).toBeLessThanOrEqual(h3.fontSize * 0.85);
});

test("#313 deep link: /p/:id#slug lands the heading below the band; unknown slug stays at top", async ({ browser }) => {
  const ctx = await browser.newContext();
  const author = await ctx.newPage();
  const id = await authorAndPublish(author, "anchor-landing");

  // (a) a FRESH page-load of the anchor URL scrolls to the heading (the shared-link case)
  const page = await ctx.newPage();
  await page.goto(`/p/${id}#${encodeURIComponent(SLUG)}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await expect.poll(() => page.evaluate(() => document.querySelector("[data-pane=preview] .cm-scroller")!.scrollTop), { timeout: 8000 }).toBeGreaterThan(100);
  const bandH = await cmBandPx(page);
  const line = page.locator(".cm-line", { hasText: "対象見出し" }).first();
  const top = (await line.boundingBox())!.y;
  const boxTop = (await page.locator("[data-pane=preview] .cm-scroller").boundingBox())!.y;
  expect(top, "heading under the frosted band").toBeGreaterThanOrEqual(boxTop + bandH - 8);
  expect(top, "heading near the viewport top (landed)").toBeLessThanOrEqual(boxTop + bandH + 120);

  // (b) an unknown slug is NOT an error — the page just stays at the top
  const page2 = await ctx.newPage();
  await page2.goto(`/p/${id}#no-such-anchor`);
  await page2.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(1200);
  expect(await page2.evaluate(() => document.querySelector("[data-pane=preview] .cm-scroller")!.scrollTop)).toBe(0);

  // (c) a FRAGMENT navigation /p/x → /p/x#slug — no reload, hashchange only) lands too
  await page2.goto(`/p/${id}#${encodeURIComponent(SLUG)}`);
  await expect.poll(() => page2.evaluate(() => document.querySelector("[data-pane=preview] .cm-scroller")!.scrollTop), { timeout: 8000 }).toBeGreaterThan(100);
});

test("#313 TOC click reflects the heading in the URL hash (replaceState, no history spam)", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const id = await authorAndPublish(page, "anchor-toc-hash");
  // Wide enough for the RAIL, which is the variant with clickable items. 1360 was not: the rail's fit
  // is decided by the CONTAINER, not the viewport (`railFitsIn` — `w/2 - 370 - 32 >= 210`, so ≥1224px
  // of container), and with the sidebar open a 1360px window leaves 1100. Below that the OVERLAY shows
  // instead, and the overlay is `opacity: 0` until the reader scrolls — it peeks, it does not sit there.
  // Measured: the item was present, `fixed z-30`, and `elementFromPoint` at its centre returned
  // `.cm-scroller`, so the click retried for the full 60s against something nobody can see. 1900 is the
  // width `toc-rail-fit-593` uses for the same reason.
  await page.setViewportSize({ width: 1900, height: 900 });
  await page.goto(`/p/${id}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.getByTestId("toc-item").filter({ hasText: "対象見出し" }).first().click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#${encodeURIComponent(SLUG)}`);
});

test("#313 public reader: heading 🔗 copies /pub/:id#slug and the anchor URL lands for an anonymous visitor", async ({ browser }) => {
  const authed = await (await browser.newContext()).newPage();
  const id = await authorAndPublish(authed, "anchor-public");
  await makePublic(id);
  await setPublicSurface(authed, true);

  const anonCtx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const anon = await anonCtx.newPage();

  // (a) copy from the public reader's heading — #319: the CM `headingAnchors` extension (member parity) puts
  // the 🔗 button on the heading LINE (.cm-lp-h2), and headingAnchorUrl uses origin+pathname → /pub/:id#slug.
  await anon.goto(`/pub/${id}`);
  await anon.waitForSelector("[data-testid=public-body] .cm-content");
  // #319: the CM read surface VIRTUALIZES — this heading is deep in the doc (30 filler paragraphs above), so
  // scroll the CM scroller down until it mounts (a reader scrolls to it too), then its anchor widget renders.
  const scroller = anon.locator("[data-testid=public-body] .cm-scroller");
  const h2 = anon.getByTestId("public-body").locator(".cm-lp-h2", { hasText: "対象見出し" });
  await expect.poll(async () => {
    await scroller.evaluate((el) => { el.scrollTop = Math.min(el.scrollTop + 500, el.scrollHeight); });
    return h2.count();
  }, { timeout: 10000 }).toBeGreaterThan(0);
  await expect(h2).toBeVisible();
  const btn = h2.locator("[data-testid=heading-anchor-copy]");
  await expect(btn).toHaveCount(1);
  await h2.hover();
  await expect.poll(async () => btn.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await btn.click();
  expect(await anon.evaluate(() => navigator.clipboard.readText())).toBe(`${WEB}/pub/${id}#${encodeURIComponent(SLUG)}`);

  // (b) the anchor URL lands the anonymous visitor on the heading (below the public band
  // scroll-margin-top clearance, #304 geometry)
  const anon2 = await (await browser.newContext()).newPage();
  await anon2.goto(`/pub/${id}#${encodeURIComponent(SLUG)}`);
  await expect(anon2.getByTestId("public-body")).toBeVisible();
  await expect.poll(async () => (await anon2.getByTestId("public-body").locator(".cm-lp-h2", { hasText: "対象見出し" }).boundingBox())!.y, { timeout: 8000 }).toBeLessThan(400);
  const bandBottom = await anon2.evaluate(() => document.querySelector("[data-testid=public-band]")!.getBoundingClientRect().bottom);
  const hTop = (await anon2.getByTestId("public-body").locator(".cm-lp-h2", { hasText: "対象見出し" }).boundingBox())!.y;
  expect(hTop, "public heading under the band").toBeGreaterThanOrEqual(bandBottom - 40); // pb-6 fade zone overlaps a little
});
