import { test, expect, request as pwRequest } from "@playwright/test";
import { API } from "../helpers";

// #1168 / ADR-220 §17 (rev16, owner-ruled 2026-09-06): the sidebar's `paint` query used to be keyed on
// the OPEN page, so every navigation looked like a request react-query had never seen and `paintTree`
// re-walked every ancestor's branch from scratch — a `listBranch` call, per-row view check included,
// per ancestor, on every single page open, even ones already fresh in the client's own cache. The fix
// drops the open page from `paint`'s key/request and promotes the existing ADR-238 reach effect
// (already `pathToPage`-backed and view-checked) to reveal ancestors on every navigation instead of
// only past a branch's first window.
//
// The owner's approval named the failure mode this MUST distinguish from success: the ancestor path
// could arrive DELAYED (acceptable — one extra round trip on a cold deep link) or go MISSING entirely
// (not acceptable) — and from the tree alone, both look identical ("the row is not there"). So two
// pins, each with its own break-check, because either alone passes on a build that fails the other's
// concern (owner's ruling, #1168): re-fetching every time still passes the first pin alone, and never
// delivering the ancestor path still passes the second pin alone.

async function makeSpace(name: string) {
  const api = await pwRequest.newContext({ baseURL: API, extraHTTPHeaders: { Authorization: "Bearer dev-token", Host: "dev.localhost" } });
  const created = await api.post(`/spaces`, { data: { name: `${name}-${Date.now()}` } });
  expect(created.ok(), `space create: ${created.status()}`).toBe(true);
  return ((await created.json()) as { id: string }).id;
}
async function makePage(spaceId: string, title: string, parentId?: string) {
  const api = await pwRequest.newContext({ baseURL: API, extraHTTPHeaders: { Authorization: "Bearer dev-token", Host: "dev.localhost" } });
  const r = await api.post(`/spaces/${spaceId}/pages`, { data: { title, ...(parentId ? { parentId } : {}) } });
  expect(r.ok(), `page ${title}: ${r.status()} ${await r.text()}`).toBe(true);
  return ((await r.json()) as { id: string }).id;
}

test("#1168: the tree body is not re-fetched when navigating to a different page in the same space", async ({ browser }) => {
  test.setTimeout(180_000);
  const spaceId = await makeSpace("tree-stable-1168");
  const first = await makePage(spaceId, "Nav First 1168");
  const second = await makePage(spaceId, "Nav Second 1168");

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const paintCalls: string[] = [];
  page.on("request", (r) => { if (/\/pages\/paint\?/.test(r.url())) paintCalls.push(r.url()); });
  await page.addInitScript((v) => { try { localStorage.setItem("wks.activeSpace", v) } catch { /* private mode */ } }, spaceId);

  await page.goto(`/p/${first}`);
  await expect(page.getByTestId("tree-page").filter({ hasText: "Nav First 1168" })).toBeVisible({ timeout: 20_000 });
  expect(paintCalls.length, `paint calls after the cold load: ${paintCalls.length}`).toBe(1);

  // SPA-internal navigation (clicking a row), not page.goto — a real browser navigation would reload
  // the whole app and trivially reset every cache, measuring nothing about the query key.
  const secondRow = page.getByTestId("tree-page").filter({ hasText: "Nav Second 1168" });
  await secondRow.click();
  if (!new RegExp(second).test(page.url())) {
    // #1072/#939/#1132 family (this repo's own, unrelated to this ticket): the first click after a
    // navigation is reproducibly swallowed in this codebase in more than one place; a second always
    // lands. Not this ticket's concern to re-diagnose here — bounded, and logged either way so a future
    // run says which of the two happened rather than silently retrying forever.
    await secondRow.click();
  }
  await expect(page, "the click navigated").toHaveURL(new RegExp(second), { timeout: 10_000 });
  await expect(page.locator('[data-testid=tree-page][data-selected] [data-testid=tree-page-name]'))
    .toHaveText("Nav Second 1168", { timeout: 20_000 });

  expect(paintCalls.length, `paint calls after navigating within the space: ${JSON.stringify(paintCalls)}`).toBe(1);
});

test("#1168: a page whose ancestor chain is not yet expanded still reaches its row (delayed, not missing)", async ({ browser }) => {
  test.setTimeout(180_000);
  const spaceId = await makeSpace("tree-delayed-not-missing-1168");
  const folder = await makePage(spaceId, "Folder 1168");
  const kid = await makePage(spaceId, "Kid 1168", folder);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript((v) => { try { localStorage.setItem("wks.activeSpace", v) } catch { /* private mode */ } }, spaceId);

  // Cold: the folder has never been expanded by anything, so `paint` (root-only now) does not seed it —
  // the reach effect is the only thing that can put the kid's row on screen.
  await page.goto(`/p/${kid}`);
  const row = page.locator("[data-testid=sidebar] [data-testid=tree-page][data-selected]");
  await expect.poll(async () => await row.count(), { timeout: 20_000, message: "the row never appeared — delayed became missing" })
    .toBeGreaterThan(0);
  await expect(row.getByTestId("tree-page-name")).toHaveText("Kid 1168");
});
