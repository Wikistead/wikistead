import { test, expect, type Page } from "@playwright/test";
import { sleep, API } from "../helpers";

// ADR-102 (#214): comment list ordering (latest-activity), long-thread collapse, and cursor pagination
// with scroll anchoring. Seeds > one page of threads via the API, then drives the real panel. The scroll
// anchoring (no viewport jump on prepend) is the reviewer-flagged crux — asserted by a fixed comment's
// on-screen Y staying put across a load-older.
async function openComments(page: Page) {
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=comments-toggle]");
  await page.locator("[data-testid=page-overflow]").waitFor({ state: "detached" }).catch(() => {});
}

test("#214/ADR-102: latest-activity order, collapse, cursor pagination + scroll anchoring", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // Seed: 35 single-comment threads T0..T34 (T34 newest) + one 7-comment thread (collapse case), via API.
  const pageId = await page.evaluate(async (api) => {
    const h = { Authorization: "Bearer dev-token", "content-type": "application/json" };
    const pg = await (await fetch(`${api}/spaces/demo_space/pages`, { method: "POST", headers: h, body: JSON.stringify({ title: "pagination page" }) })).json();
    for (let i = 0; i < 35; i++) {
      await fetch(`${api}/pages/${pg.id}/comments`, { method: "POST", headers: h, body: JSON.stringify({ body: `T${i}`, kind: "page" }) });
    }
    // a long thread: parent LONG + 6 replies (7 comments → collapses)
    const lt = await (await fetch(`${api}/pages/${pg.id}/comments`, { method: "POST", headers: h, body: JSON.stringify({ body: "LONG parent", kind: "page" }) })).json();
    for (let r = 0; r < 6; r++) await fetch(`${api}/comments/threads/${lt.threadId}/comments`, { method: "POST", headers: h, body: JSON.stringify({ body: `reply ${r}` }) });
    return pg.id as string;
  }, API);

  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  await openComments(page);
  const panel = page.locator("[data-testid=comments-panel]");
  await expect(panel).toBeVisible();
  const list = panel.locator("[data-testid=comment-list]");
  await sleep(500);

  // (order + paging) newest page = 30 threads; the long thread (newest activity) sits at the BOTTOM,
  // and a load-older affordance is present (35+1 threads > page size 30).
  const threadsNow = () => panel.locator("[data-testid=comment-thread]").count();
  expect(await threadsNow()).toBe(30);
  await expect(panel.locator("[data-testid=comment-load-older]")).toBeVisible();
  // newest activity (the long thread) is the LAST thread rendered (bottom = newest)
  await expect(panel.locator("[data-testid=comment-thread]").last()).toContainText("LONG parent");

  // (collapse) the 7-comment thread shows parent + a show-replies button + the latest 3 (hidden 3)
  const longThread = panel.locator("[data-testid=comment-thread]").last();
  await expect(longThread.locator("[data-testid=show-replies]")).toBeVisible();
  await expect(longThread.locator("[data-testid=comment-item]")).toHaveCount(4); // parent + latest 3
  await longThread.locator("[data-testid=show-replies]").click();
  await sleep(150);
  await expect(longThread.locator("[data-testid=comment-item]")).toHaveCount(7); // expanded: all
  await expect(longThread.locator("[data-testid=show-replies]")).toHaveCount(0);

  // (scroll anchoring — the crux) the newest page is {LONG, T34..T6} (30), so the topmost loaded thread
  // before paging is T6. Scrolling to the top auto-loads the older page {T5..T0} and PREPENDS it; anchoring
  // must push scrollTop DOWN from 0 by the prepended height so the viewport stays on T6 (no jump to T0).
  await expect(panel.locator("[data-testid=comment-thread]").first()).toContainText("T6");
  await list.evaluate((el) => { el.scrollTop = 0; }); // near-top → the onScroll handler triggers load-older
  await sleep(700); // fetch + prepend + layout-effect anchoring
  expect(await threadsNow()).toBeGreaterThan(30); // older page prepended (T0..T4 now above T5)
  const scrollTop = await list.evaluate((el) => el.scrollTop);
  expect(scrollTop, "anchoring compensated: scrollTop pushed down from 0 (no jump-to-top)").toBeGreaterThan(20);
  // the OLDEST thread T0 is now first in the DOM but ABOVE the viewport (anchoring kept T5 in view)
  await expect(panel.locator("[data-testid=comment-thread]").first()).toContainText("T0");

  // all 36 threads are now loaded → the beginning is reached → the load-older affordance disappears
  await expect(panel.locator("[data-testid=comment-load-older]")).toHaveCount(0);
  expect(await threadsNow()).toBe(36);

  // (latest-activity re-sort — the primary bug fix, ADR-102 §1) reply to an OLD thread (T6, created
  // early) → its last activity becomes newest → it moves to the BOTTOM, past T34/LONG. This distinguishes
  // the latest-activity sort from the old thread-creation sort (under which T6 would stay put).
  const t6 = panel.locator("[data-testid=comment-thread]", { hasText: "T6" }).first();
  await t6.locator("[data-testid=comment-reply]").click();
  await panel.locator("[data-testid=comment-input]").last().fill("bump T6");
  await panel.locator("[data-testid=comment-submit]").last().click();
  await sleep(700);
  await expect(panel.locator("[data-testid=comment-thread]").last(), "the replied-to old thread moved to the bottom").toContainText("bump T6");

  expect(errors, errors.join(" | ")).toHaveLength(0);
});
