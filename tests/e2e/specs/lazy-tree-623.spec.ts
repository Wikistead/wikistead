import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #623 / ADR-220 §6.3 (rulings ①②): the sidebar tree fetches branch by branch.
//
// Stubbed at the network (the #537 pattern): what is under test is the SCREEN's half of the contract
// which requests it makes, when, and what it draws from the answers. The server's half (what a branch
// may contain, what a placeholder may leak) is pinned in `tree-placeholders-623` and
// `branch-paged-623` on the server suite, against the real store.
//
// Ruling ①(c) is pinned as the ticket asked: not "a chevron is drawn" but "an unexpanded row CAN BE
// EXPANDED" — the failure §12 named is a lazy tree whose unloaded rows have no children and so can
// never open. A row with an invisible-only subtree still opens (and shows nothing), which is exactly
// the lie (c) accepts: "there may be children", never "something denied exists".

const P = (id: string, title: string, parentId: string | null = null, hasChildren = false) => ({
  id, tenantId: "t", spaceId: "demo_space", parentId, title, position: 0,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  published: true, hasUnpublishedChanges: false, taskDone: 0, taskTotal: 0, hasChildren,
});

async function openLazySpace(page: Page, opts: { branchDelayMs?: number } = {}) {
  const requested: string[] = [];
  await page.route((u) => u.pathname.match(/\/api\/spaces\/demo_space\/pages\/paint$/) !== null, (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        branches: [{
          parentId: null,
          pages: [P("p-top", "Top page", null, true), P("p-plain", "Plain leaf")],
          nextCursor: null,
          placeholders: [
            { token: "tok-1", under: null, parentToken: null, pages: [P("p-granted", "Granted child", null)] },
          ],
        }],
      }),
    }));
  await page.route((u) => u.pathname.match(/\/api\/spaces\/demo_space\/pages\/branch$/) !== null, async (route) => {
    const url = new URL(route.request().url());
    const parent = url.searchParams.get("parent") ?? "root";
    requested.push(parent);
    if (opts.branchDelayMs) await sleep(opts.branchDelayMs);
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(
        parent === "p-top"
          ? { pages: [P("p-child", "A fetched child", "p-top")], nextCursor: null }
          // the ROOT branch answers what the paint answered — a refetch of a painted branch must not
          // silently shrink it (the first draft returned [] here and hid a real hook defect behind a
          // fixture defect: the tree emptied and the spec could not say which side was wrong)
          : parent === "root"
            ? { pages: [P("p-top", "Top page", null, true), P("p-plain", "Plain leaf")], nextCursor: null,
                placeholders: [{ token: "tok-1", under: null, parentToken: null, pages: [P("p-granted", "Granted child", null)] }] }
            : { pages: [], nextCursor: null },
      ),
    });
  });
  // demo_space is the ACTIVE space openDemo lands in — the stub replaces its tree reads only, and
  // every other route falls through to the real server.
  await openDemo(page);
  await expect(page.getByTestId("page-tree")).toBeVisible({ timeout: 20_000 });
  await sleep(400);
  return { requested };
}

test("#623 ①: a row with a visible child expands; a leaf draws no chevron at all", async ({ page }) => {
  test.setTimeout(120_000);
  const { requested } = await openLazySpace(page);

  // The paint answered the ROOT alone. Nothing has asked for p-top's branch yet.
  expect(requested.filter((r) => r === "p-top"), "a branch was fetched before its row was opened").toHaveLength(0);

  // ①: the chevron follows the server's hasChildren. The leaf must NOT be expandable — the
  // retracted ruling drew a chevron on every row, and the rejection called showing ">" on a row
  // with no child pages awful UI. A chevron in arborist exists only when a row has children,
  // so the leaf's svg count is the measurable difference.
  const leaf = page.locator('[data-testid="tree-page"]', { hasText: "Plain leaf" }).first();
  await expect(leaf).toBeVisible();
  await expect(leaf.locator("[data-testid=tree-expand-toggle] svg"), "the childless row still draws an expander").toHaveCount(0);

  // The row WITH a visible child is expandable although nothing about its children is loaded.
  const row = page.locator('[data-testid="tree-page"]', { hasText: "Top page" }).first();
  await expect(row).toBeVisible();
  await expect(row.locator("[data-testid=tree-expand-toggle] svg"), "the parent row lost its chevron").toHaveCount(1);
  await row.locator(".rotate-0, [class*=chevron], svg").first().click().catch(() => row.dblclick());
  await expect
    .poll(() => requested.filter((r) => r === "p-top").length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  // …and the fetched child renders under it.
  await expect(page.locator('[data-testid="tree-page"]', { hasText: "A fetched child" }))
    .toBeVisible({ timeout: 10_000 });
});

test("#623 ② (§4.2): a placeholder renders, opens from data in hand, and asks the server NOTHING", async ({ page }) => {
  test.setTimeout(120_000);
  const { requested } = await openLazySpace(page);

  const ph = page.getByTestId("tree-placeholder").first();
  await expect(ph, "the granted page was handed over and never arrived").toBeVisible();
  // One fixed, unnamed label (§4.1: a label that varied with the cause would report the cause).
  await expect(ph).toContainText(/表示できないページ|can.t view/i);

  const before = requested.length;
  await page.getByTestId("tree-placeholder-chevron").first().click();
  await expect(page.locator('[data-testid="tree-page"]', { hasText: "Granted child" }))
    .toBeVisible({ timeout: 10_000 });
  await sleep(600);
  // §4.2's load-bearing clause: expanding a placeholder issues no request — its identifier reaches no
  // route. A branch request here would be the client naming an invisible parent.
  expect(requested.length, "expanding the placeholder asked the server something").toBe(before);

  // …and the placeholder is not a page: clicking its row must not navigate.
  const url = page.url();
  await ph.click();
  await sleep(400);
  expect(page.url(), "clicking a placeholder navigated somewhere").toBe(url);
});
