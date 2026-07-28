import { test, expect, request as pwRequest } from "@playwright/test";
import { API } from "../helpers";

// #541: the sidebar's first paint. The body reached the screen in ~0.8s while the sidebar sat empty for
// 7 — and three earlier tickets (#489/#500/#492) each went Done without a pin on the TIME itself, which
// is how the symptom outlived all of them. So this spec creates a big space and holds the clock.
//
// What the 7 seconds actually were, measured on dev (the fix follows each piece):
//   - the tree query was SERIALISED behind /spaces — `current` refused the stored space id until the
//     list confirmed it existed, so the tree could not even start until the slowest response of the
//     page-open burst landed (Sidebar.tsx now trusts the stored id while the list loads);
//   - the title dictionary — the most expensive authorization fan-out a page load fires, and an
//     enhancement — went out in the same burst and hogged the checker (it now yields for 1.5s);
//   - the tree endpoint itself fired ~600 concurrent point reads (3 per page for badges) and ran its
//     view confirm in sequential waves (now: one bounded read per page, confirm at 4 lanes).
//
// Thresholds: on an idle machine this measures ~1.2s wall. The absolute bound carries margin because
// three sibling sessions run builds on this box (load spikes turn any wall-clock into noise); the
// RELATIVE bound is the regression this ticket is actually about — the sidebar arriving an order of
// magnitude after the body means it is queued behind something again, whatever the machine is doing.
const PAGES = 197;
const SIDEBAR_WALL_MS = 3500;
const SIDEBAR_LAG_MS = 2000;

test("#541: a 197-page space's sidebar arrives with the body, not seconds after it", async ({ browser }) => {
  test.setTimeout(300_000);

  // Build the big space once, through the API (the UI is not the thing under test here).
  const api = await pwRequest.newContext({ baseURL: API, extraHTTPHeaders: { Authorization: "Bearer dev-token", Host: "dev.localhost" } });
  const created = await api.post(`/spaces`, { data: { name: `sidebar-541-${Date.now()}` } });
  expect(created.ok()).toBe(true);
  const spaceId = ((await created.json()) as { id: string }).id;
  let firstPageId = "";
  for (let i = 0; i < PAGES; i++) {
    const r = await api.post(`/spaces/${spaceId}/pages`, { data: { title: `Page ${String(i).padStart(3, "0")}` } });
    expect(r.ok()).toBe(true);
    if (i === 0) firstPageId = ((await r.json()) as { id: string }).id;
  }

  // A COLD context (empty cache, empty storage) except the one thing a returning visitor has: the
  // stored active space. That is the everyday case the user keeps hitting.
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

  expect(sidebarAt, "the sidebar content appeared at all").toBeGreaterThan(0);
  expect(cmAt, "the body appeared at all").toBeGreaterThan(0);
  expect(sidebarAt, `sidebar-content=${sidebarAt}ms (body=${cmAt}ms)`).toBeLessThan(SIDEBAR_WALL_MS);
  expect(sidebarAt - cmAt, `sidebar lagged the body by ${sidebarAt - cmAt}ms`).toBeLessThan(SIDEBAR_LAG_MS);

  // Cleanup: the space (and its pages) go away so repeated runs do not accrete.
  await api.delete(`/spaces/${spaceId}`).catch(() => undefined);
  await ctx.close();
});
