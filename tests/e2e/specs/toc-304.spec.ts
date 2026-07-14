import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #304 + #345 the member editor's TOC rail scroll-spy, now a TWO-LAYER highlight. (1) A jumped-to heading
// is the CURRENT (dark, data-active) item under a TALL (2-line) band. (2 → #345) The old bottom CLAMP is gone: a
// short final section is covered by the LIGHT layer (data-visible = on screen) instead of being forced dark. (4)
// The rail grows into the right whitespace. Real Chromium, wide viewport, a deliberately LONG page title.
const LONG_TITLE = "A deliberately very long page title that wraps onto two lines in the frosted header band";

test("#304/#345: TOC jump = dark active under a 2-line band; the short last section is LIGHT-visible; elastic rail", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 720 } })).newPage();
  await openScratch(page, LONG_TITLE);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  const filler = (n: string) => Array.from({ length: 20 }, (_, i) => `${n} paragraph ${i} lorem ipsum dolor sit amet consectetur.`).join("\n\n");
  await page.keyboard.insertText(
    `# Alpha Heading\n\n${filler("A")}\n\n# Bravo Heading\n\n${filler("B")}\n\n# Charlie Heading\n\n${filler("C")}\n\n# Delta Heading\n\nshort tail\n`,
  );
  await sleep(600);

  // the band wrapped to (at least) 2 lines → taller than the old fixed 48px sample offset.
  const bandH = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".cm-content")!).paddingTop) || 0);
  expect(bandH, `band height ${bandH} should exceed the old 48px sampler`).toBeGreaterThan(48);

  const rail = page.locator("[data-testid=toc][data-variant=rail]");
  await expect(rail).toBeVisible({ timeout: 8000 });
  const items = rail.getByTestId("toc-item");
  await expect(items).toHaveCount(4);

  // (4) elastic width — grows past the old fixed 210px in the wide right whitespace.
  const railW = await rail.evaluate((el) => el.getBoundingClientRect().width);
  expect(railW, `rail width ${railW} should exceed the old fixed 210px`).toBeGreaterThan(210);

  // (1) click "Charlie" → THE CLICKED item is the dark active (not Bravo, the old off-by-one under a tall band).
  // #345: jump-intent — Charlie stays active through the programmatic jump scroll (only a real user scroll moves it).
  await items.nth(2).click();
  await sleep(500);
  await expect(items.nth(2)).toHaveAttribute("data-active", "");
  await expect(items.nth(1)).not.toHaveAttribute("data-active", "");

  // (2 → #345) scroll to the very bottom (a REAL wheel releases the jump pin) → the short final section
  // ("Delta") is on screen, so it's LIGHT-visible (data-visible). The dark clamp is gone.
  await page.locator(".cm-scroller").evaluate((el) => {
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true })); // user-scroll intent → release the jump pin
    el.scrollTop = el.scrollHeight;
  });
  await sleep(400);
  await expect(items.nth(3)).toHaveAttribute("data-visible", "");

  // (3 → #345) click the SHORT final section ("Delta") → jump-intent lights IT (dark), not a neighbour.
  // The old clamp/sample would light the last item on any bottom scroll; here the CLICKED item is pinned dark.
  await items.nth(3).click();
  await sleep(500);
  await expect(items.nth(3)).toHaveAttribute("data-active", "");
  await expect(items.nth(2)).not.toHaveAttribute("data-active", "");
});

// #345 the two-layer highlight was imperceptible — the LIGHT set spanned only ~1 item (a narrow band→80%
// sample range) AND its colour (`text-foreground/80`) was grey-vs-grey with idle. Now the visible set covers the
// WHOLE on-screen area (≥2 short sections light at once) and the light tier is legibly distinct from idle.
test("#345 several on-screen sections are LIGHT-visible with a legible contrast vs idle", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 780 } })).newPage();
  await openScratch(page, "toc-visible-layers");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // Many SHORT sections so several are on screen at once (the tall-section case only ever shows 1).
  await page.keyboard.insertText(Array.from({ length: 9 }, (_, i) => `# Section ${i + 1}\n\npara ${i} lorem ipsum dolor sit amet.`).join("\n\n") + "\n");
  await sleep(700);
  const rail = page.locator("[data-testid=toc][data-variant=rail]");
  await expect(rail).toBeVisible({ timeout: 8000 });
  const items = rail.getByTestId("toc-item");
  await expect(items).toHaveCount(9);
  await sleep(400); // let the initial scroll-spy compute run

  // The full on-screen span lights ≥2 sections (not the old ~1).
  const visibleCount = await items.evaluateAll((els) => els.filter((e) => e.hasAttribute("data-visible")).length);
  expect(visibleCount, `light-visible section count ${visibleCount} should be ≥2 (whole on-screen span, not ~1)`).toBeGreaterThanOrEqual(2);

  // A LIGHT (visible, non-active) item is legibly distinct from an IDLE (off-screen) one — different text colour
  // AND a visible-tier background wash (the contrast fix; the old grey-vs-grey read as "nothing changed").
  const contrast = await items.evaluateAll((els) => {
    const light = els.find((e) => e.hasAttribute("data-visible") && !e.hasAttribute("data-active"));
    const idle = els.find((e) => !e.hasAttribute("data-visible") && !e.hasAttribute("data-active"));
    if (!light || !idle) return null;
    const lc = getComputedStyle(light), ic = getComputedStyle(idle);
    return { lightColor: lc.color, idleColor: ic.color, lightBg: lc.backgroundColor };
  });
  expect(contrast, "there is both a light and an idle item to compare").not.toBeNull();
  expect(contrast!.lightColor, "the light item's text colour differs from idle").not.toBe(contrast!.idleColor);
  expect(contrast!.lightBg, "the light item carries a background wash (idle has none)").not.toBe("rgba(0, 0, 0, 0)");
});

// #345 Issue B: when the page opens with a top INTRO (no heading at the very top) but headings on screen
// below it, the old sampler left BOTH layers empty (active null: no heading above the band; visible empty: the
// window sat before the first heading) → "nothing is highlighted". Now the active layer FALLS BACK to the
// topmost on-screen heading, so a visible heading is never unlit.
test("#345 Issue B: a heading below a top intro still lights (active falls back to the topmost visible)", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 720 } })).newPage();
  await openScratch(page, "toc-intro-fallback");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // A few intro paragraphs BEFORE the first heading (so the band-top sample lands in the intro, above heading 1),
  // then headings that are still on screen at the top.
  const intro = Array.from({ length: 6 }, (_, i) => `Intro paragraph ${i} lorem ipsum dolor sit amet consectetur adipiscing.`).join("\n\n");
  await page.keyboard.insertText(`${intro}\n\n# First Heading\n\nbody one\n\n# Second Heading\n\nbody two\n\n# Third Heading\n\nbody three\n`);
  await sleep(600);
  const rail = page.locator("[data-testid=toc][data-variant=rail]");
  await expect(rail).toBeVisible({ timeout: 8000 });
  const items = rail.getByTestId("toc-item");
  await expect(items).toHaveCount(3);
  // land at the very top (a real wheel releases any jump pin), where the intro occupies the band-top sample.
  await page.locator(".cm-scroller").evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { bubbles: true })); el.scrollTop = 0; });
  await sleep(400);
  // At least one item is highlighted (the reported bug was ZERO), and the first heading — the topmost on-screen —
  // is the dark active via the fallback, not left unlit.
  const anyHi = await items.evaluateAll((els) => els.filter((e) => e.hasAttribute("data-active") || e.hasAttribute("data-visible")).length);
  expect(anyHi, "a visible heading must not be left unlit under a top intro").toBeGreaterThanOrEqual(1);
  await expect(items.nth(0)).toHaveAttribute("data-active", "");
});

// #345 Issue A: the narrow-screen OVERLAY TOC now also gets the light (data-visible) layer — it was
// rail-only (TocChrome passed visibleFroms only to the rail). Real Chromium, narrow viewport, scroll to reveal.
test("#345 Issue A: the narrow overlay TOC carries the two-layer highlight", async ({ browser }) => {
  // Set up at a WIDE viewport (the edit toggle lives in the header chrome), then narrow to force the overlay.
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 720 } })).newPage();
  await openScratch(page, "toc-overlay-visible");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(Array.from({ length: 9 }, (_, i) => `# Section ${i + 1}\n\npara ${i} lorem ipsum dolor sit amet.`).join("\n\n") + "\n");
  await sleep(400);
  await page.setViewportSize({ width: 680, height: 720 }); // narrow → the overlay variant replaces the rail
  await sleep(400);
  // The overlay renders while scrolling; a wheel both reveals it and drives the visible-set compute.
  await page.locator(".cm-scroller").evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { bubbles: true })); el.scrollTop = el.scrollHeight / 3; });
  await sleep(400);
  const overlay = page.locator("[data-testid=toc][data-variant=overlay]");
  await expect(overlay).toBeAttached({ timeout: 8000 });
  const items = overlay.getByTestId("toc-item");
  const visibleCount = await items.evaluateAll((els) => els.filter((e) => e.hasAttribute("data-visible")).length);
  expect(visibleCount, "the overlay TOC receives the light-visible layer (was rail-only)").toBeGreaterThanOrEqual(1);
});

// #345 Issue 1: on a long TOC the rail auto-follows the highlight so the active item never scrolls out of
// the rail as the reader nears the bottom (the old single-active centring dropped it off).
test("#345 the rail follows the highlight to the bottom — the active item stays visible", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 520 } })).newPage();
  await openScratch(page, "toc-follow-bottom");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  const body = Array.from({ length: 16 }, (_, i) => `# Section ${i + 1}\n\n${Array.from({ length: 6 }, (_, j) => `para ${i}.${j} lorem ipsum dolor sit amet.`).join("\n\n")}`).join("\n\n");
  await page.keyboard.insertText(body + "\n");
  await sleep(700);
  const rail = page.locator("[data-testid=toc][data-variant=rail]");
  await expect(rail).toBeVisible({ timeout: 8000 });
  // the rail must actually overflow for the follow to matter.
  expect(await rail.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  await page.locator(".cm-scroller").evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { bubbles: true })); el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.95; });
  await sleep(400);
  const r = await rail.evaluate((nav) => {
    const active = nav.querySelector("[data-testid=toc-item][data-active]") as HTMLElement | null;
    if (!active) return { hasActive: false, inView: false };
    const nr = nav.getBoundingClientRect(), ar = active.getBoundingClientRect();
    return { hasActive: true, inView: ar.top >= nr.top - 1 && ar.bottom <= nr.bottom + 1 };
  });
  expect(r.hasActive, "an active heading is lit near the bottom (not 'none')").toBe(true);
  expect(r.inView, "the active item is scrolled into the rail's own viewport (follow)").toBe(true);
});

// #345 Issue 3: hovering the narrow-screen overlay TOC holds it open (it no longer fades from under the
// reader after the ~1.2s scroll timeout).
test("#345 hovering the overlay TOC holds it open past the fade timeout", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 720 } })).newPage();
  await openScratch(page, "toc-overlay-hover");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(Array.from({ length: 10 }, (_, i) => `# Section ${i + 1}\n\npara ${i} lorem ipsum dolor.`).join("\n\n") + "\n");
  await sleep(400);
  await page.setViewportSize({ width: 680, height: 720 }); // narrow → overlay
  await sleep(400);
  await page.locator(".cm-scroller").evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { bubbles: true })); el.scrollTop = 200; });
  await sleep(200);
  const overlay = page.locator("[data-testid=toc][data-variant=overlay]");
  await expect(overlay).toBeAttached({ timeout: 8000 });
  // hover it, then wait PAST the 1.2s fade — it must stay visible (opacity 1) while hovered.
  await overlay.hover();
  await sleep(1500);
  const opacity = await overlay.evaluate((el) => getComputedStyle(el).opacity);
  expect(Number(opacity), "the overlay stays opaque while hovered (no fade-out)").toBeGreaterThan(0.9);
});
