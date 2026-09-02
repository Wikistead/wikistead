import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { openDemo, openScratch, createScratchPage, pageList, sleep } from "../helpers";
import { LOCKED_SPACE_NAME, E2E } from "../fixtures";

// Phase 1 nav: the sidebar shows ONE active space's page tree (chosen in the
// switcher), not spaces-as-roots. Nesting is created via the sub-page button (the
// affordance that was missing); DnD reparent/reorder within the active space still
// works. (Cross-space DnD has no single-space UI now — the backend /move across
// spaces stays covered by the server spaces-pages tests.)
//
// #1027: most tests here used to open `/p/demo` (the seeded page) and expect ITS OWN row to
// appear as `[data-testid=tree-page]`. #940 made "demo" demo_space's HOME page, and #364
// deliberately excludes a space's home from the tree — so that row never renders, and every
// test built on top of it timed out waiting for a selector nothing was ever going to satisfy.
// Fixed the same way #969 fixed share.spec.ts: open a page the test creates and owns instead.
//
// Every `fetch` a test runs FROM THE PAGE now goes through the same-origin `/api` proxy
// (`space-home-364.spec.ts`'s pattern), not the raw server origin — a browser-context fetch to
// a different port is a cross-origin request CORS refuses since #989 tightened it.
const pagesOf = async (page: Page, space: string) =>
  pageList<{ id: string; parentId: string | null }>(
    await page.evaluate(
      async (space) => (await (await fetch(`/api/spaces/${space}/pages`, { headers: { Authorization: "Bearer dev-token" } })).json()) as unknown,
      space,
    ),
  );

test("sidebar: active space follows the open page; switcher is FGA-filtered; route selection", async ({ page }) => {
  await openScratch(page, `tree-active-${Date.now().toString(36)}`); // opens a page IN demo_space, making it active
  await page.waitForSelector("[data-testid=tree-page]");
  expect(await page.textContent("[data-testid=space-switcher]")).toContain("Demo Space");

  // route-linked selection: the open page's own row is marked selected
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
  const parentTitle = `tree-nest-${Date.now().toString(36)}`;
  const parentId = await openScratch(page, parentTitle);
  await page.waitForSelector("[data-testid=tree-page]");
  const before = (await pagesOf(page, "demo_space")).filter((p) => p.parentId === parentId).length;

  const parentRow = page.locator("[data-testid=tree-page]", { hasText: parentTitle }).first();
  await parentRow.hover();
  // #969 (same defect share.spec.ts's createLink works around): on a row for the page just navigated
  // to (freshly selected), the FIRST click on `page-actions` reproducibly leaves `aria-expanded="false"`
  // — the SECOND click always opens it. Bounded retry rather than a fixed second click.
  const trigger = parentRow.locator("[data-testid=page-actions]");
  const menu = page.locator("[data-testid=page-menu][data-state=open]");
  for (let attempt = 1; ; attempt++) {
    await trigger.click();
    try {
      await menu.waitFor({ timeout: 1000 });
      break;
    } catch {
      if (attempt >= 5) throw new Error("page-actions menu never opened after 5 clicks");
    }
  }
  await menu.getByTestId("add-subpage").click();
  await sleep(800);

  // a NESTED page (parent = the page this test opened) was created from the UI — the missing affordance.
  const children = (await pagesOf(page, "demo_space")).filter((p) => p.parentId === parentId);
  expect(children.length).toBe(before + 1);
});

test("rename a space via the switcher menu (manage)", async ({ page }) => {
  await openDemo(page);
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
  // #1062: `__editorRenders` (every render of the Editor component's function body) climbs on its
  // own — measured with the drag itself REMOVED (just opening the page and waiting 800ms) and the
  // same +6 still happened, so a render-count-exact assertion was never actually testing the drag.
  // Diagnosed: `window.__editorViewRemounts` (Editor.tsx, incremented only when the surface-mount
  // effect that constructs/destroys the CodeMirror EditorView actually re-runs — added for this
  // ticket) stayed flat across the same drag+800ms window where renders climbed by 6, so the
  // periodic re-renders are memo/effect-dependency churn that never reaches CodeMirror — benign.
  // Break-checked: injecting a churning dependency into that effect's array reddened this exact
  // assertion (6 → 9) in the same run, so it does catch a real remount. Two pages this test owns —
  // the one it opens, and a sibling to drop it onto — so the drag
  // has a subject regardless of what else demo_space holds (no more "if the tree is too small,
  // make one more": the open page used to be /p/demo, which #364 excludes from the tree, so
  // `[data-testid=tree-page][data-selected]` could never match it at all).
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const openId = await createScratchPage(page, `tree-drag-open-${Date.now().toString(36)}`);
  await createScratchPage(page, `tree-drag-sibling-${Date.now().toString(36)}`);
  await page.goto(`/p/${openId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.waitForSelector("[data-testid=tree-page]");
  // The sibling was created over a side-channel fetch, not through this navigation — reload so the
  // tree's live view of it (and any renders that arrival triggers) settles BEFORE the render count
  // below is captured, or that settling races the drag and reads as the drag having caused a rebuild.
  await page.reload();
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.waitForSelector("[data-testid=tree-page]");

  // Drag the OPEN page (selected, always rendered at the top) onto the sibling (also at the
  // top) — both are inside the virtualized window regardless of how many pages the space has,
  // so this is robust to tree size. The move reparents the open page but its editor (docName =
  // pageId) must NOT rebuild.
  const src = page.locator("[data-testid=tree-page][data-selected]").first();
  const dst = page.locator("[data-testid=tree-page]:not([data-selected])").first();
  await src.waitFor({ state: "visible", timeout: 15000 });
  await dst.waitFor({ state: "visible", timeout: 15000 });

  const remountsBefore = await page.evaluate(() => (window as any).__editorViewRemounts ?? 0);
  await src.dragTo(dst, { force: true }); // force: skip mid-drag stability wait (drop indicator re-renders)
  await sleep(800);

  // the open page's editor (docName uses pageId) is NOT rebuilt by the move — measured as the
  // CodeMirror view surviving, not as the component's render count (which churns on its own; #1062).
  const remountsAfter = await page.evaluate(() => (window as any).__editorViewRemounts ?? 0);
  expect(page.url()).toMatch(new RegExp(`/p/${openId}$`));
  expect(await page.locator("[data-pane=preview] .cm-content").count()).toBe(1);
  expect(remountsAfter).toBe(remountsBefore);
});

test("the page-actions … trigger stays laid out when unhovered (menu positioning regression)", async ({ page }) => {
  await openScratch(page, `tree-actions-${Date.now().toString(36)}`);
  await page.waitForSelector("[data-testid=tree-page]");
  // Do NOT hover. The "…" is visually hidden (opacity) but must keep its layout box,
  // else Ark measures a zero rect once focus leaves the row and flings the menu to
  // 0,0 (top-left). display:none would make width 0 here.
  const w = await page.locator("[data-testid=page-actions]").first().evaluate((el) => el.getBoundingClientRect().width);
  expect(w).toBeGreaterThan(0);
});

test("the sidebar has no horizontal scrollbar (overflow regression)", async ({ page }) => {
  await openScratch(page, `tree-scroll-${Date.now().toString(36)}`);
  await page.waitForSelector("[data-testid=tree-page]");
  // the aside must not overflow horizontally (border-box + the tree's width chain).
  const ok = await page.locator("aside").first().evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(ok).toBe(true);
});

// #364 / ADR-157 changed where "/" lands, and this spec kept the pre-#364 answer for two weeks: it
// waited for /p/demo while the product went to the space root, and read as "the brand is broken".
// HomeLanding (routes.tsx) has two branches and they are measured separately here — the space root
// when the first space has no home, and the home page when it does. Pinning only the first would let
// the second break in silence, which is how the stale expectation survived.
test("the brand lockup links home — the space root, when the first space has no home", async ({ page }) => {
  await openDemo(page);
  // navigate off the home page first
  await page.getByTestId("new-page").click();
  await page.waitForURL(/\/p\/.+edit=1/);
  // clicking the brand returns to the landing, which resolves to the first space's root
  await page.getByTestId("brand-home").click();
  await page.waitForURL(/\/spaces\/demo_space$/);

  // the SETTINGS shell has no sidebar but is still member chrome → brand still links home
  await page.goto("/spaces/demo_space/settings/general");
  await page.waitForSelector("[data-testid=space-general]");
  await page.getByTestId("brand-home").click();
  await page.waitForURL(/\/spaces\/demo_space$/);
});

test("the brand lockup links home — the home page, when the first space has one", async ({ page }) => {
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  // #890 / #1027: demo_space's home is "demo" — the shared page every other spec in the suite reads
  // (infra/db/seed.ts sets home_page_id='demo' on seed, since #940). This test used to TRASH-then-PURGE
  // whatever the current home was, expecting to start from "no home" — but the #989 CORS bug had
  // silently swallowed every fetch here (TypeError: Failed to fetch) for who knows how long, so that
  // destructive path had never actually run. Once the CORS call was fixed to go through the same-origin
  // `/api` proxy, it ran for real and PERMANENTLY DELETED "demo" — caught by the #890 fixture-integrity
  // guard, not by this test. Swap the pointer with a direct SQL UPDATE instead of deleting anything:
  // demo_space keeps its real home page intact for the whole test, just pointed at a scratch page.
  const homeId = await createScratchPage(page, `tree-home-${Date.now().toString(36)}`);
  const sql = postgres(E2E.pgAdmin);
  try {
    await sql`UPDATE spaces SET home_page_id = ${homeId} WHERE id = 'demo_space'`;
    await page.goto("/settings/account"); // a shell without a sidebar, so the brand is the only way back
    await page.waitForSelector("header");
    await page.getByTestId("brand-home").click();
    await page.waitForURL(new RegExp(`/p/${homeId}$`));
  } finally {
    // Leave demo_space exactly as it was — every other spec in the suite reads this same space.
    await sql`UPDATE spaces SET home_page_id = 'demo' WHERE id = 'demo_space'`;
    await sql.end();
  }
});

// #219: a native tooltip on a sidebar page item ONLY when its title is truncated (VSCode/Finder tree
// behaviour) — checked at hover via scrollWidth > clientWidth so it follows a sidebar resize.
test("#219: truncated sidebar page titles get a hover tooltip; fully-visible ones do not", async ({ page }) => {
  await openDemo(page);
  const long = "A very very long page title that will certainly be truncated in the narrow sidebar column here indeed";
  await page.evaluate(async (long) => {
    for (const title of ["short", long]) {
      await fetch(`/api/spaces/demo_space/pages`, { method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" }, body: JSON.stringify({ title }) });
    }
  }, long);
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
