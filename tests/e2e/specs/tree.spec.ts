import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep } from "../helpers";
import { LOCKED_SPACE_NAME } from "../fixtures";

const API = "http://dev.localhost:4010";

const apiCreate = (page: Page, title: string, parentId: string | null) =>
  page.evaluate(
    async ({ api, title, parentId }) => {
      const r = await fetch(`${api}/spaces/demo_space/pages`, {
        method: "POST",
        headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
        body: JSON.stringify({ title, parentId }),
      });
      return (await r.json()).id as string;
    },
    { api: API, title, parentId },
  );

test("page tree (react-arborist): FGA-filtered, keyboard, route-selection, nesting", async ({ page }) => {
  await openDemo(page);

  // (1) **SECURITY** re-verified on react-arborist: Demo Space (FGA-allowed) is
  // shown; the locked space (RLS-visible, no FGA grant) is NOT — the tree only
  // renders the FGA-filtered listing.
  const sidebar = () => page.$eval("[data-testid=sidebar]", (el) => el.innerText);
  expect(await sidebar()).toContain("Demo Space");
  expect(await sidebar()).not.toContain(LOCKED_SPACE_NAME);

  // expand the space -> the demo page row renders
  await page.getByText("Demo Space", { exact: true }).click();
  await sleep(300);
  expect(await page.locator("[data-testid=tree-page]").count()).toBeGreaterThan(0);

  // (2) route-linked selection: on /p/demo the demo page row is marked selected
  expect(await page.locator("[data-testid=tree-page][data-selected]").count()).toBe(1);

  // (3) keyboard nav (react-arborist uses roving DOM focus on treeitem rows):
  // focus the tree, ArrowDown moves focus row to row.
  await page.locator('[data-testid=sidebar] [role="tree"]').focus();
  await page.keyboard.press("ArrowDown");
  await sleep(150);
  const active1 = await page.evaluate(() => ({ role: document.activeElement?.getAttribute("role"), text: document.activeElement?.textContent?.slice(0, 20) }));
  await page.keyboard.press("ArrowDown");
  await sleep(150);
  const active2 = await page.evaluate(() => document.activeElement?.textContent?.slice(0, 20));
  expect(active1.role).toBe("treeitem");
  expect(active2).not.toBe(active1.text);

  // (4) create a space via the header button
  await page.getByRole("button", { name: "New space" }).click();
  await sleep(800);
  expect(await sidebar()).toContain("Untitled space");

  // (5) nesting display: create a child under the demo page, reload, confirm it
  // renders nested (parent gets an expander; child appears under it)
  await apiCreate(page, "Child-Page", "demo");
  await page.reload();
  await page.waitForSelector("[data-testid=sidebar]");
  await sleep(600);
  await page.getByText("Demo Space", { exact: true }).click(); // expand space
  await sleep(200);
  // expand the demo page's own expander (its first span is the chevron indicator)
  await page.locator("[data-testid=tree-page]", { hasText: "Demo Page" }).first().locator("span").first().click();
  await sleep(300);
  expect(await sidebar()).toContain("Child-Page");
});

test("moving the open page via drag keeps the editor connected", async ({ page }) => {
  await openDemo(page);
  // a sibling top-level page to nest demo under
  await apiCreate(page, "Folder-Page", null);
  await page.reload();
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.getByText("Demo Space", { exact: true }).click();
  await sleep(400);

  const rendersBefore = await page.evaluate(() => (window as any).__editorRenders ?? 0);

  // drag the demo page row onto Folder-Page (nest). react-arborist + react-dnd.
  const src = page.locator("[data-testid=tree-page]", { hasText: "Demo Page" }).first();
  const dst = page.locator("[data-testid=tree-page]", { hasText: "Folder-Page" }).first();
  await src.dragTo(dst);
  await sleep(800);

  // the editor for the open page (docName uses pageId, not space/parent) is NOT
  // rebuilt by the move -> render count unchanged, URL unchanged, editor present.
  const rendersAfter = await page.evaluate(() => (window as any).__editorRenders ?? 0);
  expect(page.url()).toMatch(/\/p\/demo$/);
  expect(await page.locator("[data-pane=preview] .cm-content").count()).toBe(1);
  expect(rendersAfter).toBe(rendersBefore);
});

test("dragging a page onto another space moves it across spaces (3b ②)", async ({ page }) => {
  await openDemo(page);
  const moverId = await apiCreate(page, "X-Move-Me", null);

  // make a second space and learn its id
  await page.getByRole("button", { name: "New space" }).click();
  await sleep(800);
  const newSpaceId = await page.evaluate(async (api) => {
    const spaces = await (await fetch(`${api}/spaces`, { headers: { Authorization: "Bearer dev-token" } })).json();
    return spaces.find((s: { name: string }) => s.name === "Untitled space").id as string;
  }, API);

  await page.reload();
  await page.waitForSelector("[data-testid=sidebar]");
  await sleep(500);
  await page.getByText("Demo Space", { exact: true }).click(); // reveal X-Move-Me
  await sleep(300);

  // drop the page onto the new space row -> cross-space move (top level of that space)
  const src = page.locator("[data-testid=tree-page]", { hasText: "X-Move-Me" }).first();
  const dst = page.locator("[data-testid=tree-space]", { hasText: "Untitled space" }).first();
  await src.dragTo(dst);
  await sleep(1000);

  // BE: the page's space changed; it left demo_space's listing for the new space.
  const movedSpace = await page.evaluate(
    async ({ api, id }) => (await (await fetch(`${api}/pages/${id}`, { headers: { Authorization: "Bearer dev-token" } })).json()).spaceId,
    { api: API, id: moverId },
  );
  expect(movedSpace).toBe(newSpaceId);
  const demoPageIds = await page.evaluate(
    async (api) => (await (await fetch(`${api}/spaces/demo_space/pages`, { headers: { Authorization: "Bearer dev-token" } })).json()).map((p: { id: string }) => p.id),
    API,
  );
  expect(demoPageIds).not.toContain(moverId);
});
