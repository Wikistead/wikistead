import { test, expect, request as pwRequest } from "@playwright/test";
import { API } from "../helpers";

// #541: the sidebar's first paint. The body reached the screen in ~0.8s while the sidebar sat empty for
// 7 — and three earlier tickets (#489/#500/#492) each went Done without a pin on the TIME itself, which
// is how the symptom outlived all of them. So this spec creates a big space and holds the clock.
//
// (review reject) reshaped this spec twice over
// - the FIXTURE was 197 bare pages, while dev carries private pages, share links and grants — the very
// tuples that make the badge reads and confirms cost something. The fixture now publishes most
// pages, makes a band of them private, hangs share links on some and adds a space grant, so the
// authz paths the 7 seconds actually lived in are exercised. (Frozen pages are NOT seeded: freezing
// goes through the moderation queue and has no direct API; noted rather than silently skipped.)
// - one cold run hid the BIMODAL failure: the slow mode was the PREVIOUS page-open's abandoned
// title-dictionary fan-out still flooding the checker (measured timelines on dev: the same tree
// request takes 1.0s uncontended, 4.8s under a neighbour's dictionary). So the clock now runs
// BACK-TO-BACK cold contexts — the contamination shape — and judges the WORST run, not the best.
//
// Thresholds: on an idle machine a run measures ~1.2s wall. The absolute bound carries margin because
// three sibling sessions run builds on this box (load spikes turn any wall-clock into noise); the
// RELATIVE bound is the regression this ticket is actually about — the sidebar arriving an order of
// magnitude after the body means it is queued behind something again, whatever the machine is doing.
const PAGES = 197;
const RUNS = 3;
const SIDEBAR_WALL_MS = 3500;
const SIDEBAR_LAG_MS = 2000;

test("#541: a realistic 197-page space's sidebar arrives with the body — on every back-to-back cold open", async ({ browser }) => {
  test.setTimeout(420_000);

  // Build the big space once, through the API (the UI is not the thing under test here).
  const api = await pwRequest.newContext({ baseURL: API, extraHTTPHeaders: { Authorization: "Bearer dev-token", Host: "dev.localhost" } });
  const created = await api.post(`/spaces`, { data: { name: `sidebar-541-${Date.now()}` } });
  expect(created.ok()).toBe(true);
  const spaceId = ((await created.json()) as { id: string }).id;
  const pageIds: string[] = [];
  for (let i = 0; i < PAGES; i++) {
    const r = await api.post(`/spaces/${spaceId}/pages`, { data: { title: `Page ${String(i).padStart(3, "0")}` } });
    expect(r.ok()).toBe(true);
    pageIds.push(((await r.json()) as { id: string }).id);
  }
  // The tuples that make authz cost something on dev: published bulk, a private band (lock badges +
  // cascade markers), share links (share_link tuples in the same store), one space grant.
  for (let i = 0; i < PAGES; i += 2) await api.post(`/pages/${pageIds[i]}/publish`);
  for (let i = 1; i < 60; i += 2) await api.post(`/pages/${pageIds[i]}/private`);
  for (let i = 0; i < 10; i++) {
    await api.post(`/share-links`, { data: { resource: { type: "page", id: pageIds[i * 2] }, capability: "view" } });
  }
  await api.post(`/spaces/${spaceId}/access`, { data: { grantee: "user:sidebar-541-extra", relation: "view" } }).catch(() => undefined);

  const firstPageId = pageIds[0];
  const results: { run: number; cmAt: number; sidebarAt: number }[] = [];
  for (let run = 1; run <= RUNS; run++) {
    // A COLD context (empty cache, empty storage) except the one thing a returning visitor has: the
    // stored active space. Runs are DELIBERATELY back-to-back — the previous run's context closes and
    // its in-flight dictionary must not starve this one (the slow mode).
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript((sid) => { try { localStorage.setItem("wks.activeSpace", sid) } catch { /* private mode */ } }, spaceId);

    const t0 = Date.now();
    await page.goto(`/p/${firstPageId}`);
    let sidebarAt = -1;
    let cmAt = -1;
    for (let k = 0; k < 600; k++) {
      if (cmAt < 0 && (await page.$(".cm-content"))) cmAt = Date.now() - t0;
      if (sidebarAt < 0) {
        const len = await page.evaluate(() => document.querySelector("[data-testid=sidebar]")?.textContent?.length ?? 0);
        if (len > 200) sidebarAt = Date.now() - t0;
      }
      if (sidebarAt >= 0 && cmAt >= 0) break;
      await page.waitForTimeout(50);
    }
    expect(sidebarAt, `run ${run}: the sidebar content appeared at all`).toBeGreaterThan(0);
    expect(cmAt, `run ${run}: the body appeared at all`).toBeGreaterThan(0);
    results.push({ run, cmAt, sidebarAt });
    await ctx.close();
  }

  // Judged on the WORST run ( — the best run proved nothing last time).
  const detail = results.map((r) => `run${r.run}: body=${r.cmAt}ms sidebar=${r.sidebarAt}ms lag=${r.sidebarAt - r.cmAt}ms`).join(" | ");
  for (const r of results) {
    expect(r.sidebarAt, `worst-run wall clock — ${detail}`).toBeLessThan(SIDEBAR_WALL_MS);
    expect(r.sidebarAt - r.cmAt, `worst-run lag — ${detail}`).toBeLessThan(SIDEBAR_LAG_MS);
  }

  // Cleanup: the space (and its pages) go away so repeated runs do not accrete.
  await api.delete(`/spaces/${spaceId}`).catch(() => undefined);
});
