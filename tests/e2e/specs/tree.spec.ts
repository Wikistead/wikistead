import { test, expect, type Page } from "@playwright/test";
import { openDemo, pageList, sleep, API } from "../helpers";
import { LOCKED_SPACE_NAME } from "../fixtures";

// Phase 1 nav: the sidebar shows ONE active space's page tree (chosen in the
// switcher), not spaces-as-roots. Nesting is created via the sub-page button (the
// affordance that was missing); DnD reparent/reorder within the active space still
// works. (Cross-space DnD has no single-space UI now — the backend /move across
// spaces stays covered by the server spaces-pages tests.)
const pagesOf = async (page: Page, space: string) =>
  pageList<{ id: string; parentId: string | null }>(
    await page.evaluate(
      async ({ api, space }) => (await (await fetch(`${api}/spaces/${space}/pages`, { headers: { Authorization: "Bearer dev-token" } })).json()) as unknown,
      { api: API, space },
    ),
  );

test("sidebar: active space follows the open page; switcher is FGA-filtered; route selection", async ({ page }) => {
  await openDemo(page); // opening /p/demo makes demo_space active
  await page.waitForSelector("[data-testid=tree-page]");
  expect(await page.textContent("[data-testid=space-switcher]")).toContain("Demo Space");

  // route-linked selection: the demo page row is marked selected on /p/demo
  expect(await page.locator("[data-testid=tree-page][data-selected]").count()).toBe(1);

  // **SECURITY**: the locked space (RLS-visible, no FGA grant) is NOT offered in
  // the switcher — useSpaces is FGA-filtered server-side; nav redesign keeps it.
  await page.click("[data-testid=space-switcher]");
  await page.waitForSelector("[data-testid=space-menu]");
  const menu = await page.$eval("[data-testid=space-menu]", (el) => el.innerText);
  expect(menu).toContain("Demo Space");
  expect(menu).not.toContain(LOCKED_SPACE_NAME);
  await page.keyboard.press("Escape");
});

test("① nesting: the sub-page button creates a child under the page", async ({ page }) => {
  await openDemo(page);
  await page.waitForSelector("[data-testid=tree-page]");
  const before = (await pagesOf(page, "demo_space")).filter((p) => p.parentId === "demo").length;

  const demoRow = page.locator("[data-testid=tree-page]", { hasText: "Demo Page" }).first();
  await demoRow.hover();
  await demoRow.locator("[data-testid=page-actions]").click(); // open the "…" menu
  await page.locator("[data-testid=page-menu][data-state=open]").getByTestId("add-subpage").click();
  await sleep(800);

  // a NESTED page (parent = demo) was created from the UI — the missing affordance.
  const children = (await pagesOf(page, "demo_space")).filter((p) => p.parentId === "demo");
  expect(children.length).toBe(before + 1);
});

test("rename a space via the switcher menu (manage)", async ({ page }) => {
  await openDemo(page);
  await page.waitForSelector("[data-testid=tree-page]");
  // create a fresh space so we don't rename demo_space (other specs depend on it)
  await page.click("[data-testid=space-switcher]");
  await page.locator("[data-testid=space-menu]").getByText("New space").click();
  // New space now prompts for a name.
  const create = page.locator("[data-testid=rename-dialog][data-state=open]");
  await create.waitFor();
  await create.locator("input").fill("E2E Space");
  await create.locator("button[type=submit]").click();
  await sleep(800);
  // the new space is now active → rename it
  await page.click("[data-testid=space-switcher]");
  await page.locator("[data-testid=space-menu]").getByText("Rename space").click();
  // page + space rename reuse the same dialog testid; target the OPEN one.
  const dlg = page.locator("[data-testid=rename-dialog][data-state=open]");
  await dlg.waitFor();
  await dlg.locator("input").fill("Renamed Space E2E");
  await dlg.locator("button[type=submit]").click();
  await sleep(600);
  expect(await page.textContent("[data-testid=space-switcher]")).toContain("Renamed Space E2E");
});

test("new-page button creates a page in the active space", async ({ page }) => {
  await openDemo(page);
  await page.waitForSelector("[data-testid=new-page]");
  const before = (await pagesOf(page, "demo_space")).length;
  await page.click("[data-testid=new-page]");
  await sleep(800);
  expect((await pagesOf(page, "demo_space")).length).toBe(before + 1);
});

test("Phase 2d: the header toggle collapses the sidebar and the choice persists", async ({ page }) => {
  await openDemo(page);
  await page.waitForSelector("[data-testid=tree-page]");
  await expect(page.locator("[data-testid=sidebar]")).toBeVisible();

  // collapse via the header button → the aside is hidden
  await page.click("[data-testid=sidebar-toggle]");
  await expect(page.locator("[data-testid=sidebar]")).toBeHidden();

  // the choice survives a reload (persisted to localStorage)
  await page.reload();
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await expect(page.locator("[data-testid=sidebar]")).toBeHidden();

  // toggling again restores it
  await page.click("[data-testid=sidebar-toggle]");
  await expect(page.locator("[data-testid=sidebar]")).toBeVisible();
});

test("moving the open page via drag keeps the editor connected", async ({ page }) => {
  await openDemo(page);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.waitForSelector("[data-testid=tree-page]");
  // Need a sibling to drop onto. In an isolated run demo_space has only the open
  // page, so create one; in the full suite there are already several.
  if ((await page.locator("[data-testid=tree-page]").count()) < 2) {
    await page.evaluate(async (api) => {
      await fetch(`${api}/spaces/demo_space/pages`, { method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" }, body: JSON.stringify({ title: "Sibling-Page", parentId: null }) });
    }, API);
    await page.reload();
    await page.waitForSelector("[data-pane=preview] .cm-content");
  }
  // Drag the OPEN page (selected, always rendered at the top) onto the first sibling
  // (also at the top) — both are inside the virtualized window regardless of how many
  // pages the space has, so this is robust to tree size. The move reparents the open
  // page but its editor (docName = pageId) must NOT rebuild.
  const src = page.locator("[data-testid=tree-page][data-selected]").first();
  const dst = page.locator("[data-testid=tree-page]:not([data-selected])").first();
  await src.waitFor({ state: "visible", timeout: 15000 });
  await dst.waitFor({ state: "visible", timeout: 15000 });

  const rendersBefore = await page.evaluate(() => (window as any).__editorRenders ?? 0);
  await src.dragTo(dst, { force: true }); // force: skip mid-drag stability wait (drop indicator re-renders)
  await sleep(800);

  // the open page's editor (docName uses pageId) is NOT rebuilt by the move.
  const rendersAfter = await page.evaluate(() => (window as any).__editorRenders ?? 0);
  expect(page.url()).toMatch(/\/p\/demo$/);
  expect(await page.locator("[data-pane=preview] .cm-content").count()).toBe(1);
  expect(rendersAfter).toBe(rendersBefore);
});

test("the page-actions … trigger stays laid out when unhovered (menu positioning regression)", async ({ page }) => {
  await openDemo(page);
  await page.waitForSelector("[data-testid=tree-page]");
  // Do NOT hover. The "…" is visually hidden (opacity) but must keep its layout box,
  // else Ark measures a zero rect once focus leaves the row and flings the menu to
  // 0,0 (top-left). display:none would make width 0 here.
  const w = await page.locator("[data-testid=page-actions]").first().evaluate((el) => el.getBoundingClientRect().width);
  expect(w).toBeGreaterThan(0);
});

test("the sidebar has no horizontal scrollbar (overflow regression)", async ({ page }) => {
  await openDemo(page);
  await page.waitForSelector("[data-testid=tree-page]");
  // the aside must not overflow horizontally (border-box + the tree's width chain).
  const ok = await page.locator("aside").first().evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(ok).toBe(true);
});

test("the brand lockup links home (member chrome)", async ({ page }) => {
  await openDemo(page);
  // navigate off the home page first
  await page.getByTestId("new-page").click();
  await page.waitForURL(/\/p\/.+edit=1/);
  // clicking the brand returns to home (catch-all "/" → /p/demo)
  await page.getByTestId("brand-home").click();
  await page.waitForURL(/\/p\/demo$/);

  // the SETTINGS shell has no sidebar but is still member chrome → brand still links home
  await page.goto("/spaces/demo_space/settings/general");
  await page.waitForSelector("[data-testid=space-general]");
  await page.getByTestId("brand-home").click();
  await page.waitForURL(/\/p\/demo$/);
});

// #219: a native tooltip on a sidebar page item ONLY when its title is truncated (VSCode/Finder tree
// behaviour) — checked at hover via scrollWidth > clientWidth so it follows a sidebar resize.
test("#219: truncated sidebar page titles get a hover tooltip; fully-visible ones do not", async ({ page }) => {
  await openDemo(page);
  const long = "A very very long page title that will certainly be truncated in the narrow sidebar column here indeed";
  await page.evaluate(async ({ api, long }) => {
    for (const title of ["short", long]) {
      await fetch(`${api}/spaces/demo_space/pages`, { method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" }, body: JSON.stringify({ title }) });
    }
  }, { api: API, long });
  await page.reload();
  await page.waitForSelector("[data-testid=tree-page-name]");

  const longSpan = page.locator("[data-testid=tree-page-name]", { hasText: "A very very long" });
  const shortSpan = page.locator("[data-testid=tree-page-name]", { hasText: /^short$/ });
  // Measured by what APPEARS, not by an attribute. #630/#530 replaced the native `title` with one
  // tooltip host: the row carries `data-tip-if-truncated` whether or not the name is clipped, and the
  // host decides at hover time by measuring. So the attribute is present in BOTH cases and asserting it
  // would say a fully-visible title has a tooltip too — the distinction this test exists for.
  const tip = page.locator(".wks-tip");
  await longSpan.hover();
  await expect(tip, "a truncated title shows its full text as a tooltip").toHaveText(long, { timeout: 3000 });
  // …and gone for one that fits. HIDDEN, not absent: #630 keeps the panel mounted through its exit so
  // it fades rather than blinking off, so counting elements would fail on a tooltip nobody can see.
  await page.mouse.move(4, 4);
  await expect(tip).toBeHidden({ timeout: 3000 });
  await shortSpan.hover();
  await sleep(600);
  await expect(tip, "a fully-visible title gets no tooltip").toBeHidden();
});
