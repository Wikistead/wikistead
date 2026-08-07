import { test, expect, type Page } from "@playwright/test";
import { API, enterEdit, FGA, openDemo, openScratch, publishAndWait, sleep } from "../helpers";

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
  // it animates (motion convention: surface-only pulse). Scoped INSIDE the body skeleton: a bare
  // .first() could grab the #492 sidebar skeleton, which resolves earlier and detaches mid-check.
  const anim = await page.getByTestId("prose-skeleton").getByTestId("skeleton-bar").first().evaluate((el) => getComputedStyle(el).animationName);
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
  // Scoped inside the body skeleton (not a bare .first()): the #492 sidebar skeleton resolves earlier
  // and a detached element reads animationName as "" — a flake, not a verdict.
  const anim = await page.getByTestId("prose-skeleton").getByTestId("skeleton-bar").first().evaluate((el) => getComputedStyle(el).animationName);
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

// ── #457the remaining surfaces. The member-only pins above let a missing guest/public/panel
// skeleton sail through green — each surface gets its own pin. ──
async function shareLink(page: Page, resource: { type: string; id: string }): Promise<string> {
  const r = await page.evaluate(async ({ api, resource }) => {
    const res = await fetch(`${api}/share-links`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/json" },
      body: JSON.stringify({ resource, capability: "view", expiresInSeconds: null }),
    });
    return { status: res.status, body: (await res.json()) as { id: string } };
  }, { api: API, resource });
  expect(r.status).toBe(201);
  return r.body.id;
}

test("#457the GUEST body draws the same opaque loading overlay, then the content", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  const id = await openScratch(member, `skeleton457-guest-${Date.now()}`);
  await enterEdit(member);
  await member.click("[data-pane=preview] .cm-content");
  await member.keyboard.insertText("# Guest heading\n\nguest published body\n");
  await sleep(500);
  await publishAndWait(member, id, "guest published body");
  const linkId = await shareLink(member, { type: "page", id });

  const guest = await (await browser.newContext()).newPage();
  await delayPublished(guest, 2500);
  await guest.goto(`/share/${linkId}`);

  const ph = guest.getByTestId("body-placeholder");
  await expect(ph, "the guest body is not blank while it loads").toBeVisible({ timeout: 10000 });
  await expect(ph).toHaveAttribute("data-state", "loading");
  await expect(guest.getByTestId("prose-skeleton")).toBeVisible();
  // opaque — thelesson applies to the guest surface too (no skeleton/body overlap window)
  const bg = await ph.evaluate((el) => getComputedStyle(el).backgroundColor);
  const m = bg.match(/rgba?\(([^)]+)\)/);
  const alpha = m && m[1].split(",").length === 4 ? Number(m[1].split(",")[3]) : 1;
  expect(alpha, `the guest loading overlay is opaque (bg=${bg})`).toBe(1);

  await expect(guest.locator("[data-pane=preview] .cm-content")).toContainText("guest published body", { timeout: 15000 });
  await expect(ph, "the overlay clears on resolve").toHaveCount(0);
});

test("#457a guest page with no published body says empty — never an eternal skeleton", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  const id = await openScratch(member, `skeleton457-guest-empty-${Date.now()}`); // never published
  const linkId = await shareLink(member, { type: "page", id });

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`/share/${linkId}`);
  await expect(guest.getByTestId("page-empty"), "resolved-and-blank states it in words").toBeVisible({ timeout: 10000 });
  await expect(guest.getByTestId("body-placeholder")).toHaveAttribute("data-state", "empty");
  await expect(guest.getByTestId("prose-skeleton"), "empty is NOT the loading state").toHaveCount(0);
});

test("#457the GUEST sidebar shows a tree skeleton while the tree loads — never the empty wording", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const linkId = await shareLink(member, { type: "space", id: "demo_space" });

  const guest = await (await browser.newContext()).newPage();
  await guest.route("**/spaces/*/pages", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await guest.goto(`/share/${linkId}`);

  await expect(guest.getByTestId("guest-sidebar-skeleton"), "the tree announces it is loading").toBeVisible({ timeout: 10000 });
  await expect(guest.getByTestId("guest-sidebar-empty"), "loading must not read as 'no pages'").toHaveCount(0);
  // …and the real tree replaces it
  await expect(guest.getByTestId("guest-sidebar-skeleton")).toHaveCount(0, { timeout: 15000 });
  await expect(guest.locator("[data-testid=guest-sidebar] [data-page-id]").first()).toBeVisible();
});

test("#457the right panels (comments / history / attachments) skeleton while their lists load", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const id = await openScratch(page, `skeleton457-panels-${Date.now()}`);

  // ALL delays go in before the surface loads: the comment threads are prefetched at page mount (the
  // count badge shares the panel's query), so a delay installed later would find the cache already
  // warm and the panel would never show its loading state.
  const delay = (ms: number) => async (route: import("@playwright/test").Route) => {
    if (route.request().method() !== "GET") return route.continue();
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  };
  await page.route("**/pages/*/comments*", delay(6000));
  await page.route("**/pages/*/revisions", delay(2500));
  await page.route("**/spaces/*/pages/*/attachments", delay(2500));

  await page.goto(`/p/${id}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");

  // comments: open PROMPTLY (the shared prefetch is in flight for ~6s) — the panel joins it and skeletons
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=comments-toggle]");
  await expect(page.getByTestId("comments-skeleton"), "comments: rows skeleton while loading").toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("comments-skeleton")).toHaveCount(0, { timeout: 15000 });
  await page.keyboard.press("Escape");

  // history / attachments: their queries fire on panel mount, so the delay window opens per-panel
  for (const p of [
    { toggle: "history-toggle", skeleton: "history-skeleton" },
    { toggle: "attachments-toggle", skeleton: "attachments-skeleton" },
  ]) {
    await page.click("[data-testid=page-overflow-trigger]");
    await page.click(`[data-testid=${p.toggle}]`);
    await expect(page.getByTestId(p.skeleton), `${p.toggle}: rows skeleton while loading`).toBeVisible({ timeout: 5000 });
    // …and it resolves (a fresh page has no entries) — never a stuck skeleton
    await expect(page.getByTestId(p.skeleton)).toHaveCount(0, { timeout: 15000 });
    await page.keyboard.press("Escape");
  }
});

test("#457the search result list skeletons while a slow query runs", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  await page.route("**/search*", async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("search-input")).toBeVisible();
  await page.getByTestId("search-input").fill(`no-such-term-${Date.now()}`);
  await expect(page.getByTestId("search-list-skeleton"), "the list announces it is searching").toBeVisible({ timeout: 8000 });
  // …and resolves to the real 'no results' wording (loading and empty stay distinct truths)
  await expect(page.getByTestId("search-list-skeleton")).toHaveCount(0, { timeout: 15000 });
});

// The PUBLIC reader (ShellLoading, #364wired it; this pins it — nothing pinned it before, so a
// regression to the old blank div would go unseen). Same make-public idiom as public-page.spec.ts.
test("#457the public reader skeletons while the page resolves", async ({ browser }) => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const repoEnv = readFileSync(fileURLToPath(new URL("../../../.env.e2e.local", import.meta.url)), "utf8");
  const STORE = /OPENFGA_STORE_ID=(.+)/.exec(repoEnv)![1]!.trim();
  const MODEL = /OPENFGA_MODEL_ID=(.+)/.exec(repoEnv)![1]!.trim();

  const authed = await (await browser.newContext()).newPage();
  const id = await openScratch(authed, `skeleton457-pub-${Date.now()}`);
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  await authed.keyboard.insertText("# Public heading\n\npublic skeleton body\n");
  await sleep(500);
  await publishAndWait(authed, id, "public skeleton body");
  const fga = await fetch(`${FGA}/stores/${STORE}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ writes: { tuple_keys: [{ user: "user:*", relation: "view_base", object: `page:${id}` }] }, authorization_model_id: MODEL }),
  });
  expect(fga.ok, "make-public FGA write").toBe(true);
  const { setPublicSurface } = await import("../helpers");
  await setPublicSurface(authed, true);

  const anon = await (await browser.newContext()).newPage();
  await anon.route("**/public/pages/**", async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await anon.goto(`/pub/${id}`);
  await expect(anon.getByTestId("shell-loading"), "the public reader is not a blank div while resolving").toBeVisible({ timeout: 8000 });
  await expect(anon.getByTestId("prose-skeleton")).toBeVisible();
  await expect(anon.locator("body")).toContainText("public skeleton body", { timeout: 15000 });
  await expect(anon.getByTestId("shell-loading"), "the skeleton clears on resolve").toHaveCount(0);
});
