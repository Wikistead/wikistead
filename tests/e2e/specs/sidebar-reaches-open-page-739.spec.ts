import { test, expect, request as pwRequest } from "@playwright/test";
import { API, sleep } from "../helpers";

// #739 / ADR-238: a link you were sent arrives with its row highlighted and in view.
//
// `paintTree` fetches the branch of every ancestor, but each comes back as its FIRST window, so a page
// past row 30 of its branch is not in the tree at all when the reader lands on it. Before #736 this
// appeared to work by accident: the scroll effect fired on every `nodes` change, each scroll
// re-rendered the `more:` row, which fetched another page — the tree paged itself to the bottom as a
// side effect of the defect. Removing the defect removed the accident.
//
// Real DOM on purpose: happy-dom has no layout engine, so a virtualised tree mounts no rows there and
// no scroll position can be read. The fixture is deliberately LARGER than PAINT_LIMIT (30), because
// with fewer pages every row is in the first window and this spec would pass against anything.
const PAGES = 60;

async function makeSpace(name: string, pages = PAGES) {
  const api = await pwRequest.newContext({ baseURL: API, extraHTTPHeaders: { Authorization: "Bearer dev-token", Host: "dev.localhost" } });
  const created = await api.post(`/spaces`, { data: { name: `${name}-${Date.now()}` } });
  expect(created.ok(), `space create: ${created.status()}`).toBe(true);
  const spaceId = ((await created.json()) as { id: string }).id;
  const pageIds: string[] = [];
  for (let i = 0; i < pages; i++) {
    const r = await api.post(`/spaces/${spaceId}/pages`, { data: { title: `Page ${String(i).padStart(3, "0")}` } });
    expect(r.ok(), `page ${i}: ${r.status()} ${await r.text()}`).toBe(true);
    pageIds.push(((await r.json()) as { id: string }).id);
  }
  return { spaceId, pageIds };
}

/** The scrollable element react-arborist virtualises inside — found by measurement, not by class name. */
const SCROLLER = `(() => {
  const row = document.querySelector("[data-testid=sidebar] [data-testid=tree-page]");
  for (let el = row?.parentElement ?? null; el; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 4) return el;
  }
  return null;
})()`;

test("#739: opening a link to a page past the first window shows its row, in view", async ({ browser }) => {
  test.setTimeout(240_000);
  const { spaceId, pageIds } = await makeSpace("sidebar-reach-739");
  const deep = pageIds[PAGES - 1]!; // rank 59 of 60 — window 1, never in the paint

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // Count what the sidebar asks for. ADR-238 §4: a test that only checks the row is visible would pass
  // on the unbounded client loop this design exists to refuse, so the REQUESTS are asserted too.
  const branchCalls: string[] = [];
  const pathCalls: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/pages/branch")) branchCalls.push(u);
    if (/\/pages\/[^/]+\/path/.test(u)) pathCalls.push(u);
  });
  await page.addInitScript((v) => { try { localStorage.setItem("wks.activeSpace", v) } catch { /* private mode */ } }, spaceId);
  await page.goto(`/p/${deep}`);
  await page.waitForSelector("[data-testid=sidebar] [data-testid=tree-page]");

  const row = page.locator(`[data-testid=sidebar] [data-testid=tree-page][data-selected]`);
  await expect.poll(async () => await row.count(), { timeout: 20_000, message: "the open page's row never appeared in the sidebar" })
    .toBeGreaterThan(0);

  // In view, not merely mounted: react-arborist only mounts rows near the viewport, but "near" is not
  // "inside" — the row can exist a few hundred pixels below the box.
  const inside = await page.evaluate(`(() => {
    const el = document.querySelector("[data-testid=sidebar] [data-testid=tree-page][data-selected]");
    const box = ${SCROLLER};
    if (!el || !box) return null;
    const a = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
  })()`);
  expect(inside, "the row is in the scroller's box, not just mounted below it").toBe(true);

  // The bound. One path request, and one branch request per level — never a walk down the branch.
  expect(pathCalls.length, `path requests: ${pathCalls.length}`).toBeLessThanOrEqual(1);
  expect(branchCalls.length, `branch requests: ${branchCalls.length} — a loop over \`more:\` would be far more`)
    .toBeLessThanOrEqual(4);
});

test("#739: a page nested under a row that is itself past the first window is reached", async ({ browser }) => {
  test.setTimeout(300_000);
  // The flat case above only exercises the ROOT branch. This one needs two levels positioned: the
  // parent is row 39 of the root branch (window 1) and the target is row 39 of the parent's branch
  // (window 1 again), so an implementation that positioned only the last level would leave the parent
  // unrendered and the target with nowhere to hang.
  const api = await pwRequest.newContext({ baseURL: API, extraHTTPHeaders: { Authorization: "Bearer dev-token", Host: "dev.localhost" } });
  const created = await api.post(`/spaces`, { data: { name: `sidebar-reach-deep-739-${Date.now()}` } });
  expect(created.ok(), `space create: ${created.status()}`).toBe(true);
  const spaceId = ((await created.json()) as { id: string }).id;
  const roots: string[] = [];
  for (let i = 0; i < 40; i++) {
    const r = await api.post(`/spaces/${spaceId}/pages`, { data: { title: `Root ${String(i).padStart(3, "0")}` } });
    expect(r.ok(), `root ${i}: ${r.status()}`).toBe(true);
    roots.push(((await r.json()) as { id: string }).id);
  }
  const parent = roots[39]!;
  const kids: string[] = [];
  for (let i = 0; i < 40; i++) {
    const r = await api.post(`/spaces/${spaceId}/pages`, { data: { title: `Kid ${String(i).padStart(3, "0")}`, parentId: parent } });
    expect(r.ok(), `kid ${i}: ${r.status()}`).toBe(true);
    kids.push(((await r.json()) as { id: string }).id);
  }
  const deep = kids[39]!;

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const branchCalls: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/pages/branch")) branchCalls.push(r.url()); });
  await page.addInitScript((v) => { try { localStorage.setItem("wks.activeSpace", v) } catch { /* private mode */ } }, spaceId);
  await page.goto(`/p/${deep}`);
  await page.waitForSelector("[data-testid=sidebar] [data-testid=tree-page]");

  const row = page.locator(`[data-testid=sidebar] [data-testid=tree-page][data-selected]`);
  await expect.poll(async () => await row.count(), { timeout: 20_000, message: "the nested open page's row never appeared" })
    .toBeGreaterThan(0);
  const inside = await page.evaluate(`(() => {
    const el = document.querySelector("[data-testid=sidebar] [data-testid=tree-page][data-selected]");
    const box = ${SCROLLER};
    if (!el || !box) return null;
    const a = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
  })()`);
  expect(inside, "the nested row is in the scroller's box").toBe(true);
  // Two levels, so at most two positioned fetches on top of the paint's own — still per level, never
  // a walk. A loop over `more:` would need ~2 per level for this fixture and grows with the branch.
  expect(branchCalls.length, `branch requests: ${branchCalls.length}`).toBeLessThanOrEqual(6);
});
