import { test, expect, request as pwRequest } from "@playwright/test";
import { API, sleep } from "../helpers";

// #736: loading the tree's NEXT PAGE used to yank the reader back to the open page.
//
// The scroll-to-selection effect (#274(3)) depended on `nodes`, and §1's paging appends into the
// same cache entry — so every `more:` fetch handed the effect a new array and it scrolled to the
// selection again. The open page is usually near the top, so the sidebar appeared to jump home every
// time the reader scrolled far enough to load more. This spec holds BOTH halves: paging must not move
// the viewport, and #274's "the page you just created is visible" must still happen.
//
// Real DOM on purpose: happy-dom has no layout engine, so a virtualised tree mounts no rows there and
// a scroll position cannot be read at all. The fixture is deliberately LARGER than PAINT_LIMIT (30) —
// with fewer pages there is no `more:` row, and both tests below would pass without exercising a thing.
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

test("#736: loading the next page of the tree leaves the reader where they were", async ({ browser }) => {
  test.setTimeout(180_000);
  const { spaceId, pageIds } = await makeSpace("tree-scroll-736");

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript((v) => { try { localStorage.setItem("wks.activeSpace", v) } catch { /* private mode */ } }, spaceId);
  // The OPEN page is the first row — the shape the report describes ("it jumps back to the top").
  await page.goto(`/p/${pageIds[0]}`);
  await page.waitForSelector("[data-testid=sidebar] [data-testid=tree-page]");
  await sleep(1200);

  // The tree is VIRTUALISED, so the number of RENDERED rows says nothing about how many the branch
  // holds — it grows as you scroll whether or not anything was fetched (measured: 20 -> 22 rows while
  // still on the first page, which made an earlier version of this spec pass against the defect).
  // The honest paging signal is the scroller's own height: the next page adds ~30 rows to it.
  const scroller = `(() => {
    const row = document.querySelector("[data-testid=sidebar] [data-testid=tree-page]");
    for (let el = row?.parentElement ?? null; el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 4) return el;
    }
    return null;
  })()`;
  const scrollTop = () => page.evaluate(`(${scroller})?.scrollTop ?? -1`) as Promise<number>;
  const scrollHeight = () => page.evaluate(`(${scroller})?.scrollHeight ?? -1`) as Promise<number>;

  const height0 = await scrollHeight();
  expect(height0, "the sidebar tree is scrollable at all (fixture sanity)").toBeGreaterThan(0);

  // Scroll to the bottom of what is loaded: that is where the `more:` row lives, and mounting it is
  // what asks for the next page (#623 §1 — being rendered IS being scrolled to, in a virtual list).
  let lowest = 0;
  let paged = false;
  for (let i = 0; i < 40 && !paged; i++) {
    await page.evaluate(`(${scroller})?.scrollBy(0, 300)`);
    await sleep(300);
    lowest = Math.max(lowest, await scrollTop());
    paged = (await scrollHeight()) > height0 + 100;
  }
  expect(paged, "the `more:` row loaded the next page within the scroll budget").toBe(true);
  expect(lowest, "the reader got somewhere below the top before paging happened").toBeGreaterThan(100);

  // The paging settles asynchronously (fetch -> cache write -> re-render), so the position is read
  // after it has landed: the pre-fix effect fired on that very re-render.
  await sleep(1500);
  const after = await scrollTop();
  expect(
    after,
    `paging must not move the viewport — was at ${lowest}px when the next page landed, ${after}px after`,
  ).toBeGreaterThan(lowest - 40);

  await ctx.close();
});

test("#736: a page you create is still scrolled into view (#274(3) survives)", async ({ browser }) => {
  test.setTimeout(180_000);
  // #274's scenario is a tree that FITS IN ONE BRANCH PAGE — that ticket predates paging entirely
  // (#623 §1 came later). A created page lands at the end of the branch, so in a 60-page space its row
  // is on a page nobody has fetched and no version of this code can scroll to a row that is not there.
  // Measured, both ways round: before this fix the tree reached it anyway, but only as a SIDE EFFECT of
  // the defect — each scroll-back re-rendered the `more:` row, which fetched the next page, which
  // re-rendered again, cascading until all 61 rows happened to be loaded. That is not a behaviour to
  // preserve; it is the bug doing the work. This test therefore holds #274's real guarantee on #274's
  // real shape, and the paged case is reported on the ticket rather than silently pinned either way.
  const { spaceId, pageIds } = await makeSpace("tree-create-736", 24);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript((v) => { try { localStorage.setItem("wks.activeSpace", v) } catch { /* private mode */ } }, spaceId);
  await page.goto(`/p/${pageIds[0]}`);
  await page.waitForSelector("[data-testid=sidebar] [data-testid=tree-page]");
  await sleep(1200);

  // Create through the UI, which is #274's flow: the app navigates to the new page, and its row only
  // exists after the tree refetch — so the scroll has to wait for the row to appear.
  await page.getByTestId("new-page").click();
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(2500);

  const selected = page.locator("[data-testid=sidebar] [data-testid=tree-page][data-selected]");
  await expect(selected, "the created page's row is in the tree").toHaveCount(1);
  const visible = await selected.first().evaluate((el) => {
    const scroller = (() => {
      for (let e = el.parentElement; e; e = e.parentElement) if (e.scrollHeight > e.clientHeight + 4) return e;
      return null;
    })();
    const r = el.getBoundingClientRect();
    const box = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
  });
  expect(visible, "the created page's row was scrolled into view").toBe(true);

  await ctx.close();
});
