import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, publishAndWait, sleep } from "../helpers";

// #457: a page that is still fetching used to look exactly like a page with nothing in it. Now loading
// draws an animated skeleton and a resolved-but-blank page says so in words. The skeleton is gated by a
// delay so a fast load never flashes it, it stops animating under prefers-reduced-motion, and it occupies
// the reading column so the real prose lands where the bars were.

// Slow the published-body response so the loading window is observable.
async function delayPublished(page: Page, ms: number) {
  await page.route("**/pages/*/published*", async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
}

test("#457: a slow load shows the animated skeleton, then the real content replaces it", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const id = await openScratch(page, `skeleton457-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Real heading\n\nreal published body\n");
  await sleep(500);
  await publishAndWait(page, id, "real published body");

  await delayPublished(page, 2500);
  await page.goto(`/p/${id}`);

  const ph = page.getByTestId("body-placeholder");
  await expect(ph, "the body is not blank while it loads").toBeVisible({ timeout: 8000 });
  await expect(ph).toHaveAttribute("data-state", "loading");
  await expect(page.getByTestId("prose-skeleton")).toBeVisible();
  // it animates (motion convention: surface-only pulse)
  const anim = await page.getByTestId("skeleton-bar").first().evaluate((el) => getComputedStyle(el).animationName);
  expect(anim, "the skeleton pulses").not.toBe("none");
  // it does not swallow clicks meant for the surface underneath
  expect(await ph.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");

  // …and the real content replaces it
  await expect(page.locator("[data-pane=preview] .cm-content")).toContainText("real published body", { timeout: 15000 });
  await expect(page.getByTestId("prose-skeleton")).toHaveCount(0);
});

test("#457the loading overlay is OPAQUE and fully covers the editor (no skeleton/body overlap)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const id = await openScratch(page, `skeleton457-cover-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Cover heading\n\ncover body should be hidden while loading\n");
  await sleep(500);
  await publishAndWait(page, id, "cover body should be hidden");

  await delayPublished(page, 2500);
  await page.goto(`/p/${id}`);

  const ph = page.getByTestId("body-placeholder");
  await expect(ph, "the overlay is up while the body loads").toBeVisible({ timeout: 8000 });
  await expect(ph).toHaveAttribute("data-state", "loading");

  // (1) the overlay paints an OPAQUE page background (alpha === 1). A transparent overlay is exactly the
  //regression: the mounted Editor shows through and the skeleton + real body overlap.
  const bg = await ph.evaluate((el) => getComputedStyle(el).backgroundColor);
  const alpha = (() => {
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1; // a named/opaque colour with no alpha channel
    const parts = m[1].split(",").map((s) => s.trim());
    return parts.length === 4 ? Number(parts[3]) : 1;
  })();
  expect(alpha, `the loading overlay is opaque (bg=${bg})`).toBe(1);

  // (2) it COVERS the editor pane vertically (inset-0 within the shared relative container), so nothing
  // the editor paints underneath is visible until the overlay is removed on resolve.
  const boxes = await page.evaluate(() => {
    const el = document.querySelector("[data-testid=body-placeholder]") as HTMLElement | null;
    const pane = document.querySelector("[data-pane=preview]") as HTMLElement | null;
    if (!el || !pane) return null;
    const p = el.getBoundingClientRect(); const c = pane.getBoundingClientRect();
    return { pTop: p.top, pBottom: p.bottom, cTop: c.top, cBottom: c.bottom };
  });
  expect(boxes, "overlay and editor pane are both present").not.toBeNull();
  expect(boxes!.pTop, "overlay starts at/above the editor pane top").toBeLessThanOrEqual(boxes!.cTop + 1);
  expect(boxes!.pBottom, "overlay reaches the editor pane bottom (inset-0, not just top-0)").toBeGreaterThanOrEqual(boxes!.cBottom - 1);

  // …and it clears on resolve, revealing the real content (no lingering overlay).
  await expect(page.locator("[data-pane=preview] .cm-content")).toContainText("cover body should be hidden", { timeout: 15000 });
  await expect(ph).toHaveCount(0);
});

test("#457: a genuinely empty page says it is empty — not a skeleton, not a blank surface", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const id = await openScratch(page, `skeleton457-empty-${Date.now()}`);
  await page.goto(`/p/${id}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const empty = page.getByTestId("page-empty");
  await expect(empty, "an unwritten page states it is empty").toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("body-placeholder")).toHaveAttribute("data-state", "empty");
  await expect(page.getByTestId("prose-skeleton"), "empty is NOT the loading state").toHaveCount(0);
});

test("#457: a fast load never flashes the skeleton (the delay gate)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const id = await openScratch(page, `skeleton457-fast-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("fast body text\n");
  await sleep(500);
  await publishAndWait(page, id, "fast body text");

  // Watch for the skeleton across the whole load — a 50ms response must never render it.
  await page.goto(`/p/${id}`);
  let flashed = false;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await page.getByTestId("prose-skeleton").count()) { flashed = true; break; }
    await sleep(40);
  }
  expect(flashed, "no skeleton flash on a fast load").toBe(false);
  await expect(page.locator("[data-pane=preview] .cm-content")).toContainText("fast body text");
});

test("#457: prefers-reduced-motion stops the animation (static placeholder)", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const id = await openScratch(page, `skeleton457-rm-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("reduced motion body\n");
  await sleep(500);
  await publishAndWait(page, id, "reduced motion body");

  await delayPublished(page, 2500);
  await page.goto(`/p/${id}`);
  await expect(page.getByTestId("prose-skeleton")).toBeVisible({ timeout: 8000 });
  const anim = await page.getByTestId("skeleton-bar").first().evaluate((el) => getComputedStyle(el).animationName);
  expect(anim, "no pulse under reduced motion — a static placeholder").toBe("none");
});

test("#457: replacing the skeleton with prose does not shift the body", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const id = await openScratch(page, `skeleton457-shift-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Heading here\n\nbody paragraph\n");
  await sleep(500);
  await publishAndWait(page, id, "body paragraph");

  await delayPublished(page, 2500);
  await page.goto(`/p/${id}`);
  await expect(page.getByTestId("prose-skeleton")).toBeVisible({ timeout: 8000 });
  const skeletonTop = await page.getByTestId("skeleton-bar").first().evaluate((el) => Math.round(el.getBoundingClientRect().top));

  await expect(page.locator("[data-pane=preview] .cm-content")).toContainText("body paragraph", { timeout: 15000 });
  await sleep(400);
  const proseTop = await page.locator("[data-pane=preview] .cm-content").evaluate((el) => {
    const first = el.firstElementChild as HTMLElement | null;
    return Math.round((first ?? el).getBoundingClientRect().top);
  });
  expect(Math.abs(proseTop - skeletonTop), `content starts where the skeleton did (skeleton ${skeletonTop}, prose ${proseTop})`).toBeLessThanOrEqual(12);
});
