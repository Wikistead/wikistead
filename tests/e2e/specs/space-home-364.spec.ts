import { test, expect } from "@playwright/test";
import { sleep } from "../helpers";

// #364 / ADR-157: the space HOMEPAGE — member flows in real Chromium.
// - /spaces/:id renders the EMPTY STATE (space-name heading + the write button for edit-capable)
// until a home exists; the button creates-and-points atomically and lands in the editor.
// - the home renders AT the space root with the full page machinery; the sidebar tree EXCLUDES it
// (double-display rule) while the fixed 🏠 Home entry navigates back to it.
// - /p/<home-id> canonicalises to /spaces/:id (one location).
// - switching spaces lands on the space root (§6a).

async function newSpacePage(page: any, name: string): Promise<string> {
  const res = await page.evaluate(async (n: string) => {
    const r = await fetch("/api/spaces", { method: "POST", headers: { authorization: "Bearer dev-token", "content-type": "application/json" }, body: JSON.stringify({ name: n }) });
    return (await r.json()) as { id: string };
  }, name);
  return res.id;
}

test("#364: empty state → write button → home renders at the space root; tree excludes it; redirect canonicalises", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const spaceId = await newSpacePage(page, `home364-${Date.now().toString(36)}`);

  // 1) empty state: heading + the write button (dev-token is edit-capable)
  await page.goto(`/spaces/${spaceId}`);
  await expect(page.getByTestId("space-home-empty")).toBeVisible({ timeout: 8000 });
  const btn = page.getByTestId("space-home-create");
  await expect(btn, "edit-capable viewer sees the write button").toBeVisible();

  // 2) create → lands in the editor on the space root, rendering the new home draft
  await btn.click();
  await sleep(1500);
  await expect(page.getByTestId("space-home-empty")).toHaveCount(0);
  await expect(page.locator("[data-pane=preview] .cm-content").first()).toBeVisible({ timeout: 8000 });

  // the pointer is set — grab the home id for the later steps
  const homeId = await page.evaluate(async (sid: string) => {
    const r = await fetch("/api/spaces", { headers: { authorization: "Bearer dev-token" } });
    const spaces = (await r.json()) as { id: string; homePageId?: string | null }[];
    return spaces.find((s) => s.id === sid)?.homePageId ?? null;
  }, spaceId);
  expect(homeId, "spaces list carries the pointer for the creator").toBeTruthy();

  // 3) the sidebar shows the fixed Home entry; the tree does NOT list the home page
  await expect(page.getByTestId("sidebar-home")).toBeVisible();
  const treeIds = await page.evaluate(async (sid: string) => {
    const r = await fetch(`/api/spaces/${sid}/pages`, { headers: { authorization: "Bearer dev-token" } });
    return ((await r.json()) as { id: string }[]).map((p) => p.id);
  }, spaceId);
  expect(treeIds, "the tree route excludes the home").not.toContain(homeId);

  // 3.5) the home's title is DERIVED (space name + locale suffix) and shows NO rename
  // affordance — clicking the title never opens the rename textarea
  const titleEl = page.getByTestId("page-title");
  await expect(titleEl).toBeVisible({ timeout: 8000 });
  const titleTxt = (await titleEl.innerText()).trim();
  expect(titleTxt, "derived from the space name").toContain("home364");
  expect(titleTxt, "carries the locale suffix").toMatch(/ Home$|のホーム$/);
  await titleEl.click();
  await sleep(300);
  await expect(page.getByTestId("page-title-input"), "no rename affordance on the home").toHaveCount(0);

  // 4) /p/<home-id> canonicalises to the space root
  await page.goto(`/p/${homeId}`);
  await page.waitForURL(`**/spaces/${spaceId}`, { timeout: 8000 });

  // 5) second create is refused (409) — the button is gone anyway; assert the API contract
  const second = await page.evaluate(async (sid: string) => {
    const r = await fetch(`/api/spaces/${sid}/home`, { method: "POST", headers: { authorization: "Bearer dev-token" } });
    return r.status;
  }, spaceId);
  expect(second).toBe(409);
});

test("#364 §6a: switching spaces lands on the space root", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const spaceId = await newSpacePage(page, `home364-sw-${Date.now().toString(36)}`);
  await page.reload({ waitUntil: "networkidle" });
  await sleep(800);
  // open the switcher and pick the new space
  await page.getByTestId("space-switcher").click();
  await sleep(400);
  await page.getByText(`home364-sw-`, { exact: false }).first().click();
  await page.waitForURL(`**/spaces/${spaceId}`, { timeout: 8000 });
  await expect(page.getByTestId("space-home-empty"), "the space root (empty state) is the landing").toBeVisible();
});
