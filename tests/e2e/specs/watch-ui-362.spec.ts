import { test, expect } from "@playwright/test";
import { openScratch, sleep, API } from "../helpers";

// #362 / ADR-126 addendum S2: the watch-management UI. The bell is the watch entry point (list surface
// + mark-all-read); /watches lists with server-resolved titles, mute and unwatch; the account settings
// gain a notifications tab. Server authz (view-gated writes, double-gated reads) is pinned in
// notifications-362.test.ts — this exercises the real UI.
// #467 (owner ruling, ADR-126 addendum): the ⋯ menu now carries ONE watch item, not three scopes
// the scope-item pins below moved to the new watch-single-467 spec.

test("#362: the page watch in the ⋯ menu; the bell reaches the watch list; mute + unwatch work", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const title = `watch-ui-${Date.now()}`;
  await openScratch(page, title); // creates + navigates to a real page (view mode)

  // ── ⋯ menu: the single watch item ───────────────────────────────────────────
  await page.getByTestId("page-overflow-trigger").click();
  await expect(page.getByTestId("watch-toggle")).toBeVisible();
  await page.getByTestId("watch-toggle").click(); // watch the page
  await sleep(400);

  // ── bell → watching list ────────────────────────────────────────────────────
  await page.getByTestId("notification-bell").click();
  await expect(page.getByTestId("notification-watching")).toBeVisible();
  await expect(page.getByTestId("notification-read-all")).toBeVisible(); // present (disabled at 0 unread is fine)
  await page.getByTestId("notification-watching").click();
  await expect(page).toHaveURL(/\/watches$/);
  const row = page.locator("[data-testid=watch-row]", { hasText: title }).first();
  await expect(row, "the watched page appears with its resolved title").toBeVisible();

  // ── mask editor opens; mute toggles; unwatch removes the row ────────────────
  await row.getByTestId("watch-mask-toggle").click();
  await expect(page.getByTestId("watch-mask-editor")).toBeVisible();
  await expect(page.getByTestId("watch-mask-page.published")).toBeChecked(); // empty mask = all types on
  await row.getByTestId("watch-mute-toggle").click();
  await expect(row.getByTestId("watch-mute-toggle")).toHaveAttribute("aria-pressed", "true", { timeout: 5000 });
  await row.getByTestId("watch-unwatch").click();
  await expect(page.locator("[data-testid=watch-row]", { hasText: title })).toHaveCount(0, { timeout: 5000 });
});

// #467: the menu no longer CREATES subtree/space watches, but the server still speaks those scopes
// and a member who already has one must not be stranded — it stays listed, labelled and removable.
// So the watches are created through the API (what an older client did) and managed through the UI.
test("#362 (as amended by #467): pre-existing subtree + space watches stay listed and manageable", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const title = `watch-scope-${Date.now()}`;
  const pageId = await openScratch(page, title);
  const spaceId = await page.evaluate(async ({ id, api }) => {
    const r = await fetch(`${api}/pages/${id}`, { headers: { Authorization: "Bearer dev-token" } });
    return (await r.json()).spaceId as string;
  }, { id: pageId, api: API });
  await page.evaluate(async ({ pageId, spaceId, api }) => {
    const post = (body: unknown) =>
      fetch(`${api}/watches`, {
        method: "POST",
        headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await post({ resourceType: "subtree", resourceId: pageId });
    await post({ resourceType: "space", resourceId: spaceId });
  }, { pageId, spaceId, api: API });

  await page.goto("/watches");
  const sub = page.locator("[data-testid=watch-row]", { hasText: title }).first();
  await expect(sub, "the subtree watch resolves the anchor page's title").toBeVisible();
  await expect(sub).toContainText(/Page \+ subpages|ページ＋配下/);
  const rows = page.locator("[data-testid=watch-row]");
  await expect(rows.filter({ hasText: /Space|スペース/ }).first(), "the space watch is listed").toBeVisible();
  // and they can still be removed from here (no stranded rows)
  for (let i = 0; i < 6; i++) {
    const target = rows.filter({ hasText: new RegExp(`${title}|Space|スペース`) }).first();
    if ((await target.count()) === 0) break;
    await target.getByTestId("watch-unwatch").click();
    await sleep(300);
  }
  await expect(rows.filter({ hasText: title })).toHaveCount(0);
});

test("#362: the account notifications tab persists the kill switch + default mask", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/settings/account/notifications");
  await expect(page.getByTestId("notifications-enabled")).toBeVisible();
  await expect(page.getByTestId("notifications-enabled")).toBeChecked(); // permissive default

  // uncheck one default-mask type → persists across reload; then restore.
  await page.getByTestId("default-mask-comment.created").click();
  await sleep(500);
  await page.reload();
  await expect(page.getByTestId("default-mask-comment.created")).not.toBeChecked();
  await expect(page.getByTestId("default-mask-page.published")).toBeChecked(); // others stay on
  await page.getByTestId("default-mask-comment.created").click(); // restore all-on ([] mask)
  await sleep(500);
  await page.reload();
  await expect(page.getByTestId("default-mask-comment.created")).toBeChecked();
});
